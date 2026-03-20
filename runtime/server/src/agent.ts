import path from "node:path";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  DefaultResourceLoader,
} from "@mariozechner/pi-coding-agent";

import type {
  IPackAgent,
  PackAgentOptions,
  HandleResult,
  AgentEvent,
  BotCommand,
  CommandResult,
  LifecycleTrigger,
  SessionInfo,
} from "./adapters/types.js";

const DEBUG = true;
const log = (...args: unknown[]) => DEBUG && console.log(...args);
const write = (data: string) => DEBUG && process.stdout.write(data);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AssistantDiagnostics {
  stopReason: string;
  errorMessage: string;
  hasText: boolean;
  toolCalls: number;
}

function getAssistantDiagnostics(message: any): AssistantDiagnostics | null {
  if (!message || message.role !== "assistant") {
    return null;
  }

  const stopReason = message.stopReason ?? "unknown";
  const errorMessage =
    message.errorMessage ||
    (stopReason === "error" || stopReason === "aborted"
      ? `Request ${stopReason}`
      : "");

  const content = Array.isArray(message.content) ? message.content : [];
  const text = content
    .filter((item: any) => item?.type === "text")
    .map((item: any) => item.text || "")
    .join("")
    .trim();
  const toolCalls = content.filter(
    (item: any) => item?.type === "toolCall",
  ).length;

  return { stopReason, errorMessage, hasText: text.length > 0, toolCalls };
}

function getLifecycleTrigger(channelId: string): LifecycleTrigger {
  if (channelId.startsWith("telegram-")) return "telegram";
  if (channelId.startsWith("slack-")) return "slack";
  return "web";
}

// ---------------------------------------------------------------------------
// ChannelSession – per-channel agent session wrapper
// ---------------------------------------------------------------------------

interface ChannelSession {
  session: any; // AgentSession from pi-coding-agent
  running: boolean;
  pending: Promise<void>;
}

// ---------------------------------------------------------------------------
// PackAgent
// ---------------------------------------------------------------------------

export class PackAgent implements IPackAgent {
  private options: PackAgentOptions;
  private channels = new Map<string, ChannelSession>();
  private pendingSessionCreations = new Map<string, Promise<ChannelSession>>();

  constructor(options: PackAgentOptions) {
    this.options = options;
  }

  /**
   * Lazily create (or return existing) session for a channel.
   */
  private async getOrCreateSession(channelId: string): Promise<ChannelSession> {
    const existing = this.channels.get(channelId);
    if (existing) return existing;

    const pendingCreation = this.pendingSessionCreations.get(channelId);
    if (pendingCreation) return pendingCreation;

    const createSessionPromise = (async () => {
      const { apiKey, rootDir, provider, modelId } = this.options;

      const authStorage = AuthStorage.inMemory({
        [provider]: { type: "api_key", key: apiKey },
      });
      (authStorage as any).setRuntimeApiKey(provider, apiKey);

      const modelRegistry = new ModelRegistry(authStorage);
      const model = modelRegistry.find(provider, modelId);

      const sessionManager = SessionManager.inMemory();

      const skillsPath = path.resolve(rootDir, "skills");
      log(`[PackAgent] Loading skills from: ${skillsPath}`);

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

      const channelSession: ChannelSession = {
        session,
        running: false,
        pending: Promise.resolve(),
      };
      this.channels.set(channelId, channelSession);
      return channelSession;
    })();

    this.pendingSessionCreations.set(channelId, createSessionPromise);

    try {
      return await createSessionPromise;
    } finally {
      this.pendingSessionCreations.delete(channelId);
    }
  }

  async handleMessage(
    channelId: string,
    text: string,
    onEvent: (event: AgentEvent) => void,
  ): Promise<HandleResult> {
    const cs = await this.getOrCreateSession(channelId);
    const run = async (): Promise<HandleResult> => {
      cs.running = true;

      let turnHadVisibleOutput = false;

      // Subscribe to agent events and forward to adapter
      const unsubscribe = cs.session.subscribe((event: any) => {
        switch (event.type) {
          case "agent_start":
            log("\n=== [AGENT SESSION START] ===");
            log("System Prompt:\n", cs.session.systemPrompt);
            log("============================\n");
            onEvent({ type: "agent_start" });
            break;

          case "message_start":
            log(`\n--- [Message Start: ${event.message?.role}] ---`);
            if (event.message?.role === "user") {
              log(JSON.stringify(event.message.content, null, 2));
            }
            onEvent({ type: "message_start", role: event.message?.role ?? "" });
            break;

          case "message_update":
            if (event.assistantMessageEvent?.type === "text_delta") {
              turnHadVisibleOutput = true;
              write(event.assistantMessageEvent.delta);
              onEvent({
                type: "text_delta",
                delta: event.assistantMessageEvent.delta,
              });
            } else if (event.assistantMessageEvent?.type === "thinking_delta") {
              turnHadVisibleOutput = true;
              onEvent({
                type: "thinking_delta",
                delta: event.assistantMessageEvent.delta,
              });
            }
            break;

          case "message_end":
            log(`\n--- [Message End: ${event.message?.role}] ---`);
            if (event.message?.role === "assistant") {
              const diagnostics = getAssistantDiagnostics(event.message);
              if (diagnostics) {
                log(
                  `[Assistant Diagnostics] stopReason=${diagnostics.stopReason} text=${diagnostics.hasText ? "yes" : "no"} toolCalls=${diagnostics.toolCalls}`,
                );
                if (diagnostics.errorMessage) {
                  log(`[Assistant Error] ${diagnostics.errorMessage}`);
                }
              }
            }
            onEvent({ type: "message_end", role: event.message?.role ?? "" });
            break;

          case "tool_execution_start":
            turnHadVisibleOutput = true;
            log(`\n>>> [Tool Start: ${event.toolName}] >>>`);
            log("Args:", JSON.stringify(event.args, null, 2));
            onEvent({
              type: "tool_start",
              toolName: event.toolName,
              toolInput: event.args,
            });
            break;

          case "tool_execution_end":
            turnHadVisibleOutput = true;
            log(`<<< [Tool End: ${event.toolName}] <<<`);
            log(`Error: ${event.isError ? "Yes" : "No"}`);
            onEvent({
              type: "tool_end",
              toolName: event.toolName,
              isError: event.isError,
              result: event.result,
            });
            break;

          case "agent_end":
            log("\n=== [AGENT SESSION END] ===\n");
            onEvent({ type: "agent_end" });
            break;
        }
      });

      try {
        await cs.session.prompt(text);

        const lastMessage = cs.session.state.messages.at(-1);
        const diagnostics = getAssistantDiagnostics(lastMessage);

        if (diagnostics?.errorMessage) {
          return {
            stopReason: diagnostics.stopReason,
            errorMessage: diagnostics.errorMessage,
          };
        }

        if (
          diagnostics &&
          !diagnostics.hasText &&
          diagnostics.toolCalls === 0 &&
          !turnHadVisibleOutput
        ) {
          return {
            stopReason: diagnostics.stopReason,
            errorMessage:
              "Assistant returned no visible output. Check the server logs for details.",
          };
        }

        return { stopReason: diagnostics?.stopReason ?? "unknown" };
      } finally {
        cs.running = false;
        unsubscribe();
      }
    };

    const resultPromise = cs.pending.catch(() => undefined).then(run);
    cs.pending = resultPromise.then(() => undefined, () => undefined);
    return resultPromise;
  }

  async handleCommand(
    command: BotCommand,
    channelId: string,
  ): Promise<CommandResult> {
    switch (command) {
      case "clear": {
        const cs = this.channels.get(channelId);
        if (cs) {
          cs.session.dispose();
          this.channels.delete(channelId);
        }
        return { success: true, message: "Session cleared." };
      }

      case "restart":
        log("[PackAgent] Restart requested");
        return this.options.lifecycleHandler.requestRestart(
          getLifecycleTrigger(channelId),
        );

      case "shutdown":
        log("[PackAgent] Shutdown requested");
        return this.options.lifecycleHandler.requestShutdown(
          getLifecycleTrigger(channelId),
        );

      default:
        return { success: false, message: `Unknown command: ${command}` };
    }
  }

  abort(channelId: string): void {
    const cs = this.channels.get(channelId);
    if (cs?.running) {
      cs.session.abort?.();
    }
  }

  isRunning(channelId: string): boolean {
    return this.channels.get(channelId)?.running ?? false;
  }

  dispose(channelId: string): void {
    const cs = this.channels.get(channelId);
    if (cs) {
      cs.session.dispose();
      this.channels.delete(channelId);
    }
  }

  /** Reserved: list all sessions */
  listSessions(): SessionInfo[] {
    // TODO: Implement session persistence and listing
    return [];
  }

  /** Reserved: restore a historical session */
  async restoreSession(_sessionId: string): Promise<void> {
    // TODO: Implement session restoration
  }
}
