import fs from "node:fs";
import path from "node:path";
import {
  parseSessionEntries,
  type SessionEntry,
  type SessionMessageEntry,
} from "@mariozechner/pi-coding-agent";

export const DEFAULT_WEB_CHANNEL_ID = "web";

export interface ConversationToolCall {
  id: string;
  name: string;
  isError: boolean;
  arguments?: {
    filePath?: string;
    caption?: string;
  };
}

export interface ConversationSummary {
  channelId: string;
  platform: "telegram" | "slack" | "web" | "scheduler";
  sessionFile: string | null;
  messageCount: number;
  lastMessageAt: string;
  lastMessagePreview: string;
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: string;
  toolCalls?: ConversationToolCall[];
}

export interface ListConversationOptions {
  includeDefaultWeb?: boolean;
  includeLegacyWeb?: boolean;
  allowedPlatforms?: Array<ConversationSummary["platform"]>;
}

export class ConversationService {
  constructor(private readonly rootDir: string) {}

  /**
   * Scan data/sessions and return conversation summaries sorted by recency.
   */
  listConversations(
    activeChannels: Set<string>,
    options: ListConversationOptions = {},
  ): ConversationSummary[] {
    const {
      includeDefaultWeb = false,
      includeLegacyWeb = true,
      allowedPlatforms,
    } = options;
    const sessionsDir = path.resolve(this.rootDir, "data", "sessions");
    const channelIds = new Set<string>(activeChannels);
    const allowedPlatformSet = allowedPlatforms
      ? new Set<ConversationSummary["platform"]>(allowedPlatforms)
      : null;

    if (includeDefaultWeb) {
      channelIds.add(DEFAULT_WEB_CHANNEL_ID);
    }

    if (fs.existsSync(sessionsDir)) {
      for (const entry of fs.readdirSync(sessionsDir)) {
        const channelDir = path.join(sessionsDir, entry);
        try {
          if (!fs.statSync(channelDir).isDirectory()) {
            continue;
          }

          const platform = this.detectPlatform(entry);
          if (allowedPlatformSet && !allowedPlatformSet.has(platform)) {
            continue;
          }

          if (!includeLegacyWeb && this.isLegacyWebConversation(entry)) {
            continue;
          }

          channelIds.add(entry);
        } catch {
          // Ignore broken entries and continue.
        }
      }
    }

    const results: ConversationSummary[] = [];
    for (const channelId of channelIds) {
      const platform = this.detectPlatform(channelId);
      if (allowedPlatformSet && !allowedPlatformSet.has(platform)) {
        continue;
      }
      if (!includeLegacyWeb && this.isLegacyWebConversation(channelId)) {
        continue;
      }

      const channelDir = path.join(sessionsDir, channelId);
      const sessionFile = this.findLatestSessionFile(channelDir);

      let messageCount = 0;
      let lastMessageAt = "";
      let lastMessagePreview = "";

      if (sessionFile) {
        const entries = this.loadEntries(sessionFile);
        const messages = entries.filter(
          (entry): entry is SessionMessageEntry => entry.type === "message",
        );
        messageCount = messages.length;

        const lastMessage = messages[messages.length - 1];
        if (lastMessage) {
          lastMessageAt = lastMessage.timestamp;
          lastMessagePreview = this.extractTextPreview(lastMessage, 100);
        }
      }

      results.push({
        channelId,
        platform,
        sessionFile,
        messageCount,
        lastMessageAt,
        lastMessagePreview,
      });
    }

    return results.sort((a, b) => {
      if (a.channelId === DEFAULT_WEB_CHANNEL_ID && b.channelId !== DEFAULT_WEB_CHANNEL_ID) {
        return -1;
      }
      if (b.channelId === DEFAULT_WEB_CHANNEL_ID && a.channelId !== DEFAULT_WEB_CHANNEL_ID) {
        return 1;
      }

      const recency = (b.lastMessageAt || "").localeCompare(a.lastMessageAt || "");
      if (recency !== 0) return recency;
      return a.channelId.localeCompare(b.channelId);
    });
  }

  /**
   * Load latest messages for a channel in a simplified format.
   */
  getMessages(channelId: string, limit = 100): ConversationMessage[] {
    const channelDir = path.resolve(
      this.rootDir,
      "data",
      "sessions",
      channelId,
    );
    const sessionFile = this.findLatestSessionFile(channelDir);
    if (!sessionFile) return [];

    const safeLimit = Number.isFinite(limit)
      ? Math.max(0, Math.floor(limit))
      : 100;
    if (safeLimit === 0) return [];

    const entries = this.loadEntries(sessionFile);
    const toolResultsById = this.collectToolResultStates(entries);
    const messages: ConversationMessage[] = [];
    for (const entry of entries) {
      if (entry.type !== "message") continue;

      const role = entry.message?.role;
      if (role !== "user" && role !== "assistant") continue;

      const text = this.extractText(entry.message);
      const toolCalls = role === "assistant"
        ? this.extractToolCalls(entry.message, toolResultsById)
        : undefined;
      const hasVisibleSendFile = this.hasVisibleSendFileToolCall(toolCalls);

      if (!text && !hasVisibleSendFile) continue;

      messages.push({
        id: entry.id,
        role,
        text,
        timestamp: entry.timestamp,
        toolCalls,
      });
    }

    return messages.slice(-safeLimit);
  }

  private findLatestSessionFile(channelDir: string): string | null {
    if (!fs.existsSync(channelDir)) return null;
    let stats: fs.Stats;
    try {
      stats = fs.statSync(channelDir);
    } catch {
      return null;
    }
    if (!stats.isDirectory()) return null;

    const files = fs.readdirSync(channelDir)
      .filter((file) => file.endsWith(".jsonl"))
      .sort((a, b) => b.localeCompare(a));

    return files[0] ? path.join(channelDir, files[0]) : null;
  }

  private loadEntries(filePath: string): SessionEntry[] {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const fileEntries = parseSessionEntries(content);
      return fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
    } catch (err) {
      console.warn(`[ConversationService] Failed to load ${filePath}:`, err);
      return [];
    }
  }

  private extractText(message: any): string {
    if (!message?.content) return "";
    if (typeof message.content === "string") return message.content.trim();
    if (!Array.isArray(message.content)) return "";

    return message.content
      .filter((item: any) => item?.type === "text")
      .map((item: any) => (typeof item?.text === "string" ? item.text : ""))
      .join("")
      .trim();
  }

  private extractTextPreview(
    entry: SessionMessageEntry,
    maxLen: number,
  ): string {
    const text = this.extractText(entry.message);
    return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
  }

  private collectToolResultStates(entries: SessionEntry[]): Map<string, boolean> {
    const toolResultsById = new Map<string, boolean>();

    for (const entry of entries) {
      if (entry.type !== "message") continue;
      if (entry.message?.role !== "toolResult") continue;
      if (typeof entry.message?.toolCallId !== "string" || !entry.message.toolCallId) {
        continue;
      }

      toolResultsById.set(entry.message.toolCallId, entry.message?.isError === true);
    }

    return toolResultsById;
  }

  private extractToolCalls(
    message: any,
    toolResultsById: Map<string, boolean>,
  ): ConversationToolCall[] | undefined {
    if (!Array.isArray(message?.content)) return undefined;

    const toolCalls = message.content
      .filter((item: any) => item?.type === "toolCall")
      .map((item: any) => {
        const id = typeof item?.id === "string" && item.id
          ? item.id
          : "unknown";
        const name = typeof item?.name === "string" && item.name
          ? item.name
          : "unknown";
        const toolCall: ConversationToolCall = {
          id,
          name,
          isError: toolResultsById.get(id) === true,
        };

        if (name === "send_file") {
          const args = this.extractSendFileArguments(item?.arguments);
          if (args) {
            toolCall.arguments = args;
          }
        }

        return toolCall;
      });

    return toolCalls.length > 0 ? toolCalls : undefined;
  }

  private extractSendFileArguments(
    rawArguments: unknown,
  ): ConversationToolCall["arguments"] | undefined {
    if (!rawArguments || typeof rawArguments !== "object") {
      return undefined;
    }

    const maybeArgs = rawArguments as { filePath?: unknown; caption?: unknown };
    const filePath = typeof maybeArgs.filePath === "string" && maybeArgs.filePath
      ? maybeArgs.filePath
      : undefined;
    const caption = typeof maybeArgs.caption === "string" && maybeArgs.caption
      ? maybeArgs.caption
      : undefined;

    if (!filePath && !caption) {
      return undefined;
    }

    return {
      filePath,
      caption,
    };
  }

  private hasVisibleSendFileToolCall(
    toolCalls: ConversationToolCall[] | undefined,
  ): boolean {
    return Boolean(
      toolCalls?.some((toolCall) =>
        toolCall.name === "send_file" &&
        !toolCall.isError &&
        typeof toolCall.arguments?.filePath === "string" &&
        toolCall.arguments.filePath.length > 0
      ),
    );
  }

  private detectPlatform(
    channelId: string,
  ): "telegram" | "slack" | "web" | "scheduler" {
    if (channelId.startsWith("telegram-")) return "telegram";
    if (channelId.startsWith("slack-")) return "slack";
    if (channelId.startsWith("scheduler-")) return "scheduler";
    return "web";
  }

  private isLegacyWebConversation(channelId: string): boolean {
    return channelId.startsWith("web-");
  }
}
