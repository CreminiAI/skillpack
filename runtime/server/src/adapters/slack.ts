import { App, LogLevel } from "@slack/bolt";

import type {
  PlatformAdapter,
  AdapterContext,
  AgentEvent,
  BotCommand,
  IPackAgent,
} from "./types.js";
import { formatSlackMessage } from "./markdown.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SlackAdapterOptions {
  botToken: string;
  appToken: string;
}

const INLINE_COMMANDS: Record<string, BotCommand> = {
  "/clear": "clear",
  "/restart": "restart",
  "/shutdown": "shutdown",
};

const SLASH_COMMANDS: Record<string, BotCommand> = {
  "/skillpack-clear": "clear",
  "/skillpack-restart": "restart",
  "/skillpack-shutdown": "shutdown",
};

const MAX_MESSAGE_LENGTH = 3500;
const ACK_REACTION = "eyes";

interface SlackRoute {
  channel: string;
  threadTs?: string;
}

// ---------------------------------------------------------------------------
// SlackAdapter
// ---------------------------------------------------------------------------

export class SlackAdapter implements PlatformAdapter {
  readonly name = "slack";

  private app: App | null = null;
  private agent: IPackAgent | null = null;
  private readonly options: SlackAdapterOptions;
  private botUserId: string | null = null;
  private lastThreadByChannel = new Map<string, string>();

  constructor(options: SlackAdapterOptions) {
    this.options = options;
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.agent = ctx.agent;

    this.app = new App({
      token: this.options.botToken,
      appToken: this.options.appToken,
      socketMode: true,
      ignoreSelf: true,
      logLevel: LogLevel.INFO,
    });

    const auth = await this.app.client.auth.test({
      token: this.options.botToken,
    });
    this.botUserId =
      typeof auth.user_id === "string" ? auth.user_id : null;

    this.registerListeners(this.app);
    await this.app.start();

    const identity = this.botUserId ? `<@${this.botUserId}>` : "Slack bot";
    console.log(`[SlackAdapter] Started as ${identity}`);
  }

  async stop(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      this.app = null;
    }
    console.log("[SlackAdapter] Stopped");
  }

  // -------------------------------------------------------------------------
  // Listener registration
  // -------------------------------------------------------------------------

  private registerListeners(app: App): void {
    app.event("message", async (args: any) => {
      try {
        await this.handleDirectMessage(args);
      } catch (err) {
        console.error("[Slack] Error handling DM:", err);
      }
    });

    app.event("app_mention", async (args: any) => {
      try {
        await this.handleMention(args);
      } catch (err) {
        console.error("[Slack] Error handling mention:", err);
      }
    });

    for (const commandName of Object.keys(SLASH_COMMANDS)) {
      app.command(commandName, async (args: any) => {
        try {
          await this.handleSlashCommand(args);
        } catch (err) {
          console.error(`[Slack] Error handling ${commandName}:`, err);
          await this.safeAck(
            args.ack,
            `❌ Error: ${this.getErrorMessage(err)}`,
          );
        }
      });
    }
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  private async handleDirectMessage({
    event,
    body,
    context,
    client,
  }: any): Promise<void> {
    if (!this.agent || !this.isSupportedDmEvent(event)) {
      return;
    }

    const text = (event.text || "").trim();
    if (!text) return;

    const teamId = this.getTeamId(body, context);
    const channelId = `slack-dm-${teamId}-${event.channel}`;
    const route: SlackRoute = { channel: event.channel };

    await this.tryAckReaction(client, event);

    if (await this.tryHandleInlineCommand(text, channelId, client, route)) {
      return;
    }

    await this.runAgent(channelId, text, client, route);
  }

  private async handleMention({
    event,
    body,
    context,
    client,
  }: any): Promise<void> {
    if (!this.agent || !this.isSupportedMentionEvent(event)) {
      return;
    }

    const teamId = this.getTeamId(body, context);
    const threadTs = event.thread_ts || event.ts;
    const channelId =
      `slack-thread-${teamId}-${event.channel}-${threadTs}`;
    const route: SlackRoute = {
      channel: event.channel,
      threadTs,
    };

    this.lastThreadByChannel.set(
      this.getChannelKey(teamId, event.channel),
      threadTs,
    );

    const text = this.stripBotMention(event.text || "").trim();
    if (!text) {
      await this.sendSafe(
        client,
        route,
        "Mention me with a message, or use `/clear` to reset this thread.",
      );
      return;
    }

    await this.tryAckReaction(client, event);

    if (await this.tryHandleInlineCommand(text, channelId, client, route)) {
      return;
    }

    await this.runAgent(channelId, text, client, route);
  }

  private async handleSlashCommand({
    command,
    body,
    context,
    ack,
  }: any): Promise<void> {
    const commandName = command?.command;
    const mapped = commandName ? SLASH_COMMANDS[commandName] : undefined;

    if (!this.agent || !mapped) {
      await this.safeAck(ack, "Unsupported slash command.");
      return;
    }

    const resolved = this.resolveSlashCommandTarget(body || command, context);
    if (!resolved.channelId) {
      await this.safeAck(ack, resolved.message);
      return;
    }

    const result = await this.agent.handleCommand(mapped, resolved.channelId);

    const parts = [result.message || `${commandName} executed.`];
    if (resolved.note) {
      parts.push(resolved.note);
    }

    await this.safeAck(ack, parts.join("\n"));
  }

  // -------------------------------------------------------------------------
  // Agent bridge
  // -------------------------------------------------------------------------

  private async runAgent(
    channelId: string,
    text: string,
    client: any,
    route: SlackRoute,
  ): Promise<void> {
    if (!this.agent) return;

    let finalText = "";
    let hasError = false;
    let errorMessage = "";

    const onEvent = (event: AgentEvent) => {
      if (event.type === "text_delta") {
        finalText += event.delta;
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
      errorMessage = this.getErrorMessage(err);
    }

    if (hasError) {
      await this.sendSafe(client, route, `❌ Error: ${errorMessage}`);
      return;
    }

    if (!finalText.trim()) {
      await this.sendSafe(client, route, "(No response generated)");
      return;
    }

    await this.sendLongMessage(client, route, finalText);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async tryHandleInlineCommand(
    text: string,
    channelId: string,
    client: any,
    route: SlackRoute,
  ): Promise<boolean> {
    if (!this.agent) return false;

    const commandKey = text.split(/\s/)[0].toLowerCase();
    const command = INLINE_COMMANDS[commandKey];
    if (!command) return false;

    const result = await this.agent.handleCommand(command, channelId);
    await this.sendSafe(
      client,
      route,
      result.message || `${commandKey} executed.`,
    );
    return true;
  }

  private resolveSlashCommandTarget(
    payload: any,
    context: any,
  ): { channelId?: string; message: string; note?: string } {
    const teamId = this.getTeamId(payload, context);
    const channel = payload?.channel_id;

    if (!channel) {
      return { message: "Missing Slack channel context." };
    }

    if (this.isDmChannelId(channel)) {
      return {
        channelId: `slack-dm-${teamId}-${channel}`,
        message: "",
      };
    }

    const threadTs = this.lastThreadByChannel.get(
      this.getChannelKey(teamId, channel),
    );
    if (!threadTs) {
      return {
        message:
          "No active Skillpack thread found in this channel. Mention the bot first, or run the command inside the thread as `@bot /clear`.",
      };
    }

    return {
      channelId: `slack-thread-${teamId}-${channel}-${threadTs}`,
      message: "",
      note:
        "Applied to the most recent active Skillpack thread in this channel.",
    };
  }

  private isSupportedDmEvent(event: any): boolean {
    if (!event || event.type !== "message") return false;
    if (event.channel_type !== "im") return false;
    if (event.subtype) return false;
    if (event.bot_id) return false;
    if (!event.user || typeof event.text !== "string") return false;
    return true;
  }

  private isSupportedMentionEvent(event: any): boolean {
    if (!event || event.type !== "app_mention") return false;
    if (event.subtype) return false;
    if (event.bot_id) return false;
    if (!event.user || typeof event.text !== "string") return false;
    return true;
  }

  private stripBotMention(text: string): string {
    const mention =
      this.botUserId
        ? new RegExp(`^\\s*<@${this.escapeRegExp(this.botUserId)}>\\s*`)
        : /^\s*<@[^>]+>\s*/;
    return text.replace(mention, "");
  }

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

  private async sendLongMessage(
    client: any,
    route: SlackRoute,
    text: string,
  ): Promise<void> {
    for (const chunk of this.splitMessage(text)) {
      await this.sendWithRetry(client, route, chunk);
    }
  }

  private async sendSafe(
    client: any,
    route: SlackRoute,
    text: string,
  ): Promise<void> {
    try {
      await this.sendWithRetry(client, route, text);
    } catch (err) {
      console.error("[Slack] Failed to send message:", err);
    }
  }

  private async sendWithRetry(
    client: any,
    route: SlackRoute,
    text: string,
    maxRetries = 3,
  ): Promise<void> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await client.chat.postMessage({
          channel: route.channel,
          text: formatSlackMessage(text),
          mrkdwn: true,
          thread_ts: route.threadTs,
          reply_broadcast: false,
        });
        return;
      } catch (err: any) {
        const retryAfter = this.getRetryAfterSeconds(err);
        if (retryAfter && attempt < maxRetries) {
          console.log(
            `[Slack] Rate limited, retrying after ${retryAfter}s...`,
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

  private async tryAckReaction(client: any, event: any): Promise<void> {
    try {
      await client.reactions.add({
        channel: event.channel,
        timestamp: event.ts,
        name: ACK_REACTION,
      });
    } catch (err) {
      console.error("[Slack] Failed to add ack reaction:", err);
    }
  }

  private async safeAck(
    ack: ((response?: string) => Promise<void>) | undefined,
    message: string,
  ): Promise<void> {
    if (!ack) return;
    try {
      await ack(message);
    } catch (err) {
      console.error("[Slack] Failed to ack slash command:", err);
    }
  }

  private getRetryAfterSeconds(err: any): number | null {
    const candidates = [
      err?.data?.retryAfter,
      err?.retryAfter,
      err?.headers?.["retry-after"],
      err?.data?.headers?.["retry-after"],
    ];

    for (const value of candidates) {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > 0) {
        return seconds;
      }
    }

    return null;
  }

  private getTeamId(payload: any, context: any): string {
    return (
      context?.teamId ||
      payload?.team_id ||
      payload?.team?.id ||
      payload?.authorizations?.[0]?.team_id ||
      "unknown"
    );
  }

  private getChannelKey(teamId: string, channelId: string): string {
    return `${teamId}:${channelId}`;
  }

  private isDmChannelId(channelId: string): boolean {
    return channelId.startsWith("D");
  }

  private getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
