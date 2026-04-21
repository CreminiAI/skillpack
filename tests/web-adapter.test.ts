import test from "node:test";
import assert from "node:assert/strict";

import { WebAdapter } from "../src/runtime/adapters/web.js";

test("web adapter can proactively send a scheduled result to active web clients", async () => {
  const adapter = new WebAdapter();
  const sent: string[] = [];
  const fakeSocket = {
    OPEN: 1,
    readyState: 1,
    send(payload: string) {
      sent.push(payload);
    },
  };

  (adapter as any).socketsByChannel.set("web", new Set([fakeSocket]));

  await adapter.sendMessage("web", "Scheduled report ready");

  assert.deepEqual(
    sent.map((payload) => JSON.parse(payload)),
    [
      { type: "message_start", role: "assistant" },
      { type: "text_delta", delta: "Scheduled report ready" },
      { type: "message_end", role: "assistant" },
      { done: true },
    ],
  );
});
