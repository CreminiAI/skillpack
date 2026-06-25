import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

test("ipc send_message forwards validated attachments to the agent", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "skillpack-ipc-"));
  const attachmentDir = path.join(
    rootDir,
    "data",
    "sessions",
    "web",
    "attachments",
  );
  fs.mkdirSync(attachmentDir, { recursive: true });
  const attachmentPath = path.join(attachmentDir, "report.txt");
  fs.writeFileSync(attachmentPath, "hello", "utf-8");

  try {
    await withCapturedIpc(async (sent) => {
      const calls: unknown[] = [];
      const adapter = new IpcAdapter();

      (adapter as any).rootDir = rootDir;
      (adapter as any).agent = {
        handleMessage: async (
          platform: string,
          channelId: string,
          text: string,
          _onEvent: unknown,
          attachments: unknown,
        ) => {
          calls.push({ platform, channelId, text, attachments });
          return { stopReason: "done" };
        },
      };
      (adapter as any).conversationService = {};

      await (adapter as any).handleRequest({
        id: "req-2",
        type: "send_message",
        channelId: "web",
        text: "Review this",
        attachments: [
          {
            filename: "report.txt",
            localPath: attachmentPath,
            mimeType: "text/plain",
          },
        ],
      });

      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], {
        platform: "web",
        channelId: "web",
        text: "Review this",
        attachments: [
          {
            filename: "report.txt",
            localPath: attachmentPath,
            mimeType: "text/plain",
            size: 5,
          },
        ],
      });
      assert.equal((sent[0] as any).type, "result");
    });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("ipc abort_run aborts the requested agent channel", async () => {
  await withCapturedIpc(async (sent) => {
    const calls: string[] = [];
    const adapter = new IpcAdapter();

    (adapter as any).agent = {
      isRunning: (channelId: string) => {
        calls.push(`isRunning:${channelId}`);
        return true;
      },
      abort: (channelId: string) => {
        calls.push(`abort:${channelId}`);
      },
    };
    (adapter as any).conversationService = {};

    await (adapter as any).handleRequest({
      id: "req-abort",
      type: "abort_run",
      channelId: "web",
    });

    assert.deepEqual(calls, ["isRunning:web", "abort:web"]);
    assert.deepEqual(sent, [
      {
        id: "req-abort",
        type: "result",
        data: {
          success: true,
          aborted: true,
        },
      },
    ]);
  });
});
