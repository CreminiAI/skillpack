import path from "node:path";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  DefaultResourceLoader,
} from "@mariozechner/pi-coding-agent";

import { MemoryManager } from "./memory.js";
import type { MemoryConfig } from "./memory.js";

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
}

// ---------------------------------------------------------------------------
// PackAgent
// ---------------------------------------------------------------------------

export class PackAgent implements IPackAgent {
  private options: PackAgentOptions;
  private channels = new Map<string, ChannelSession>();
  private memoryManager?: MemoryManager;

  constructor(options: PackAgentOptions) {
    this.options = options;
    if (options.memory?.enabled && options.memory.serverUrl) {
      this.memoryManager = new MemoryManager({
        enabled: true,
        serverUrl: options.memory.serverUrl,
        maxMemories: options.memory.maxMemories,
      });
      // 异步健康检查，不阻塞构造
      this.memoryManager.healthCheck().catch(() => {});
    }
  }

  /**
   * Lazily create (or return existing) session for a channel.
   */
  private async getOrCreateSession(channelId: string): Promise<ChannelSession> {
    const existing = this.channels.get(channelId);
    if (existing) return existing;

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

    const channelSession: ChannelSession = { session, running: false };
    this.channels.set(channelId, channelSession);

    // 为该 channel 创建 OpenViking Session
    if (this.memoryManager) {
      this.memoryManager.createSession(channelId).catch((err) => {
        log("[PackAgent] Failed to create OV session:", err);
      });
    }

    return channelSession;
  }

  async handleMessage(
    channelId: string,
    text: string,
    onEvent: (event: AgentEvent) => void,
  ): Promise<HandleResult> {
    const cs = await this.getOrCreateSession(channelId);
    cs.running = true;

    let turnHadVisibleOutput = false;

    // ── Memory: 检索相关记忆并注入 context ──
    let memoryContext = "";
    if (this.memoryManager) {
      try {
        memoryContext = await this.memoryManager.retrieveMemories(text);
        if (memoryContext) {
          log("[PackAgent] Retrieved memory context, injecting...");
        }
      } catch (err) {
        log("[PackAgent] Memory retrieval failed (non-fatal):", err);
      }
      // 同步 user 消息到 OV Session
      this.memoryManager.syncMessage(channelId, "user", text);
    }

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
      // 如果有记忆 context，将其作为前置消息注入
      const promptText = memoryContext
        ? `${memoryContext}\n\n---\n\n${text}`
        : text;
      await cs.session.prompt(promptText);

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

      // ── Memory: 同步 assistant 回复到 OV Session ──
      if (this.memoryManager) {
        const lastMsg = cs.session.state.messages.at(-1);
        if (lastMsg?.role === "assistant") {
          const content = Array.isArray(lastMsg.content)
            ? lastMsg.content
                .filter((item: any) => item?.type === "text")
                .map((item: any) => item.text || "")
                .join("")
            : "";
          if (content.trim()) {
            this.memoryManager.syncMessage(channelId, "assistant", content);
          }
        }
      }
    }
  }

  async handleCommand(
    command: BotCommand,
    channelId: string,
  ): Promise<CommandResult> {
    switch (command) {
      case "clear": {
        // 提交 OV Session 并提取记忆（在 pi session 销毁前）
        if (this.memoryManager) {
          await this.memoryManager.commitSession(channelId).catch((err) => {
            log("[PackAgent] OV commit on clear failed (non-fatal):", err);
          });
        }
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
    // 尝试提交 OV Session（fire-and-forget）
    if (this.memoryManager) {
      this.memoryManager.disposeSession(channelId).catch(() => {});
    }
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
