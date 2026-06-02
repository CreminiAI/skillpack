import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createResilientLarkChannel,
  type ResilientLarkChannel,
} from "../src/runtime/adapters/resilient-lark-channel.js";

const HEARTBEAT = {
  intervalMs: 5,
  pongTimeoutMs: 8,
  rebuildCooldownMs: 0,
  maxRetryDelayMs: 20,
};

class FakeRawWebSocket extends EventEmitter {
  readyState = 1;
  pingCalls = 0;
  autoPong = true;
  pingError: Error | null = null;

  ping(callback?: (error?: Error) => void): void {
    this.pingCalls += 1;
    if (this.pingError) {
      callback?.(this.pingError);
      return;
    }
    callback?.();
    if (this.autoPong) {
      setTimeout(() => {
        this.emit("pong");
      }, 1);
    }
  }
}

class Deferred {
  promise: Promise<void>;
  resolve!: () => void;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
}

class FakeChannel {
  rawClient = {};
  rawWsClient = {
    wsConfig: {
      getWSInstance: () => this.ws,
    },
  };
  botIdentity = { name: "fake-bot" };
  ws = new FakeRawWebSocket();
  connected = false;
  disconnected = false;
  connectError: Error | null = null;
  connectGate: Promise<void> | null = null;
  sendCalls: unknown[][] = [];
  private handlers = new Map<string, Set<(...args: any[]) => void>>();

  async connect(): Promise<void> {
    if (this.connectGate) {
      await this.connectGate;
    }
    if (this.connectError) {
      throw this.connectError;
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }

  on(nameOrMap: string | Record<string, (...args: any[]) => void>, handler?: (...args: any[]) => void): () => void {
    if (typeof nameOrMap === "string") {
      if (!handler) {
        throw new Error("handler required");
      }
      return this.addHandler(nameOrMap, handler);
    }

    const unsubscribers = Object.entries(nameOrMap).map(([name, nextHandler]) =>
      this.addHandler(name, nextHandler),
    );
    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }

  emitEvent(name: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(name) ?? []) {
      handler(...args);
    }
  }

  async send(...args: unknown[]): Promise<{ messageId: string }> {
    this.sendCalls.push(args);
    return { messageId: "message-id" };
  }

  async stream(...args: unknown[]): Promise<{ messageId: string }> {
    this.sendCalls.push(args);
    return { messageId: "stream-id" };
  }

  async addReaction(): Promise<string> {
    return "reaction-id";
  }

  async removeReaction(): Promise<void> {}
  async removeReactionByEmoji(): Promise<boolean> {
    return true;
  }
  async updateCard(): Promise<void> {}
  async editMessage(): Promise<void> {}
  async recallMessage(): Promise<void> {}
  async downloadResource(): Promise<Buffer> {
    return Buffer.from("");
  }
  async getChatInfo(): Promise<unknown> {
    return {};
  }
  updatePolicy(): void {}
  getPolicy(): unknown {
    return {};
  }

  private addHandler(name: string, handler: (...args: any[]) => void): () => void {
    let handlers = this.handlers.get(name);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(name, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers?.delete(handler);
    };
  }
}

function createHarness(
  configureChannel?: (channel: FakeChannel, index: number) => void,
): {
  channel: ResilientLarkChannel;
  channels: FakeChannel[];
} {
  const channels: FakeChannel[] = [];
  const channel = createResilientLarkChannel({
    appId: "cli_1234567890abcdef",
    appSecret: "secret",
    heartbeat: HEARTBEAT,
    channelFactory: () => {
      const next = new FakeChannel();
      configureChannel?.(next, channels.length);
      channels.push(next);
      return next as any;
    },
  });

  return { channel, channels };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 250,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await sleep(5);
  }
  assert.equal(predicate(), true);
}

test("resilient channel keeps handlers after rebuild", async () => {
  const { channel, channels } = createHarness();
  const messages: string[] = [];

  channel.on("message", (message: any) => {
    messages.push(message.content);
  });

  await channel.connect();
  channels[0].emitEvent("message", { content: "before" });
  channels[0].ws.autoPong = false;

  await waitFor(() => channels.length >= 2);
  channels[1].emitEvent("message", { content: "after" });

  assert.deepEqual(messages, ["before", "after"]);
  await channel.disconnect();
});

test("resilient channel does not rebuild when websocket returns pong", async () => {
  const { channel, channels } = createHarness();

  await channel.connect();
  await sleep(35);

  assert.equal(channels.length, 1);
  assert.ok(channels[0].ws.pingCalls > 0);
  await channel.disconnect();
});

test("resilient channel rebuilds when pong times out", async () => {
  const { channel, channels } = createHarness();

  await channel.connect();
  channels[0].ws.autoPong = false;

  await waitFor(() => channels.length >= 2);

  assert.equal(channels[0].disconnected, true);
  assert.equal(channels[1].connected, true);
  await channel.disconnect();
});

test("resilient channel rebuilds when raw websocket is not open", async () => {
  const { channel, channels } = createHarness();

  await channel.connect();
  channels[0].ws.readyState = 3;

  await waitFor(() => channels.length >= 2);

  assert.equal(channels[0].disconnected, true);
  assert.equal(channels[1].connected, true);
  await channel.disconnect();
});

test("resilient channel deduplicates concurrent rebuilds", async () => {
  const { channel, channels } = createHarness();

  await channel.connect();
  await Promise.all([
    (channel as any).rebuildChannel("first"),
    (channel as any).rebuildChannel("second"),
    (channel as any).rebuildChannel("third"),
  ]);

  assert.equal(channels.length, 2);
  assert.equal(channels[1].connected, true);
  await channel.disconnect();
});

test("resilient channel waits for rebuild before sending", async () => {
  const gate = new Deferred();
  const { channel, channels } = createHarness((next, index) => {
    if (index === 1) {
      next.connectGate = gate.promise;
    }
  });

  await channel.connect();
  const rebuildPromise = (channel as any).rebuildChannel("manual");
  await waitFor(() => channels.length >= 2);

  const sendPromise = channel.send("oc_test", { markdown: "hello" });
  await sleep(15);
  assert.equal(channels[1].sendCalls.length, 0);

  gate.resolve();
  await rebuildPromise;
  await sendPromise;

  assert.deepEqual(channels[1].sendCalls, [
    ["oc_test", { markdown: "hello" }],
  ]);
  await channel.disconnect();
});

test("resilient channel retries rebuild after reconnect failure", async () => {
  const { channel, channels } = createHarness((next, index) => {
    if (index === 1) {
      next.connectError = new Error("connect failed");
    }
  });

  await channel.connect();
  await assert.rejects((channel as any).rebuildChannel("manual"));
  await waitFor(() => channels.length >= 3);

  assert.equal(channels[1].connected, false);
  assert.equal(channels[2].connected, true);
  await channel.disconnect();
});

test("resilient channel stops heartbeat after disconnect", async () => {
  const { channel, channels } = createHarness();

  await channel.connect();
  await channel.disconnect();
  channels[0].ws.autoPong = false;
  await sleep(30);

  assert.equal(channels.length, 1);
});
