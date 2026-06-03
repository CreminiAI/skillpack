import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  FeishuAdapter,
  normalizeFeishuMessage,
  normalizeFeishuDomain,
  parseFeishuChannelId,
  resolveFeishuSdkDomain,
} from "../src/runtime/adapters/feishu.js";
import * as Lark from "@larksuiteoapi/node-sdk";

test("parseFeishuChannelId extracts chat id", () => {
  assert.equal(parseFeishuChannelId("feishu-oc_123"), "oc_123");
});

test("normalizeFeishuDomain defaults to feishu", () => {
  assert.equal(normalizeFeishuDomain(undefined), "feishu");
  assert.equal(normalizeFeishuDomain("unexpected"), "feishu");
});

test("normalizeFeishuDomain accepts lark", () => {
  assert.equal(normalizeFeishuDomain("lark"), "lark");
});

test("resolveFeishuSdkDomain maps supported domains", () => {
  assert.equal(resolveFeishuSdkDomain(undefined), Lark.Domain.Feishu);
  assert.equal(resolveFeishuSdkDomain("feishu"), Lark.Domain.Feishu);
  assert.equal(resolveFeishuSdkDomain("lark"), Lark.Domain.Lark);
});

test("normalizeFeishuMessage handles direct text messages", () => {
  assert.deepEqual(
    normalizeFeishuMessage({
      chatType: "p2p",
      mentionedBot: false,
      rawContentType: "text",
      content: "hello from feishu",
      resources: [],
    }),
    {
      action: "handle",
      text: "hello from feishu",
    },
  );
});

test("normalizeFeishuMessage ignores group messages without bot mention", () => {
  assert.deepEqual(
    normalizeFeishuMessage({
      chatType: "group",
      mentionedBot: false,
      rawContentType: "text",
      content: "hello group",
      resources: [],
    }),
    {
      action: "ignore",
    },
  );
});

test("normalizeFeishuMessage accepts mentioned group text", () => {
  assert.deepEqual(
    normalizeFeishuMessage({
      chatType: "group",
      mentionedBot: true,
      rawContentType: "text",
      content: "summarize this thread",
      resources: [],
    }),
    {
      action: "handle",
      text: "summarize this thread",
    },
  );
});

test("normalizeFeishuMessage accepts image messages", () => {
  assert.deepEqual(
    normalizeFeishuMessage({
      chatType: "p2p",
      mentionedBot: false,
      rawContentType: "image",
      content: "",
      resources: [{ type: "image", fileKey: "img_key" }],
    }),
    {
      action: "handle",
      text: "(User sent an attachment)",
    },
  );
});

test("normalizeFeishuMessage accepts file messages", () => {
  assert.deepEqual(
    normalizeFeishuMessage({
      chatType: "p2p",
      mentionedBot: false,
      rawContentType: "file",
      content: "",
      resources: [{ type: "file", fileKey: "file_key", fileName: "report.pdf" }],
    }),
    {
      action: "handle",
      text: "(User sent an attachment)",
    },
  );
});

test("normalizeFeishuMessage returns fallback for unsupported resources", () => {
  assert.deepEqual(
    normalizeFeishuMessage({
      chatType: "p2p",
      mentionedBot: false,
      rawContentType: "audio",
      content: "",
      resources: [{ type: "audio", fileKey: "audio_key" }],
    }),
    {
      action: "unsupported",
    },
  );
});

test("FeishuAdapter downloads inbound images for the agent", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-adapter-"));
  const imageBuffer = Buffer.from("fake image body");

  try {
    const resourceCalls: Array<{
      path: { message_id: string; file_key: string };
      params: { type: string };
    }> = [];
    const sendCalls: Array<{
      chatId: string;
      input: unknown;
      opts?: { replyTo?: string };
    }> = [];
    let handled: {
      platform: string;
      channelId: string;
      text: string;
      attachments?: Array<{
        filename: string;
        localPath: string;
        mimeType?: string;
        size?: number;
      }>;
    } | null = null;

    const adapter = new FeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
    });

    (adapter as any).rootDir = tempDir;
    (adapter as any).channel = {
      addReaction: async () => "reaction-id",
      rawClient: {
        im: {
          v1: {
            messageResource: {
              get: async (payload: {
                path: { message_id: string; file_key: string };
                params: { type: string };
              }) => {
                resourceCalls.push(payload);
                return {
                  getReadableStream: () => Readable.from([imageBuffer]),
                };
              },
            },
          },
        },
      },
      send: async (
        chatId: string,
        input: unknown,
        opts?: { replyTo?: string },
      ) => {
        sendCalls.push({ chatId, input, opts });
        return { messageId: "outbound-message" };
      },
    };

    (adapter as any).agent = {
      handleMessage: async (
        platform: string,
        channelId: string,
        text: string,
        onEvent: (event: any) => void,
        attachments?: any[],
      ) => {
        handled = { platform, channelId, text, attachments };
        onEvent({ type: "text_delta", delta: "image received" });
        return { stopReason: "completed" };
      },
      handleCommand: async () => ({ success: true }),
      abort: () => {},
      isRunning: () => false,
      dispose: () => {},
      listSessions: () => [],
      restoreSession: async () => {},
      getActiveChannelIds: () => [],
      getAuthStorage: () => null,
      updateAuth: () => {},
    };

    await (adapter as any).handleIncomingMessage({
      messageId: "om_image",
      chatId: "oc_image_chat",
      chatType: "p2p",
      senderId: "ou_789",
      senderName: "alice",
      content: "",
      rawContentType: "image",
      resources: [{ type: "image", fileKey: "img_key", fileName: "chart.png" }],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: 0,
    });

    assert.deepEqual(resourceCalls, [
      {
        path: { message_id: "om_image", file_key: "img_key" },
        params: { type: "image" },
      },
    ]);
    assert.equal(handled?.platform, "feishu");
    assert.equal(handled?.channelId, "feishu-oc_image_chat");
    assert.equal(handled?.text, "(User sent an attachment)");
    assert.equal(handled?.attachments?.length, 1);
    assert.equal(handled?.attachments?.[0]?.filename, "chart.png");
    assert.equal(handled?.attachments?.[0]?.mimeType, "image/png");
    assert.equal(handled?.attachments?.[0]?.size, imageBuffer.byteLength);
    assert.equal(
      fs.readFileSync(handled!.attachments![0]!.localPath, "utf-8"),
      "fake image body",
    );
    assert.deepEqual(sendCalls, [
      {
        chatId: "oc_image_chat",
        input: { markdown: "image received" },
        opts: { replyTo: "om_image" },
      },
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("FeishuAdapter downloads inbound files for the agent", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-adapter-"));
  const fileBuffer = Buffer.from("quarterly report");

  try {
    const resourceCalls: Array<{
      path: { message_id: string; file_key: string };
      params: { type: string };
    }> = [];
    let handled: {
      platform: string;
      channelId: string;
      text: string;
      attachments?: Array<{
        filename: string;
        localPath: string;
        mimeType?: string;
        size?: number;
      }>;
    } | null = null;

    const adapter = new FeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
    });

    (adapter as any).rootDir = tempDir;
    (adapter as any).channel = {
      addReaction: async () => "reaction-id",
      rawClient: {
        im: {
          v1: {
            messageResource: {
              get: async (payload: {
                path: { message_id: string; file_key: string };
                params: { type: string };
              }) => {
                resourceCalls.push(payload);
                return {
                  getReadableStream: () => Readable.from([fileBuffer]),
                };
              },
            },
          },
        },
      },
      send: async () => ({ messageId: "outbound-message" }),
    };

    (adapter as any).agent = {
      handleMessage: async (
        platform: string,
        channelId: string,
        text: string,
        _onEvent: (event: any) => void,
        attachments?: any[],
      ) => {
        handled = { platform, channelId, text, attachments };
        return { stopReason: "completed" };
      },
      handleCommand: async () => ({ success: true }),
      abort: () => {},
      isRunning: () => false,
      dispose: () => {},
      listSessions: () => [],
      restoreSession: async () => {},
      getActiveChannelIds: () => [],
      getAuthStorage: () => null,
      updateAuth: () => {},
    };

    await (adapter as any).handleIncomingMessage({
      messageId: "om_file",
      chatId: "oc_file_chat",
      chatType: "p2p",
      senderId: "ou_789",
      senderName: "alice",
      content: "",
      rawContentType: "file",
      resources: [{ type: "file", fileKey: "file_key", fileName: "report.txt" }],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: 0,
    });

    assert.deepEqual(resourceCalls, [
      {
        path: { message_id: "om_file", file_key: "file_key" },
        params: { type: "file" },
      },
    ]);
    assert.equal(handled?.platform, "feishu");
    assert.equal(handled?.channelId, "feishu-oc_file_chat");
    assert.equal(handled?.text, "(User sent an attachment)");
    assert.equal(handled?.attachments?.length, 1);
    assert.equal(handled?.attachments?.[0]?.filename, "report.txt");
    assert.equal(handled?.attachments?.[0]?.mimeType, "text/plain");
    assert.equal(handled?.attachments?.[0]?.size, fileBuffer.byteLength);
    assert.equal(
      fs.readFileSync(handled!.attachments![0]!.localPath, "utf-8"),
      "quarterly report",
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("FeishuAdapter replies when inbound attachment download fails", async () => {
  const sendCalls: Array<{
    chatId: string;
    input: unknown;
    opts?: { replyTo?: string };
  }> = [];
  const consoleErrors: unknown[][] = [];
  const originalConsoleError = console.error;
  let handled = false;

  console.error = (...args: unknown[]) => {
    consoleErrors.push(args);
  };

  try {
    const adapter = new FeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
    });

    (adapter as any).channel = {
      addReaction: async () => "reaction-id",
      rawClient: {
        im: {
          v1: {
            messageResource: {
              get: async () => {
                throw new Error("download failed");
              },
            },
          },
        },
      },
      send: async (
        chatId: string,
        input: unknown,
        opts?: { replyTo?: string },
      ) => {
        sendCalls.push({ chatId, input, opts });
        return { messageId: "outbound-message" };
      },
    };

    (adapter as any).agent = {
      handleMessage: async () => {
        handled = true;
        return { stopReason: "completed" };
      },
      handleCommand: async () => ({ success: true }),
      abort: () => {},
      isRunning: () => false,
      dispose: () => {},
      listSessions: () => [],
      restoreSession: async () => {},
      getActiveChannelIds: () => [],
      getAuthStorage: () => null,
      updateAuth: () => {},
    };

    await (adapter as any).handleIncomingMessage({
      messageId: "om_file",
      chatId: "oc_file_chat",
      chatType: "p2p",
      senderId: "ou_789",
      senderName: "alice",
      content: "",
      rawContentType: "file",
      resources: [{ type: "file", fileKey: "file_key", fileName: "report.pdf" }],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: 0,
    });

    assert.equal(handled, false);
    assert.match(String(consoleErrors[0]?.[0]), /Failed to download file/);
    assert.deepEqual(sendCalls, [
      {
        chatId: "oc_file_chat",
        input: { markdown: "The attachment could not be downloaded from Feishu." },
        opts: { replyTo: "om_file" },
      },
    ]);
  } finally {
    console.error = originalConsoleError;
  }
});

test("FeishuAdapter adds an ack reaction and sends generated files", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-adapter-"));
  const filePath = path.join(tempDir, "report.txt");
  fs.writeFileSync(filePath, "report body");

  try {
    const sendCalls: Array<{
      chatId: string;
      input: unknown;
      opts?: { replyTo?: string };
    }> = [];
    const reactionCalls: Array<{ messageId: string; emojiType: string }> = [];

    const adapter = new FeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
    });

    (adapter as any).channel = {
      addReaction: async (messageId: string, emojiType: string) => {
        reactionCalls.push({ messageId, emojiType });
        return "reaction-id";
      },
      send: async (
        chatId: string,
        input: unknown,
        opts?: { replyTo?: string },
      ) => {
        sendCalls.push({ chatId, input, opts });
        return { messageId: "outbound-message" };
      },
    };

    (adapter as any).agent = {
      handleMessage: async (
        _platform: string,
        _channelId: string,
        _text: string,
        onEvent: (event: any) => void,
      ) => {
        onEvent({
          type: "file_output",
          filePath,
          filename: "report.txt",
          caption: "Generated report",
        });
        return { stopReason: "completed" };
      },
      handleCommand: async () => ({ success: true }),
      abort: () => {},
      isRunning: () => false,
      dispose: () => {},
      listSessions: () => [],
      restoreSession: async () => {},
      getActiveChannelIds: () => [],
      getAuthStorage: () => null,
      updateAuth: () => {},
    };

    await (adapter as any).handleIncomingMessage({
      messageId: "om_123",
      chatId: "oc_456",
      chatType: "p2p",
      senderId: "ou_789",
      senderName: "alice",
      content: "please export the report",
      rawContentType: "text",
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: 0,
    });

    assert.deepEqual(reactionCalls, [
      { messageId: "om_123", emojiType: "THUMBSUP" },
    ]);
    assert.deepEqual(sendCalls, [
      {
        chatId: "oc_456",
        input: { markdown: "Generated report" },
        opts: { replyTo: "om_123" },
      },
      {
        chatId: "oc_456",
        input: {
          file: {
            source: filePath,
            fileName: "report.txt",
          },
        },
        opts: { replyTo: "om_123" },
      },
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("FeishuAdapter sends generated images as image messages", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-adapter-"));
  const filePath = path.join(tempDir, "chart.png");
  fs.writeFileSync(filePath, "image body");

  try {
    const sendCalls: Array<{
      chatId: string;
      input: unknown;
      opts?: { replyTo?: string };
    }> = [];

    const adapter = new FeishuAdapter({
      appId: "app-id",
      appSecret: "app-secret",
    });

    (adapter as any).channel = {
      addReaction: async () => "reaction-id",
      send: async (
        chatId: string,
        input: unknown,
        opts?: { replyTo?: string },
      ) => {
        sendCalls.push({ chatId, input, opts });
        return { messageId: "outbound-message" };
      },
    };

    (adapter as any).agent = {
      handleMessage: async (
        _platform: string,
        _channelId: string,
        _text: string,
        onEvent: (event: any) => void,
      ) => {
        onEvent({
          type: "file_output",
          filePath,
          filename: "chart.png",
          caption: "Generated chart",
        });
        return { stopReason: "completed" };
      },
      handleCommand: async () => ({ success: true }),
      abort: () => {},
      isRunning: () => false,
      dispose: () => {},
      listSessions: () => [],
      restoreSession: async () => {},
      getActiveChannelIds: () => [],
      getAuthStorage: () => null,
      updateAuth: () => {},
    };

    await (adapter as any).handleIncomingMessage({
      messageId: "om_123",
      chatId: "oc_456",
      chatType: "p2p",
      senderId: "ou_789",
      senderName: "alice",
      content: "please export the chart",
      rawContentType: "text",
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: 0,
    });

    assert.deepEqual(sendCalls, [
      {
        chatId: "oc_456",
        input: { markdown: "Generated chart" },
        opts: { replyTo: "om_123" },
      },
      {
        chatId: "oc_456",
        input: {
          image: {
            source: filePath,
          },
        },
        opts: { replyTo: "om_123" },
      },
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
