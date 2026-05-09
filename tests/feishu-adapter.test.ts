import assert from "node:assert/strict";
import test from "node:test";

import {
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
