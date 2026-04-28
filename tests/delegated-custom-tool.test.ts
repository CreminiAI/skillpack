import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  createDelegatedCustomTools,
  DelegatedCustomToolClient,
  type DelegatedCustomToolDefinition,
  type DelegatedCustomToolExecutionInput,
  type DelegatedCustomToolResult,
} from "../src/runtime/custom-tools/index.js";

class FakeTransport extends EventEmitter {
  connected = true;
  sent: unknown[] = [];

  send(message: unknown): boolean {
    this.sent.push(message);
    return true;
  }
}

const saveArtifactsDefinition: DelegatedCustomToolDefinition = {
  name: "save_artifacts",
  label: "Save Artifacts",
  description: "Save final artifacts.",
  parameters: {
    type: "object",
    properties: {
      artifacts: { type: "array" },
    },
    required: ["artifacts"],
  },
};

test("delegated custom tool client loads definitions through IPC", async () => {
  const transport = new FakeTransport();
  const client = new DelegatedCustomToolClient(transport, { timeoutMs: 500 });

  const definitionsPromise = client.listDefinitions();
  const request = transport.sent[0] as { id: string; type: string };

  assert.equal(request.type, "get_custom_tool_definitions");

  transport.emit("message", {
    id: request.id,
    type: "result",
    data: [saveArtifactsDefinition],
  });

  assert.deepEqual(await definitionsPromise, [saveArtifactsDefinition]);
  client.dispose();
});

test("delegated custom tool forwards execution with run context", async () => {
  const calls: DelegatedCustomToolExecutionInput[] = [];
  const result: DelegatedCustomToolResult = {
    content: [{ type: "text", text: "Saved 1 artifact(s)." }],
    details: { savedCount: 1 },
  };
  const client = {
    async executeTool(input: DelegatedCustomToolExecutionInput) {
      calls.push(input);
      return result;
    },
  };
  const runContextRef = {
    current: {
      runId: "run-1",
      channelId: "scheduler-daily",
      adapter: "scheduler" as const,
    },
  };

  const [tool] = createDelegatedCustomTools(
    [saveArtifactsDefinition],
    client,
    runContextRef,
  );

  assert.ok(tool);
  const toolResult = await tool.execute(
    "tool-call-1",
    { artifacts: [{ filePath: "/tmp/result.md" }] },
    undefined,
    undefined,
    {} as any,
  );

  assert.deepEqual(toolResult, result);
  assert.deepEqual(calls, [
    {
      toolName: "save_artifacts",
      toolCallId: "tool-call-1",
      runContext: runContextRef.current,
      params: { artifacts: [{ filePath: "/tmp/result.md" }] },
    },
  ]);
});

test("delegated custom tool turns IPC errors into tool errors", async () => {
  const [tool] = createDelegatedCustomTools(
    [saveArtifactsDefinition],
    {
      async executeTool() {
        throw new Error("Frevana rejected the artifact path");
      },
    },
    {
      current: {
        runId: "run-1",
        channelId: "web",
        adapter: "web",
      },
    },
  );

  assert.ok(tool);
  await assert.rejects(
    () => tool.execute("tool-call-1", { artifacts: [] }, undefined, undefined, {} as any),
    /Frevana rejected the artifact path/,
  );
});

