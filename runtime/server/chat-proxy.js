import path from "node:path";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  DefaultResourceLoader,
} from "@mariozechner/pi-coding-agent";

const DEBUG = true;

const log = (...args) => DEBUG && console.log(...args);
const write = (data) => DEBUG && process.stdout.write(data);

function getAssistantDiagnostics(message) {
  if (!message || message.role !== "assistant") {
    return null;
  }

  const stopReason = message.stopReason;
  const errorMessage =
    message.errorMessage ||
    (stopReason === "error" || stopReason === "aborted"
      ? `Request ${stopReason}`
      : "");

  const content = Array.isArray(message.content) ? message.content : [];
  const text = content
    .filter((item) => item?.type === "text")
    .map((item) => item.text || "")
    .join("")
    .trim();
  const toolCalls = content.filter((item) => item?.type === "toolCall").length;

  return {
    stopReason,
    errorMessage,
    hasText: text.length > 0,
    toolCalls,
  };
}

/**
 * Handle incoming WebSocket connection using pi-coding-agent
 * @param {import("ws").WebSocket} ws
 * @param {object} options
 * @param {string} options.apiKey - OpenAI API Key
 * @param {string} options.rootDir - Pack root directory
 */
export async function handleWsConnection(
  ws,
  { apiKey, rootDir, provider = "openai", modelId = "gpt-5.4" },
) {
  try {
    let turnHadVisibleOutput = false;

    // Create an in-memory auth storage to avoid touching disk
    const authStorage = AuthStorage.inMemory({
      [provider]: { type: "api_key", key: apiKey },
    });
    authStorage.setRuntimeApiKey(provider, apiKey);

    const modelRegistry = new ModelRegistry(authStorage);
    const model = modelRegistry.find(provider, modelId);

    const sessionManager = SessionManager.inMemory();

    const skillsPath = path.resolve(rootDir, "skills");
    log(`[ChatProxy] Loading additional skills from: ${skillsPath}`);

    const resourceLoader = new DefaultResourceLoader({
      cwd: rootDir,
      additionalSkillPaths: [skillsPath], // 手动加载 rootDir/skills
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: rootDir, // Allow pi-coding-agent to find skills in this pack's directory
      authStorage,
      modelRegistry,
      sessionManager,
      resourceLoader,
      model,
    });

    // Stream agent events to the WebSocket
    session.subscribe((event) => {
      switch (event.type) {
        case "agent_start":
          log("\n=== [PI-CODING-AGENT SESSION START] ===");
          log("System Prompt:\n", session.systemPrompt);
          log("========================================\n");
          ws.send(JSON.stringify({ type: "agent_start" }));
          break;

        case "message_start":
          log(`\n--- [Message Start: ${event.message?.role}] ---`);
          if (event.message?.role === "user") {
            log(JSON.stringify(event.message.content, null, 2));
          }
          ws.send(
            JSON.stringify({
              type: "message_start",
              role: event.message?.role,
            }),
          );
          break;

        case "message_update":
          if (event.assistantMessageEvent?.type === "text_delta") {
            turnHadVisibleOutput = true;
            write(event.assistantMessageEvent.delta);
            ws.send(
              JSON.stringify({
                type: "text_delta",
                delta: event.assistantMessageEvent.delta,
              }),
            );
          } else if (event.assistantMessageEvent?.type === "thinking_delta") {
            turnHadVisibleOutput = true;
            ws.send(
              JSON.stringify({
                type: "thinking_delta",
                delta: event.assistantMessageEvent.delta,
              }),
            );
          }
          break;

        case "message_end":
          log(`\n--- [Message End: ${event.message?.role}] ---`);
          if (event.message?.role === "assistant") {
            const diagnostics = getAssistantDiagnostics(event.message);
            if (diagnostics) {
              log(
                `[Assistant Diagnostics] stopReason=${diagnostics.stopReason || "unknown"} text=${diagnostics.hasText ? "yes" : "no"} toolCalls=${diagnostics.toolCalls}`,
              );
              if (diagnostics.errorMessage) {
                log(`[Assistant Error] ${diagnostics.errorMessage}`);
              }
            }
          }
          ws.send(
            JSON.stringify({
              type: "message_end",
              role: event.message?.role,
            }),
          );
          break;

        case "tool_execution_start":
          turnHadVisibleOutput = true;
          log(`\n>>> [Tool Execution Start: ${event.toolName}] >>>`);
          log("Args:", JSON.stringify(event.args, null, 2));
          ws.send(
            JSON.stringify({
              type: "tool_start",
              toolName: event.toolName,
              toolInput: event.args,
            }),
          );
          break;

        case "tool_execution_end":
          turnHadVisibleOutput = true;
          log(`<<< [Tool Execution End: ${event.toolName}] <<<`);
          log(`Error: ${event.isError ? "Yes" : "No"}`);
          ws.send(
            JSON.stringify({
              type: "tool_end",
              toolName: event.toolName,
              isError: event.isError,
              result: event.result,
            }),
          );
          break;

        case "agent_end":
          log("\n=== [PI-CODING-AGENT SESSION END] ===\n");
          ws.send(JSON.stringify({ type: "agent_end" }));
          break;
      }
    });

    // Listen for incoming messages from the frontend
    ws.on("message", async (data) => {
      try {
        const payload = JSON.parse(data.toString());
        if (payload.text) {
          turnHadVisibleOutput = false;

          // Send prompt to the agent, the session will handle message history natively
          await session.prompt(payload.text);

          const lastMessage = session.state.messages.at(-1);
          const diagnostics = getAssistantDiagnostics(lastMessage);
          if (diagnostics?.errorMessage) {
            ws.send(JSON.stringify({ error: diagnostics.errorMessage }));
            return;
          }

          if (
            diagnostics &&
            !diagnostics.hasText &&
            diagnostics.toolCalls === 0 &&
            !turnHadVisibleOutput
          ) {
            const emptyResponseError =
              "Assistant returned no visible output. Check the server logs for stopReason/provider details.";
            log(`[Assistant Warning] ${emptyResponseError}`);
            ws.send(JSON.stringify({ error: emptyResponseError }));
            return;
          }

          ws.send(JSON.stringify({ done: true }));
        }
      } catch (err) {
        ws.send(JSON.stringify({ error: String(err) }));
      }
    });

    ws.on("close", () => {
      session.dispose();
    });
  } catch (err) {
    ws.send(JSON.stringify({ error: String(err) }));
    ws.close();
  }
}
