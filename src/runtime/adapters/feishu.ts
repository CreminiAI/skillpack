import fs from "node:fs";
import path from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";
import type {
  NormalizedMessage,
} from "@larksuiteoapi/node-sdk";

import type {
  AdapterContext,
  AgentEvent,
  BotCommand,
  ChannelAttachment,
  IPackAgent,
  IpcBroadcaster,
  MessageSender,
  PlatformAdapter,
} from "./types.js";
import {
  createResilientLarkChannel,
  type ResilientLarkChannel,
} from "./resilient-lark-channel.js";
import { isImageMime, saveAttachment } from "./attachment-utils.js";
import { resolveCommand } from "../commands/index.js";
import { detectMimeType } from "../files/metadata.js";

export interface FeishuAdapterOptions {
  appId: string;
  appSecret: string;
  domain?: "feishu" | "lark";
}

export type FeishuMessageHandlingDecision =
  | { action: "ignore" }
  | { action: "unsupported" }
  | { action: "handle"; text: string };

const MAX_MESSAGE_LENGTH = 1800;
const ACK_REACTION = "THUMBSUP";
const UNSUPPORTED_MESSAGE_REPLY =
  "Only text messages are currently supported. Please send plain text.";
const FILE_DELIVERY_FAILED_REPLY =
  "A file was generated, but Feishu could not deliver it.";
const IMAGE_DOWNLOAD_FAILED_REPLY =
  "The image could not be downloaded from Feishu.";
const IMAGE_MESSAGE_TEXT = "(User sent an image)";

export function normalizeFeishuDomain(
  domain: unknown,
): "feishu" | "lark" {
  return domain === "lark" ? "lark" : "feishu";
}

export function resolveFeishuSdkDomain(
  domain: unknown,
): Lark.Domain {
  return normalizeFeishuDomain(domain) === "lark"
    ? Lark.Domain.Lark
    : Lark.Domain.Feishu;
}

export function parseFeishuChannelId(channelId: string): string {
  if (!channelId.startsWith("feishu-")) {
    throw new Error(`[Feishu] Invalid channelId: ${channelId}`);
  }

  const chatId = channelId.replace("feishu-", "").trim();
  if (!chatId) {
    throw new Error(`[Feishu] Invalid channelId: ${channelId}`);
  }
  return chatId;
}

export function normalizeFeishuMessage(
  message: Pick<
    NormalizedMessage,
    "chatType" | "mentionedBot" | "rawContentType" | "content" | "resources"
  >,
): FeishuMessageHandlingDecision {
  if (message.chatType === "group" && !message.mentionedBot) {
    return { action: "ignore" };
  }

  const hasImageResource = message.resources.some(
    (resource) => resource.type === "image",
  );

  if (message.rawContentType !== "text" && !hasImageResource) {
    return { action: "unsupported" };
  }

  const text = message.rawContentType === "text" ? message.content.trim() : "";
  if (!text) {
    if (hasImageResource) {
      return {
        action: "handle",
        text: IMAGE_MESSAGE_TEXT,
      };
    }
    return { action: "ignore" };
  }

  return {
    action: "handle",
    text,
  };
}

export class FeishuAdapter implements PlatformAdapter, MessageSender {
  readonly name = "feishu";

  private channel: ResilientLarkChannel | null = null;
  private agent: IPackAgent | null = null;
  private ipcBroadcaster: IpcBroadcaster | null = null;
  private rootDir = process.cwd();
  private readonly options: FeishuAdapterOptions;

  constructor(options: FeishuAdapterOptions) {
    this.options = options;
  }

  async start(ctx: AdapterContext): Promise<void> {
    this.agent = ctx.agent;
    this.ipcBroadcaster = ctx.ipcBroadcaster ?? null;
    this.rootDir = ctx.rootDir;
    const domain = normalizeFeishuDomain(this.options.domain);

    this.channel = createResilientLarkChannel({
      appId: this.options.appId,
      appSecret: this.options.appSecret,
      domain: resolveFeishuSdkDomain(domain),
      loggerLevel: Lark.LoggerLevel.info,
      transport: "websocket",
      source: "skillpack",
      policy: {
        dmMode: "open",
        requireMention: false,
      },
    });

    this.channel.on("message", (message) => {
      void this.handleIncomingMessage(message).catch((error) => {
        console.error("[Feishu] Error handling message:", error);
      });
    });

    this.channel.on("error", (error) => {
      console.error("[Feishu] Channel error:", error);
    });

    this.channel.on("reconnecting", () => {
      console.warn("[Feishu] Channel reconnecting");
    });

    this.channel.on("reconnected", () => {
      console.log("[Feishu] Channel reconnected");
    });

    await this.channel.connect();
    const botName = this.channel.botIdentity?.name;
    console.log(
      botName
        ? `[FeishuAdapter] Started as ${botName} (domain=${domain})`
        : `[FeishuAdapter] Started (domain=${domain})`,
    );
  }

  async stop(): Promise<void> {
    if (this.channel) {
      await this.channel.disconnect();
      this.channel = null;
    }
    console.log("[FeishuAdapter] Stopped");
  }

  async sendMessage(channelId: string, text: string): Promise<void> {
    if (!this.channel) {
      throw new Error("[Feishu] Channel not initialized");
    }

    const chatId = parseFeishuChannelId(channelId);
    await this.sendLongMessage(chatId, text);
  }

  async sendFile(
    channelId: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.channel) {
      throw new Error("[Feishu] Channel not initialized");
    }

    const chatId = parseFeishuChannelId(channelId);
    const sent = await this.sendFileSafe(chatId, filePath, caption);
    if (!sent) {
      throw new Error(`[Feishu] Failed to send file: ${filePath}`);
    }
  }

  private async handleIncomingMessage(message: NormalizedMessage): Promise<void> {
    if (!this.channel || !this.agent) {
      return;
    }

    const decision = normalizeFeishuMessage(message);
    if (decision.action === "ignore") {
      return;
    }

    await this.tryAckReaction(message.messageId);

    const channelId = `feishu-${message.chatId}`;
    if (decision.action === "unsupported") {
      await this.sendSafe(message.chatId, UNSUPPORTED_MESSAGE_REPLY, message.messageId);
      return;
    }

    const userText = decision.text;
    const attachments = await this.extractImageAttachments(message, channelId);
    if (
      userText === IMAGE_MESSAGE_TEXT &&
      this.hasImageResources(message) &&
      attachments.length === 0
    ) {
      await this.sendSafe(message.chatId, IMAGE_DOWNLOAD_FAILED_REPLY, message.messageId);
      return;
    }

    this.ipcBroadcaster?.broadcastInbound(
      channelId,
      "feishu",
      {
        id: message.senderId,
        username: message.senderName || message.senderId,
      },
      userText,
    );

    const command = this.resolveCommand(userText);
    if (command) {
      const result = await this.agent.handleCommand(command, channelId);
      await this.sendSafe(
        message.chatId,
        result.message || `/${command} executed.`,
        message.messageId,
      );
      return;
    }

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
      this.ipcBroadcaster?.broadcastAgentEvent(channelId, event);
    };

    try {
      const result = await this.agent.handleMessage(
        "feishu",
        channelId,
        userText,
        onEvent,
        attachments.length > 0 ? attachments : undefined,
      );

      if (result.errorMessage) {
        hasError = true;
        errorMessage = result.errorMessage;
      }
    } catch (error) {
      hasError = true;
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    if (hasError) {
      await this.sendSafe(message.chatId, `Error: ${errorMessage}`, message.messageId);
      return;
    }

    if (finalText.trim()) {
      await this.sendLongMessage(message.chatId, finalText, message.messageId);
    } else if (pendingFiles.length === 0) {
      await this.sendSafe(message.chatId, "(No response generated)", message.messageId);
    }

    let sentFileCount = 0;
    for (const file of pendingFiles) {
      if (await this.sendFileSafe(
        message.chatId,
        file.filePath,
        file.caption,
        message.messageId,
      )) {
        sentFileCount += 1;
      }
    }

    if (pendingFiles.length > 0 && sentFileCount === 0) {
      await this.sendSafe(
        message.chatId,
        FILE_DELIVERY_FAILED_REPLY,
        message.messageId,
      );
    }
  }

  private resolveCommand(text: string): BotCommand | null {
    return resolveCommand(text);
  }

  private async sendLongMessage(
    chatId: string,
    text: string,
    replyTo?: string,
  ): Promise<void> {
    for (const chunk of this.splitMessage(text)) {
      await this.sendSafe(chatId, chunk, replyTo);
    }
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

  private async tryAckReaction(messageId: string): Promise<void> {
    if (!this.channel) {
      return;
    }

    try {
      await this.channel.addReaction(messageId, ACK_REACTION);
    } catch (error) {
      console.error("[Feishu] Failed to add ack reaction:", error);
    }
  }

  private hasImageResources(message: NormalizedMessage): boolean {
    return message.resources.some((resource) => resource.type === "image");
  }

  private async extractImageAttachments(
    message: NormalizedMessage,
    channelId: string,
  ): Promise<ChannelAttachment[]> {
    if (!this.channel) {
      return [];
    }

    const imageResources = message.resources.filter(
      (resource) => resource.type === "image",
    );
    const attachments: ChannelAttachment[] = [];

    for (const [index, resource] of imageResources.entries()) {
      try {
        const buffer = await this.channel.downloadResource(
          resource.fileKey,
          "image",
        );
        const filename = resource.fileName?.trim() || `image-${index + 1}.png`;
        attachments.push(
          await saveAttachment(
            this.rootDir,
            channelId,
            filename,
            buffer,
            detectMimeType(filename) || "image/png",
          ),
        );
      } catch (error) {
        console.error(
          `[Feishu] Failed to download image ${resource.fileKey}:`,
          error,
        );
      }
    }

    return attachments;
  }

  private async sendFileSafe(
    chatId: string,
    filePath: string,
    caption?: string,
    replyTo?: string,
  ): Promise<boolean> {
    if (!this.channel) {
      return false;
    }

    try {
      if (!fs.existsSync(filePath)) {
        console.error(`[Feishu] File not found for sending: ${filePath}`);
        return false;
      }

      if (caption?.trim()) {
        await this.sendSafe(chatId, caption, replyTo);
      }

      const mimeType = detectMimeType(filePath);
      if (isImageMime(mimeType)) {
        await this.channel.send(
          chatId,
          {
            image: {
              source: filePath,
            },
          },
          replyTo ? { replyTo } : undefined,
        );
        return true;
      }

      await this.channel.send(
        chatId,
        {
          file: {
            source: filePath,
            fileName: path.basename(filePath),
          },
        },
        replyTo ? { replyTo } : undefined,
      );
      return true;
    } catch (error) {
      console.error("[Feishu] Failed to send file:", error);
      return false;
    }
  }

  private async sendSafe(
    chatId: string,
    text: string,
    replyTo?: string,
  ): Promise<void> {
    if (!this.channel) {
      return;
    }

    try {
      await this.channel.send(
        chatId,
        { markdown: text },
        replyTo ? { replyTo } : undefined,
      );
    } catch (error) {
      console.error("[Feishu] Failed to send message:", error);
    }
  }
}
