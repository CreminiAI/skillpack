import path from "node:path";
import crypto from "node:crypto";
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

const sessions = new Map();

export function hasActiveWebSubscriber(sessionId) {
  const state = sessions.get(sessionId);
  return !!(state && state.subscribers && state.subscribers.size > 0);
}

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
    text,
  };
}

async function createSessionState({
  sessionId,
  apiKey,
  rootDir,
  provider,
  modelId,
}) {
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
    additionalSkillPaths: [skillsPath],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: rootDir,
    authStorage,
    modelRegistry,
    sessionManager,
    resourceLoader,
    model,
  });

  const state = {
    sessionId,
    session,
    subscribers: new Set(),
    wsConnections: new Set(),
    queue: Promise.resolve(),
  };

  session.subscribe((event) => {
    for (const subscriber of state.subscribers) {
      subscriber(event);
    }
  });

  sessions.set(sessionId, state);
  return state;
}

async function getOrCreateSessionState(options) {
  const existing = sessions.get(options.sessionId);
  if (existing) {
    return existing;
  }

  return createSessionState(options);
}

export function broadcastToSession(sessionId, data) {
  const state = sessions.get(sessionId);
  if (!state) return;
  const msg = JSON.stringify(data);
  for (const conn of state.wsConnections) {
    if (conn.readyState === 1) {
      conn.send(msg);
    }
  }
}

function subscribeSession(state, subscriber) {
  state.subscribers.add(subscriber);
  return () => {
    state.subscribers.delete(subscriber);
  };
}

function extractMessageText(message) {
  if (!message || !Array.isArray(message.content)) {
    return "";
  }

  return message.content
    .filter((item) => item?.type === "text")
    .map((item) => item.text || "")
    .join("")
    .trim();
}

export async function promptSession(
  { sessionId, apiKey, rootDir, provider = "openai", modelId = "gpt-5.4" },
  text,
  onEvent,
) {
  const state = await getOrCreateSessionState({
    sessionId,
    apiKey,
    rootDir,
    provider,
    modelId,
  });

  let turnHadVisibleOutput = false;
  const unsubscribe = subscribeSession(state, (event) => {
    if (
      event.type === "message_update" &&
      (event.assistantMessageEvent?.type === "text_delta" ||
        event.assistantMessageEvent?.type === "thinking_delta")
    ) {
      turnHadVisibleOutput = true;
    }

    if (
      event.type === "tool_execution_start" ||
      event.type === "tool_execution_end"
    ) {
      turnHadVisibleOutput = true;
    }

    if (onEvent) {
      onEvent(event);
    }
  });

  try {
    state.queue = state.queue.then(async () => {
      await state.session.prompt(text);
    });
    await state.queue;

    const lastMessage = state.session.state.messages.at(-1);
    const diagnostics = getAssistantDiagnostics(lastMessage);

    if (diagnostics?.errorMessage) {
      return {
        ok: false,
        diagnostics,
        error: diagnostics.errorMessage,
      };
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
      return {
        ok: false,
        diagnostics,
        error: emptyResponseError,
      };
    }

    return {
      ok: true,
      diagnostics,
      assistantText: diagnostics?.text || "",
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err),
    };
  } finally {
    unsubscribe();
  }
}

/**
 * Handle incoming WebSocket connection using pi-coding-agent
 */
export async function handleWsConnection(
  ws,
  {
    sessionId,
    apiKey,
    rootDir,
    provider = "openai",
    modelId = "gpt-5.4",
    onUserMessage,
    onAssistantFinal,
  },
) {
  const resolvedSessionId = sessionId || crypto.randomUUID();

  try {
    const state = await getOrCreateSessionState({
      sessionId: resolvedSessionId,
      apiKey,
      rootDir,
      provider,
      modelId,
    });

    state.wsConnections.add(ws);

    ws.send(
      JSON.stringify({
        type: "session_info",
        sessionId: resolvedSessionId,
      }),
    );

    const unsubscribe = subscribeSession(state, (event) => {
      switch (event.type) {
        case "agent_start":
          log("\n=== [PI-CODING-AGENT SESSION START] ===");
          log("System Prompt:\n", state.session.systemPrompt);
          log("========================================\n");
          ws.send(JSON.stringify({ type: "agent_start" }));
          break;

        case "message_start":
          log(`\n--- [Message Start: ${event.message?.role}] ---`);
          if (event.message?.role === "user") {
            log(JSON.stringify(event.message.content, null, 2));
          }
          const messageText = extractMessageText(event.message);
          ws.send(
            JSON.stringify({
              type: "message_start",
              role: event.message?.role,
              text: messageText,
            }),
          );
          break;

        case "message_update":
          if (event.assistantMessageEvent?.type === "text_delta") {
            write(event.assistantMessageEvent.delta);
            ws.send(
              JSON.stringify({
                type: "text_delta",
                delta: event.assistantMessageEvent.delta,
              }),
            );
          } else if (event.assistantMessageEvent?.type === "thinking_delta") {
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
          ws.send(
            JSON.stringify({
              type: "message_end",
              role: event.message?.role,
            }),
          );
          break;

        case "tool_execution_start":
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

    ws.on("message", async (data) => {
      try {
        const payload = JSON.parse(data.toString());
        if (!payload.text) {
          return;
        }

        if (onUserMessage) {
          onUserMessage({
            sessionId: resolvedSessionId,
            text: payload.text,
          });
        }

        const result = await promptSession(
          {
            sessionId: resolvedSessionId,
            apiKey,
            rootDir,
            provider,
            modelId,
          },
          payload.text,
        );

        if (!result.ok) {
          ws.send(JSON.stringify({ error: result.error || "Request failed" }));
          return;
        }

        if (onAssistantFinal && result.assistantText) {
          onAssistantFinal({
            sessionId: resolvedSessionId,
            text: result.assistantText,
          });
        }

        ws.send(JSON.stringify({ done: true }));
      } catch (err) {
        ws.send(JSON.stringify({ error: String(err) }));
      }
    });

    ws.on("close", () => {
      unsubscribe();
      state.wsConnections.delete(ws);
    });
  } catch (err) {
    ws.send(JSON.stringify({ error: String(err) }));
    ws.close();
  }
}
