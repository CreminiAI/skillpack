import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { registerEmbeddedParentDisconnectShutdown } from "../src/runtime/server.js";
import type { CommandResult, LifecycleTrigger } from "../src/runtime/adapters/types.js";

class FakeProcess extends EventEmitter {
  on(event: "disconnect", listener: () => void): this {
    return super.on(event, listener);
  }
}

function createLifecycleRecorder(): {
  triggers: LifecycleTrigger[];
  lifecycle: { requestShutdown(trigger: LifecycleTrigger): Promise<CommandResult> };
} {
  const triggers: LifecycleTrigger[] = [];

  return {
    triggers,
    lifecycle: {
      async requestShutdown(trigger: LifecycleTrigger): Promise<CommandResult> {
        triggers.push(trigger);
        return { success: true };
      },
    },
  };
}

test("embedded runtime shuts down when parent IPC disconnects", async () => {
  const fakeProcess = new FakeProcess();
  const { lifecycle, triggers } = createLifecycleRecorder();

  registerEmbeddedParentDisconnectShutdown({
    runtimeMode: "embedded",
    hasIpcChannel: true,
    lifecycle,
    proc: fakeProcess,
  });

  fakeProcess.emit("disconnect");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(triggers, ["parent_disconnect"]);
});

test("parent disconnect handler is only registered for embedded IPC runtime", () => {
  const standaloneProcess = new FakeProcess();
  const noIpcProcess = new FakeProcess();
  const { lifecycle } = createLifecycleRecorder();

  registerEmbeddedParentDisconnectShutdown({
    runtimeMode: "standalone",
    hasIpcChannel: true,
    lifecycle,
    proc: standaloneProcess,
  });
  registerEmbeddedParentDisconnectShutdown({
    runtimeMode: "embedded",
    hasIpcChannel: false,
    lifecycle,
    proc: noIpcProcess,
  });

  assert.equal(standaloneProcess.listenerCount("disconnect"), 0);
  assert.equal(noIpcProcess.listenerCount("disconnect"), 0);
});
