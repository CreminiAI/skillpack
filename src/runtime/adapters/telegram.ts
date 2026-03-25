import fs from "node:fs";
import TelegramBot from "node-telegram-bot-api";

import type {
  PlatformAdapter,
  AdapterContext,
  AgentEvent,
  BotCommand,
  ChannelAttachment,
  IPackAgent,
  MessageSender,
} from "./types.js";
import { formatTelegramMessage } from "./markdown.js";
import { downloadAndSaveAttachment } from "./attachment-utils.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface TelegramAdapterOptions {
  token: string;
}

const COMMANDS: Record<string, BotCommand> = {
  "/clear": "clear",
  "/restart": "restart",
  "/shutdown": "shutdown",
};

const MAX_MESSAGE_LENGTH = 4096;
const ACK_REACTION = {
  type: "emoji" as const,
  emoji: "👀" as const,
};

// ---------------------------------------------------------------------------
// TelegramAdapter
// ---------------------------------------------------------------------------

export class TelegramAdapter implements PlatformAdapter, MessageSender {
  readonly name = "telegram";

  private bot: TelegramBot | null = null;
  private agent: IPackAgent | null = null;
  private options: TelegramAdapterOptions;
  private rootDir = "";

  constructor(options: TelegramAdapterOptions) {
    this.options = options;
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.agent = ctx.agent;
    this.rootDir = ctx.rootDir;

    this.bot = new TelegramBot(this.options.token, { polling: true });

    this.bot.on("message", (msg) => {
      this.handleTelegramMessage(msg).catch((err) => {
        console.error("[Telegram] Error handling message:", err);
      });
    });

    // Register bot commands with Telegram
    await this.bot.setMyCommands([
      { command: "clear", description: "Clear current session and start new" },
      { command: "restart", description: "Restart the server process" },
      { command: "shutdown", description: "Shut down the server process" },
    ]);

    const me = await this.bot.getMe();
    console.log(`[TelegramAdapter] Started as @${me.username}`);
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stopPolling();
      this.bot = null;
    }
    console.log("[TelegramAdapter] Stopped");
  }

  // -------------------------------------------------------------------------
  // MessageSender – proactive message sending
  // -------------------------------------------------------------------------

  /**
   * Public method: send a message to a specific Telegram chat.
   * channelId format: telegram-<chatId>
   */
  async sendMessage(channelId: string, text: string): Promise<void> {
    if (!this.bot) throw new Error("[Telegram] Bot not initialized");
    const chatId = Number(channelId.replace("telegram-", ""));
    if (isNaN(chatId)) {
      throw new Error(`[Telegram] Invalid channelId: ${channelId}`);
    }
    await this.sendLongMessage(chatId, text);
  }

  // -------------------------------------------------------------------------
  // Message handler
  // -------------------------------------------------------------------------

  private async handleTelegramMessage(msg: TelegramBot.Message) {
    if (!this.bot || !this.agent) return;

    const chatId = msg.chat.id;
    const messageId = msg.message_id;
    const text = (msg.text || msg.caption || "").trim();

    const channelId = `telegram-${chatId}`;

    // --- Extract attachments ---
    const attachments = await this.extractAttachments(msg, channelId);

    // Skip messages with no text and no attachments
    if (!text && attachments.length === 0) return;

    await this.tryAckReaction(chatId, messageId);

    // --- Command handling ---
    if (text) {
      const commandKey = text.split(/\s/)[0].toLowerCase();
      const command = COMMANDS[commandKey];

      if (command) {
        const result = await this.agent.handleCommand(command, channelId);
        await this.sendSafe(chatId, result.message || `/${command} executed.`);
        return;
      }
    }

    // --- Regular message → agent ---
    await this.bot.sendChatAction(chatId, "typing");

    let finalText = "";
    let hasError = false;
    let errorMessage = "";
    const pendingFiles: Array<{ filePath: string; caption?: string }> = [];

    const onEvent = (event: AgentEvent) => {
      switch (event.type) {
        case "text_delta":
          finalText += event.delta;
          break;
        case "file_output":
          pendingFiles.push({
            filePath: event.filePath,
            caption: event.caption,
          });
          break;
      }
    };

    try {
      const userText = text || "(User sent an attachment)";
      const result = await this.agent.handleMessage(
        channelId,
        userText,
        onEvent,
        attachments.length > 0 ? attachments : undefined,
      );

      if (result.errorMessage) {
        hasError = true;
        errorMessage = result.errorMessage;
      }
    } catch (err) {
      hasError = true;
      errorMessage = String(err);
    }

    // --- Send response ---
    if (hasError) {
      await this.sendSafe(chatId, `❌ Error: ${errorMessage}`);
      return;
    }

    if (finalText.trim()) {
      await this.sendLongMessage(chatId, finalText);
    } else if (pendingFiles.length === 0) {
      await this.sendSafe(chatId, "(No response generated)");
    }

    // --- Send outbound files ---
    for (const file of pendingFiles) {
      await this.sendFileSafe(chatId, file.filePath, file.caption);
    }
  }

  // -------------------------------------------------------------------------
  // Send helpers
  // -------------------------------------------------------------------------

  /**
   * Send a message, splitting into chunks if too long.
   */
  private async sendLongMessage(chatId: number, text: string): Promise<void> {
    const chunks = this.splitMessage(text);

    for (const chunk of chunks) {
      await this.sendWithRetry(chatId, chunk);
    }
  }

  /**
   * React to the incoming message to show the bot has started processing it.
   */
  private async tryAckReaction(
    chatId: number,
    messageId: number,
  ): Promise<void> {
    try {
      await this.bot?.setMessageReaction(chatId, messageId, {
        reaction: [ACK_REACTION],
        is_big: false,
      });
    } catch (err) {
      console.error("[Telegram] Failed to add ack reaction:", err);
    }
  }

  /**
   * Split text into chunks respecting Telegram's message length limit.
   * Tries to split at paragraph boundaries.
   */
  private splitMessage(text: string): string[] {
    if (text.length <= MAX_MESSAGE_LENGTH) {
      return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= MAX_MESSAGE_LENGTH) {
        chunks.push(remaining);
        break;
      }

      // Find a good split point (paragraph break, then line break, then space)
      let splitAt = remaining.lastIndexOf("\n\n", MAX_MESSAGE_LENGTH);
      if (splitAt < MAX_MESSAGE_LENGTH * 0.5) {
        splitAt = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
      }
      if (splitAt < MAX_MESSAGE_LENGTH * 0.3) {
        splitAt = remaining.lastIndexOf(" ", MAX_MESSAGE_LENGTH);
      }
      if (splitAt < 1) {
        splitAt = MAX_MESSAGE_LENGTH;
      }

      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }

    return chunks;
  }

  /**
   * Send a message with automatic retry on 429 (rate limit).
   */
  private async sendWithRetry(
    chatId: number,
    text: string,
    maxRetries = 3,
  ): Promise<void> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.bot!.sendMessage(chatId, formatTelegramMessage(text), {
          parse_mode: "HTML",
        });
        return;
      } catch (err: any) {
        if (
          err?.response?.statusCode === 429 &&
          attempt < maxRetries
        ) {
          const retryAfter =
            err.response?.body?.parameters?.retry_after || 5;
          console.log(
            `[Telegram] Rate limited, retrying after ${retryAfter}s...`,
          );
          await new Promise((resolve) =>
            setTimeout(resolve, retryAfter * 1000),
          );
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Safe send that catches and logs errors.
   */
  private async sendSafe(chatId: number, text: string): Promise<void> {
    try {
      await this.sendWithRetry(chatId, text);
    } catch (err) {
      console.error("[Telegram] Failed to send message:", err);
    }
  }

  // -------------------------------------------------------------------------
  // Attachment extraction
  // -------------------------------------------------------------------------

  /**
   * Extract attachments from a Telegram message (photo, document, audio, video, voice).
   */
  private async extractAttachments(
    msg: TelegramBot.Message,
    channelId: string,
  ): Promise<ChannelAttachment[]> {
    if (!this.bot) return [];

    const attachments: ChannelAttachment[] = [];

    try {
      // Photo (take highest resolution)
      if (msg.photo && msg.photo.length > 0) {
        const photo = msg.photo[msg.photo.length - 1];
        const attachment = await this.downloadTelegramFile(
          photo.file_id,
          channelId,
          "photo.jpg",
          "image/jpeg",
        );
        if (attachment) attachments.push(attachment);
      }

      // Document
      if (msg.document) {
        const attachment = await this.downloadTelegramFile(
          msg.document.file_id,
          channelId,
          msg.document.file_name || "document",
          msg.document.mime_type,
        );
        if (attachment) attachments.push(attachment);
      }

      // Audio
      if (msg.audio) {
        const attachment = await this.downloadTelegramFile(
          msg.audio.file_id,
          channelId,
          (msg.audio as any).file_name || "audio.mp3",
          msg.audio.mime_type,
        );
        if (attachment) attachments.push(attachment);
      }

      // Video
      if (msg.video) {
        const attachment = await this.downloadTelegramFile(
          msg.video.file_id,
          channelId,
          (msg.video as any).file_name || "video.mp4",
          msg.video.mime_type,
        );
        if (attachment) attachments.push(attachment);
      }

      // Voice
      if (msg.voice) {
        const attachment = await this.downloadTelegramFile(
          msg.voice.file_id,
          channelId,
          "voice.ogg",
          msg.voice.mime_type || "audio/ogg",
        );
        if (attachment) attachments.push(attachment);
      }
    } catch (err) {
      console.error("[Telegram] Error extracting attachments:", err);
    }

    return attachments;
  }

  /**
   * Download a file from Telegram and save it locally.
   */
  private async downloadTelegramFile(
    fileId: string,
    channelId: string,
    filename: string,
    mimeType?: string,
  ): Promise<ChannelAttachment | null> {
    if (!this.bot) return null;

    try {
      const fileLink = await this.bot.getFileLink(fileId);
      return await downloadAndSaveAttachment(
        this.rootDir,
        channelId,
        fileLink,
        filename,
        mimeType,
      );
    } catch (err) {
      console.error(`[Telegram] Failed to download file ${fileId}:`, err);
      return null;
    }
  }

  /**
   * Send a file to the Telegram chat.
   */
  private async sendFileSafe(
    chatId: number,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.bot) return;

    try {
      if (!fs.existsSync(filePath)) {
        console.error(`[Telegram] File not found for sending: ${filePath}`);
        return;
      }
      await this.bot.sendDocument(chatId, filePath, {
        caption: caption || undefined,
      });
    } catch (err) {
      console.error("[Telegram] Failed to send file:", err);
    }
  }
}
