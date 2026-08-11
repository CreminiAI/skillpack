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

test("host IPC client obtains request headers for an execution context", async () => {
  const transport = new FakeTransport();
  const client = new HostIpcClient(transport, { timeoutMs: 500 });

  const headersPromise = client.getRequestHeaders({
    runId: "run-1",
    channelId: "scheduler-daily",
    jobId: "daily",
    triggerType: "scheduler",
  });
  const request = transport.sent[0] as {
    id: string;
    type: string;
    context: Record<string, string>;
  };

  assert.equal(request.type, "get_request_headers");
  assert.deepEqual(request.context, {
    runId: "run-1",
    channelId: "scheduler-daily",
    jobId: "daily",
    triggerType: "scheduler",
  });

  transport.emit("message", {
    id: request.id,
    type: "result",
    data: { "X-Product-Run-Id": "run-1", ignored: 42 },
  });

  assert.deepEqual(await headersPromise, { "X-Product-Run-Id": "run-1" });
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
