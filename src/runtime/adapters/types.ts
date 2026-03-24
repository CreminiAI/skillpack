import type { Server } from "node:http";
import type { Express } from "express";

// ---------------------------------------------------------------------------
// Bot Commands
// ---------------------------------------------------------------------------

/** Unified bot commands supported by all adapters */
export type BotCommand = "new" | "clear" | "restart" | "shutdown";

/** Result of a command execution */
export interface CommandResult {
  success: boolean;
  message?: string;
}

export type LifecycleTrigger = "web" | "telegram" | "slack" | "signal";

export type ProcessManager = "wrapper" | "none";

export interface RuntimeControl {
  canManagedRestart: boolean;
  processManager: ProcessManager;
}

export interface LifecycleHandler {
  requestRestart(trigger: LifecycleTrigger): Promise<CommandResult>;
  requestShutdown(trigger: LifecycleTrigger): Promise<CommandResult>;
}

export interface LifecycleInfo {
  getRuntimeControl(): RuntimeControl;
}

// ---------------------------------------------------------------------------
// Channel & Message
// ---------------------------------------------------------------------------

export interface ChannelAttachment {
  /** Original filename */
  filename: string;
  /** Local path (relative to channel dir) */
  localPath: string;
  /** MIME type if known */
  mimeType?: string;
  /** File size in bytes */
  size?: number;
}

export interface ChannelMessage {
  /** Unique ID within the channel */
  id: string;
  /** Channel/conversation ID */
  channelId: string;
  /** Timestamp (ISO 8601) */
  timestamp: string;
  /** Sender info */
  sender: {
    id: string;
    username: string;
    displayName?: string;
    isBot: boolean;
  };
  /** Message content */
  text: string;
  /** Attachments */
  attachments: ChannelAttachment[];
  /** Is this a direct mention/trigger of the bot? */
  isMention: boolean;
  /** Reply-to message ID (for threaded conversations) */
  replyTo?: string;
  /** Platform-specific metadata */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Session (reserved for future expansion)
// ---------------------------------------------------------------------------

export interface SessionInfo {
  id: string;
  channelId: string;
  createdAt: string;
  lastMessageAt: string;
  messageCount: number;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export interface HandleResult {
  stopReason: string;
  errorMessage?: string;
}

export interface PackAgentOptions {
  apiKey: string;
  rootDir: string;
  provider: string;
  modelId: string;
  lifecycleHandler: LifecycleHandler;
}

/**
 * PackAgent interface – platform-agnostic agent layer.
 * Each adapter calls these methods; the agent handles session state internally.
 */
export interface IPackAgent {
  /** Handle an incoming message with streaming events */
  handleMessage(
    channelId: string,
    text: string,
    onEvent: (event: AgentEvent) => void,
    attachments?: ChannelAttachment[],
  ): Promise<HandleResult>;

  /** Handle a built-in bot command */
  handleCommand(command: BotCommand, channelId: string): Promise<CommandResult>;

  /** Abort the current run for a channel */
  abort(channelId: string): void;

  /** Check if a channel is currently running */
  isRunning(channelId: string): boolean;

  /** Dispose the session for a channel */
  dispose(channelId: string): void;

  /** Reserved: list all sessions */
  listSessions(): SessionInfo[];

  /** Reserved: restore a historical session */
  restoreSession(sessionId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Agent Events (subset forwarded to adapters)
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "message_start"; role: string }
  | { type: "message_end"; role: string }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | {
      type: "tool_start";
      toolName: string;
      toolInput: unknown;
    }
  | {
      type: "tool_end";
      toolName: string;
      isError: boolean;
      result: unknown;
    }
  | {
      type: "file_output";
      filePath: string;
      filename: string;
      mimeType?: string;
      caption?: string;
    };

// ---------------------------------------------------------------------------
// Platform Adapter
// ---------------------------------------------------------------------------

export interface AdapterContext {
  agent: IPackAgent;
  server: Server;
  app: Express;
  rootDir: string;
  lifecycle: LifecycleInfo & LifecycleHandler;
}

export interface PlatformAdapter {
  /** Adapter name, e.g. "web", "telegram" */
  name: string;

  /** Start the adapter */
  start(ctx: AdapterContext): Promise<void>;

  /** Stop the adapter gracefully */
  stop(): Promise<void>;
}
