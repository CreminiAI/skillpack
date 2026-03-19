import TelegramBot from "node-telegram-bot-api";

import type {
  PlatformAdapter,
  AdapterContext,
  AgentEvent,
  BotCommand,
  IPackAgent,
} from "./types.js";

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
// Markdown → Telegram MarkdownV2 escaping
// ---------------------------------------------------------------------------

/**
 * Escape special characters for Telegram MarkdownV2.
 * Reference: https://core.telegram.org/bots/api#markdownv2-style
 */
function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/**
 * Attempt basic conversion from standard markdown to Telegram MarkdownV2.
 * Falls back to plain text on complex formatting.
 */
function toTelegramFormat(text: string): string {
  try {
    // For now, just escape the text for MarkdownV2.
    // Complex markdown conversion can be enhanced later.
    return escapeMarkdownV2(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// TelegramAdapter
// ---------------------------------------------------------------------------

export class TelegramAdapter implements PlatformAdapter {
  readonly name = "telegram";

  private bot: TelegramBot | null = null;
  private agent: IPackAgent | null = null;
  private options: TelegramAdapterOptions;

  constructor(options: TelegramAdapterOptions) {
    this.options = options;
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.agent = ctx.agent;

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
  // Message handler
  // -------------------------------------------------------------------------

  private async handleTelegramMessage(msg: TelegramBot.Message) {
    if (!this.bot || !this.agent) return;

    const chatId = msg.chat.id;
    const messageId = msg.message_id;
    const text = msg.text?.trim();
    if (!text) return;

    const channelId = `telegram-${chatId}`;

    await this.tryAckReaction(chatId, messageId);

    // --- Command handling ---
    const commandKey = text.split(/\s/)[0].toLowerCase();
    const command = COMMANDS[commandKey];

    if (command) {
      const result = await this.agent.handleCommand(command, channelId);
      await this.sendSafe(chatId, result.message || `/${command} executed.`);
      return;
    }

    // --- Regular message → agent ---
    // Send a "thinking" indicator
    await this.bot.sendChatAction(chatId, "typing");

    let finalText = "";
    let hasError = false;
    let errorMessage = "";

    const onEvent = (event: AgentEvent) => {
      // Only collect final text; skip thinking/tool intermediate events
      switch (event.type) {
        case "text_delta":
          finalText += event.delta;
          break;
        // We intentionally ignore thinking_delta, tool_start, tool_end
      }
    };

    try {
      const result = await this.agent.handleMessage(channelId, text, onEvent);

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

    if (!finalText.trim()) {
      await this.sendSafe(chatId, "(No response generated)");
      return;
    }

    // Split and send the final text
    await this.sendLongMessage(chatId, finalText);
  }

  // -------------------------------------------------------------------------
  // Send helpers
  // -------------------------------------------------------------------------

  /**
   * Send a message, splitting into chunks if too long.
   */
  private async sendLongMessage(chatId: number, text: string): Promise<void> {
    // Try to send as plain text first (more reliable than MarkdownV2 for complex content)
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
        await this.bot!.sendMessage(chatId, text);
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
}
