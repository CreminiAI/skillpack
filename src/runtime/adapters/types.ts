import type { Server } from "node:http";
import type { Express } from "express";
import type {
  ArtifactSnapshotService,
  ResultStore,
  ResultsQueryService,
} from "../artifacts/index.js";

// ---------------------------------------------------------------------------
// Bot Commands
// ---------------------------------------------------------------------------

/** Unified bot commands supported by all adapters */
export type BotCommand = "new" | "clear" | "restart" | "shutdown" | "help";

/** Result of a command execution */
export interface CommandResult {
  success: boolean;
  message?: string;
}

export type LifecycleTrigger = "web" | "telegram" | "slack" | "signal";


export interface LifecycleHandler {
  requestRestart(trigger: LifecycleTrigger): Promise<CommandResult>;
  requestShutdown(trigger: LifecycleTrigger): Promise<CommandResult>;
}

export interface LifecycleInfo {
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

export interface HandleMessageOptions {
  jobName?: string;
}

export interface PackAgentOptions {
  apiKey: string;
  rootDir: string;
  provider: string;
  modelId: string;
  baseUrl?: string;
  apiProtocol?: "openai-responses" | "openai-completions";
  lifecycleHandler: LifecycleHandler;
  resultStore: ResultStore;
  artifactSnapshotService: ArtifactSnapshotService;
}

/**
 * PackAgent interface – platform-agnostic agent layer.
 * Each adapter calls these methods; the agent handles session state internally.
 */
export interface IPackAgent {
  /** Handle an incoming message with streaming events */
  handleMessage(
    adapter: "telegram" | "slack" | "web" | "scheduler",
    channelId: string,
    text: string,
    onEvent: (event: AgentEvent) => void,
    attachments?: ChannelAttachment[],
    options?: HandleMessageOptions,
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

  /** Get in-memory active channel IDs */
  getActiveChannelIds(): string[];

  /** Get the shared AuthStorage instance (used by OAuth API endpoints) */
  getAuthStorage(): any;

  /** Update runtime auth when provider/apiKey changes */
  updateAuth(provider: string, apiKey?: string): void;
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
    toolCallId: string;
    toolName: string;
    toolInput: unknown;
  }
  | {
    type: "tool_end";
    toolCallId: string;
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
// IPC Broadcast
// ---------------------------------------------------------------------------

/** IPC broadcast interface used by platform adapters to notify Electron */
export interface IpcBroadcaster {
  broadcastInbound(
    channelId: string,
    platform: string,
    sender: { id: string; username: string },
    text: string,
  ): void;
  broadcastAgentEvent(channelId: string, event: AgentEvent): void;
}

// ---------------------------------------------------------------------------
// Platform Adapter
// ---------------------------------------------------------------------------

export interface AdapterContext {
  agent: IPackAgent;
  server: Server;
  app: Express;
  rootDir: string;
  lifecycle: LifecycleInfo & LifecycleHandler;
  /** Unified notify function for pushing messages via a named adapter */
  notify?: (adapter: string, channelId: string, text: string) => Promise<void>;
  /** Map of running adapters by name, for cross-adapter access */
  adapterMap?: Map<string, PlatformAdapter>;
  /** IPC broadcaster (desktop mode only) */
  ipcBroadcaster?: IpcBroadcaster;
  /** Read-only query service for persisted run and artifact results */
  resultsQueryService?: ResultsQueryService;
}

export interface PlatformAdapter {
  /** Adapter name, e.g. "web", "telegram" */
  name: string;

  /** Start the adapter */
  start(ctx: AdapterContext): Promise<void>;

  /** Stop the adapter gracefully */
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Message Sender (for adapters that support proactive message sending)
// ---------------------------------------------------------------------------

/**
 * Adapter that supports proactive message sending
 * (e.g. pushing scheduled job results to IM channels).
 */
export interface MessageSender {
  /** Send a text message to a specific channel/chat */
  sendMessage(channelId: string, text: string): Promise<void>;
  /** Send a file to a specific channel/chat */
  sendFile?(channelId: string, filePath: string, caption?: string): Promise<void>;
}

/** Type guard to check if an adapter supports proactive message sending */
export function isMessageSender(
  adapter: PlatformAdapter,
): adapter is PlatformAdapter & MessageSender {
  return typeof (adapter as any).sendMessage === "function";
}
