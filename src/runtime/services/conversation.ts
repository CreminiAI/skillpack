import fs from "node:fs";
import path from "node:path";
import {
  parseSessionEntries,
  type SessionEntry,
  type SessionMessageEntry,
} from "@mariozechner/pi-coding-agent";
import {
  detectPlatformFromChannelId,
  type RuntimePlatform,
} from "../adapters/types.js";

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

export type ConversationBlock =
  | {
      id: string;
      type: "thinking";
      text: string;
    }
  | {
      id: string;
      type: "tool";
      toolCallId?: string;
      toolName: string;
      toolInput?: unknown;
      result?: unknown;
      isError?: boolean;
      status: "running" | "done";
    }
  | {
      id: string;
      type: "file";
      filename: string;
      filePath: string;
      mimeType?: string;
      caption?: string;
    };

export interface ConversationSummary {
  channelId: string;
  platform: RuntimePlatform;
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
  blocks?: ConversationBlock[];
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
      if (
        a.channelId === DEFAULT_WEB_CHANNEL_ID &&
        b.channelId !== DEFAULT_WEB_CHANNEL_ID
      ) {
        return -1;
      }
      if (
        b.channelId === DEFAULT_WEB_CHANNEL_ID &&
        a.channelId !== DEFAULT_WEB_CHANNEL_ID
      ) {
        return 1;
      }

      const recency = (b.lastMessageAt || "").localeCompare(
        a.lastMessageAt || "",
      );
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
    let pendingBlocks: ConversationBlock[] = [];
    let pendingToolCalls: ConversationToolCall[] = [];
    let pendingMessageId = "";
    let pendingTimestamp = "";

    const flushPendingAssistant = () => {
      if (pendingBlocks.length === 0 && pendingToolCalls.length === 0) {
        return;
      }

      messages.push({
        id: pendingMessageId || `assistant-${messages.length + 1}`,
        role: "assistant",
        text: "",
        timestamp: pendingTimestamp || new Date(0).toISOString(),
        toolCalls: pendingToolCalls.length > 0 ? pendingToolCalls : undefined,
        blocks: pendingBlocks.length > 0 ? pendingBlocks : undefined,
      });

      pendingBlocks = [];
      pendingToolCalls = [];
      pendingMessageId = "";
      pendingTimestamp = "";
    };

    for (const entry of entries) {
      if (entry.type !== "message") continue;

      const role = entry.message?.role;
      if (role === "user") {
        flushPendingAssistant();

        const text = this.extractText(entry.message);
        if (!text) continue;

        messages.push({
          id: entry.id,
          role,
          text,
          timestamp: entry.timestamp,
        });
        continue;
      }

      if (role !== "assistant") continue;

      const text = this.extractText(entry.message);
      const toolCalls = this.extractToolCalls(entry.message, toolResultsById);
      const blocks = this.extractBlocks(
        entry.id,
        entry.message,
        toolResultsById,
      );

      if (!text) {
        if (blocks.length > 0) {
          pendingBlocks = [...pendingBlocks, ...blocks];
        }
        if (toolCalls?.length) {
          pendingToolCalls = this.mergeToolCalls(pendingToolCalls, toolCalls);
        }
        if (!pendingMessageId) {
          pendingMessageId = entry.id;
          pendingTimestamp = entry.timestamp;
        }
        continue;
      }

      const mergedBlocks =
        pendingBlocks.length > 0 ? [...pendingBlocks, ...blocks] : blocks;
      const mergedToolCalls = this.mergeToolCalls(pendingToolCalls, toolCalls);

      messages.push({
        id: entry.id,
        role,
        text,
        timestamp: entry.timestamp,
        toolCalls: mergedToolCalls.length > 0 ? mergedToolCalls : undefined,
        blocks: mergedBlocks.length > 0 ? mergedBlocks : undefined,
      });

      pendingBlocks = [];
      pendingToolCalls = [];
      pendingMessageId = "";
      pendingTimestamp = "";
    }

    flushPendingAssistant();

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

    const files = fs
      .readdirSync(channelDir)
      .filter((file) => file.endsWith(".jsonl"))
      .sort((a, b) => b.localeCompare(a));

    return files[0] ? path.join(channelDir, files[0]) : null;
  }

  private loadEntries(filePath: string): SessionEntry[] {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const fileEntries = parseSessionEntries(content);
      return fileEntries.filter(
        (entry): entry is SessionEntry => entry.type !== "session",
      );
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

  private collectToolResultStates(
    entries: SessionEntry[],
  ): Map<string, { isError: boolean; result?: unknown }> {
    const toolResultsById = new Map<
      string,
      { isError: boolean; result?: unknown }
    >();

    for (const entry of entries) {
      if (entry.type !== "message") continue;
      if (entry.message?.role !== "toolResult") continue;
      if (
        typeof entry.message?.toolCallId !== "string" ||
        !entry.message.toolCallId
      ) {
        continue;
      }

      toolResultsById.set(entry.message.toolCallId, {
        isError: entry.message?.isError === true,
        result: this.extractToolResultValue(entry.message),
      });
    }

    return toolResultsById;
  }

  private extractToolCalls(
    message: any,
    toolResultsById: Map<string, { isError: boolean; result?: unknown }>,
  ): ConversationToolCall[] | undefined {
    if (!Array.isArray(message?.content)) return undefined;

    const toolCalls = message.content
      .filter((item: any) => item?.type === "toolCall")
      .map((item: any) => {
        const id =
          typeof item?.id === "string" && item.id ? item.id : "unknown";
        const name =
          typeof item?.name === "string" && item.name ? item.name : "unknown";
        const toolCall: ConversationToolCall = {
          id,
          name,
          isError: toolResultsById.get(id)?.isError === true,
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

  private extractBlocks(
    messageId: string,
    message: any,
    toolResultsById: Map<string, { isError: boolean; result?: unknown }>,
  ): ConversationBlock[] {
    if (!Array.isArray(message?.content)) {
      return [];
    }

    const blocks: ConversationBlock[] = [];

    message.content.forEach((item: any, index: number) => {
      if (item?.type === "thinking") {
        const thinkingText = this.extractThinkingText(item);
        if (thinkingText) {
          blocks.push({
            id: `${messageId}-thinking-${index}`,
            type: "thinking",
            text: thinkingText,
          });
        }
        return;
      }

      if (item?.type !== "toolCall") {
        return;
      }

      const toolCallId =
        typeof item?.id === "string" && item.id
          ? item.id
          : `${messageId}-tool-${index}`;
      const toolName =
        typeof item?.name === "string" && item.name ? item.name : "unknown";
      const toolResult = toolResultsById.get(toolCallId);
      const sendFileArgs =
        toolName === "send_file"
          ? this.extractSendFileArguments(item?.arguments)
          : undefined;

      if (
        toolName === "send_file" &&
        !toolResult?.isError &&
        sendFileArgs?.filePath
      ) {
        blocks.push({
          id: toolCallId,
          type: "file",
          filename: this.getFileBaseName(sendFileArgs.filePath),
          filePath: sendFileArgs.filePath,
          caption: sendFileArgs.caption,
        });
        return;
      }

      blocks.push({
        id: toolCallId,
        type: "tool",
        toolCallId,
        toolName,
        toolInput: item?.arguments,
        result: toolResult?.result,
        isError: toolResult?.isError === true,
        status: toolResult ? "done" : "running",
      });
    });

    return blocks;
  }

  private extractThinkingText(item: any): string {
    if (typeof item?.thinking === "string" && item.thinking.trim()) {
      return item.thinking.trim();
    }

    if (
      typeof item?.thinkingSignature !== "string" ||
      !item.thinkingSignature
    ) {
      return "";
    }

    try {
      const parsed = JSON.parse(item.thinkingSignature);
      if (!Array.isArray(parsed?.summary)) {
        return "";
      }

      return parsed.summary
        .map((summaryItem: any) =>
          typeof summaryItem?.text === "string" ? summaryItem.text.trim() : "",
        )
        .filter(Boolean)
        .join("\n\n")
        .trim();
    } catch {
      return "";
    }
  }

  private extractToolResultValue(message: any): unknown {
    if (!message?.content) {
      return undefined;
    }

    if (typeof message.content === "string") {
      return this.parsePossibleJson(message.content);
    }

    if (!Array.isArray(message.content)) {
      return message.content;
    }

    const textContent = message.content
      .filter((item: any) => item?.type === "text")
      .map((item: any) => (typeof item?.text === "string" ? item.text : ""))
      .join("")
      .trim();

    if (textContent) {
      return this.parsePossibleJson(textContent);
    }

    return message.content;
  }

  private parsePossibleJson(value: string): unknown {
    const trimmed = value.trim();
    if (!trimmed) {
      return "";
    }

    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }

  private extractSendFileArguments(
    rawArguments: unknown,
  ): ConversationToolCall["arguments"] | undefined {
    if (!rawArguments || typeof rawArguments !== "object") {
      return undefined;
    }

    const maybeArgs = rawArguments as { filePath?: unknown; caption?: unknown };
    const filePath =
      typeof maybeArgs.filePath === "string" && maybeArgs.filePath
        ? maybeArgs.filePath
        : undefined;
    const caption =
      typeof maybeArgs.caption === "string" && maybeArgs.caption
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
      toolCalls?.some(
        (toolCall) =>
          toolCall.name === "send_file" &&
          !toolCall.isError &&
          typeof toolCall.arguments?.filePath === "string" &&
          toolCall.arguments.filePath.length > 0,
      ),
    );
  }

  private mergeToolCalls(
    left: ConversationToolCall[] | undefined,
    right: ConversationToolCall[] | undefined,
  ): ConversationToolCall[] {
    const merged = [...(left || []), ...(right || [])];
    const byId = new Map<string, ConversationToolCall>();

    for (const toolCall of merged) {
      byId.set(toolCall.id, toolCall);
    }

    return [...byId.values()];
  }

  private getFileBaseName(filePath: string): string {
    const normalized = filePath.replace(/\\/g, "/");
    const parts = normalized.split("/").filter(Boolean);
    return parts[parts.length - 1] || filePath;
  }

  private detectPlatform(
    channelId: string,
  ): RuntimePlatform {
    return detectPlatformFromChannelId(channelId);
  }

  private isLegacyWebConversation(channelId: string): boolean {
    return channelId.startsWith("web-");
  }
}
