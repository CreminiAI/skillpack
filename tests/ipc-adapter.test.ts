import test from "node:test";
import assert from "node:assert/strict";

import { IpcAdapter } from "../src/runtime/adapters/ipc.js";

async function withCapturedIpc(
  run: (sent: unknown[]) => Promise<void> | void,
): Promise<void> {
  const processWithSend = process as NodeJS.Process & {
    send?: (message: unknown) => boolean;
  };
  const hadSend = Object.prototype.hasOwnProperty.call(processWithSend, "send");
  const originalSend = processWithSend.send;
  const sent: unknown[] = [];

  processWithSend.send = (message: unknown) => {
    sent.push(message);
    return true;
  };

  try {
    await run(sent);
  } finally {
    if (hadSend) {
      processWithSend.send = originalSend;
    } else {
      delete processWithSend.send;
    }
  }
}

test("ipc send_message handles slash commands before prompting the agent", async () => {
  await withCapturedIpc(async (sent) => {
    const calls: string[] = [];
    const adapter = new IpcAdapter();

    (adapter as any).agent = {
      handleCommand: async (command: string, channelId: string) => {
        calls.push(`command:${command}:${channelId}`);
        return { success: true, message: "Session cleared." };
      },
      handleMessage: async () => {
        calls.push("message");
        return { stopReason: "done" };
      },
    };
    (adapter as any).conversationService = {};

    await (adapter as any).handleRequest({
      id: "req-1",
      type: "send_message",
      channelId: "web",
      text: "/clear",
    });

    assert.deepEqual(calls, ["command:clear:web"]);
    assert.deepEqual(sent, [
      {
        id: "req-1",
        type: "result",
        data: {
          stopReason: "command",
          text: "Session cleared.",
        },
      },
    ]);
  });
});
