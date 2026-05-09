import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FeishuAdapter,
  normalizeFeishuMessage,
  parseFeishuChannelId,
} from "../src/runtime/adapters/feishu.js";

test("parseFeishuChannelId extracts chat id", () => {
  assert.equal(parseFeishuChannelId("feishu-oc_123"), "oc_123");
});

test("normalizeFeishuMessage handles direct text messages", () => {
  assert.deepEqual(
    normalizeFeishuMessage({
      chatType: "p2p",
      mentionedBot: false,
      rawContentType: "text",
      content: "hello from feishu",
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
    }),
    {
      action: "handle",
      text: "summarize this thread",
    },
  );
});

test("normalizeFeishuMessage returns fallback for non-text messages", () => {
  assert.deepEqual(
    normalizeFeishuMessage({
      chatType: "p2p",
      mentionedBot: false,
      rawContentType: "image",
      content: "",
    }),
    {
      action: "unsupported",
    },
  );
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
