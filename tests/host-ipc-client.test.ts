import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { HostIpcClient } from "../src/runtime/host-ipc/host-ipc-client.js";

class FakeTransport extends EventEmitter {
  connected = true;
  sent: unknown[] = [];

  send(message: unknown): boolean {
    this.sent.push(message);
    return true;
  }
}

test("host IPC client reports cleared channel sessions", async () => {
  const transport = new FakeTransport();
  const client = new HostIpcClient(transport, { timeoutMs: 500 });

  const notifyPromise = client.notifyChannelSessionCleared({
    channelId: "scheduler-daily",
  });
  const request = transport.sent[0] as {
    id: string;
    type: string;
    channelId: string;
  };

  assert.equal(request.type, "channel_session_cleared");
  assert.equal(request.channelId, "scheduler-daily");

  transport.emit("message", {
    id: request.id,
    type: "result",
    data: { deletedCount: 1 },
  });

  await notifyPromise;
  client.dispose();
});

test("host IPC client skips notification when no host is connected", async () => {
  const transport = new FakeTransport();
  transport.connected = false;
  const client = new HostIpcClient(transport, { timeoutMs: 500 });

  await client.notifyChannelSessionCleared({
    channelId: "scheduler-daily",
  });

  assert.deepEqual(transport.sent, []);
  client.dispose();
});

test("host IPC client turns host errors into rejections", async () => {
  const transport = new FakeTransport();
  const client = new HostIpcClient(transport, { timeoutMs: 500 });

  const notifyPromise = client.notifyChannelSessionCleared({
    channelId: "scheduler-daily",
  });
  const request = transport.sent[0] as { id: string };

  transport.emit("message", {
    id: request.id,
    type: "error",
    message: "Failed to clear suggestions",
  });

  await assert.rejects(notifyPromise, /Failed to clear suggestions/);
  client.dispose();
});
