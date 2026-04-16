import fs from "node:fs";
import path from "node:path";
import {
  parseSessionEntries,
  type SessionEntry,
  type SessionMessageEntry,
} from "@mariozechner/pi-coding-agent";

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
  toolCalls?: Array<{ name: string; isError: boolean }>;
}

export class ConversationService {
  constructor(private readonly rootDir: string) {}

  /**
   * Scan data/sessions and return conversation summaries sorted by recency.
   */
  listConversations(activeChannels: Set<string>): ConversationSummary[] {
    const sessionsDir = path.resolve(this.rootDir, "data", "sessions");
    const channelIds = new Set<string>(activeChannels);

    if (fs.existsSync(sessionsDir)) {
      for (const entry of fs.readdirSync(sessionsDir)) {
        const channelDir = path.join(sessionsDir, entry);
        try {
          if (fs.statSync(channelDir).isDirectory()) {
            channelIds.add(entry);
          }
        } catch {
          // Ignore broken entries and continue.
        }
      }
    }

    const results: ConversationSummary[] = [];
    for (const channelId of channelIds) {
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
        platform: this.detectPlatform(channelId),
        sessionFile,
        messageCount,
        lastMessageAt,
        lastMessagePreview,
      });
    }

    return results.sort((a, b) => {
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
    const messages: ConversationMessage[] = [];
    for (const entry of entries) {
      if (entry.type !== "message") continue;

      const role = entry.message?.role;
      if (role !== "user" && role !== "assistant") continue;

      const text = this.extractText(entry.message);
      if (!text) continue;

      const toolCalls = role === "assistant"
        ? this.extractToolCallSummaries(entry.message)
        : undefined;

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

  private extractToolCallSummaries(
    message: any,
  ): Array<{ name: string; isError: boolean }> | undefined {
    if (!Array.isArray(message?.content)) return undefined;

    const toolCalls = message.content
      .filter((item: any) => item?.type === "toolCall")
      .map((item: any) => ({
        name: typeof item?.name === "string" && item.name
          ? item.name
          : "unknown",
        isError: false,
      }));

    return toolCalls.length > 0 ? toolCalls : undefined;
  }

  private detectPlatform(
    channelId: string,
  ): "telegram" | "slack" | "web" | "scheduler" {
    if (channelId.startsWith("telegram-")) return "telegram";
    if (channelId.startsWith("slack-")) return "slack";
    if (channelId.startsWith("scheduler-")) return "scheduler";
    return "web";
  }
}
