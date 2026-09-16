import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { HostIpcClient } from "../src/runtime/host-ipc/host-ipc-client.js";
import { createDelegatedMcpTools, DelegatedMcpToolClient } from "../src/runtime/mcp-tools/index.js";

const definition = {
  toolId: "tool-1",
  name: "mcp_search_123",
  description: "Search provider data",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
};

test("MCP stays disabled unless the host advertises support", async () => {
  const requests: unknown[] = [];
  const client = new DelegatedMcpToolClient({
    isAvailable: () => true,
    request: async (...args) => {
      requests.push(args);
      return [definition];
    },
  }, false);

  assert.deepEqual(await client.listDefinitions(), []);
  assert.deepEqual(requests, []);
  await assert.rejects(() => client.executeTool({
    toolId: "tool-1",
    toolCallId: "call-1",
    runContext: { runId: "run-1", channelId: "web", adapter: "web" },
    arguments: {},
  }), /not enabled by the host/);
});

test("MCP definitions use a separate IPC request", async () => {
  class FakeTransport extends EventEmitter {
    connected = true;
    sent: unknown[] = [];
    send(message: unknown): boolean { this.sent.push(message); return true; }
  }
  const transport = new FakeTransport();
  const host = new HostIpcClient(transport, { timeoutMs: 500 });
  const client = new DelegatedMcpToolClient(host);
  const pending = client.listDefinitions();
  const request = transport.sent[0] as { id: string; type: string };
  assert.equal(request.type, "get_mcp_tool_definitions");
  transport.emit("message", { id: request.id, type: "result", data: [definition] });
  assert.deepEqual(await pending, [definition]);
  host.dispose();
});

test("MCP definition discovery returns no tools after its own timeout", async () => {
  class FakeTransport extends EventEmitter {
    connected = true;
    send(): boolean { return true; }
  }
  const transport = new FakeTransport();
  const host = new HostIpcClient(transport, { timeoutMs: 500 });
  const client = new DelegatedMcpToolClient(host, true, 20);

  assert.deepEqual(await client.listDefinitions(), []);
  host.dispose();
});

test("MCP execution uses its own IPC request and preserves the tool binding", async () => {
  class FakeTransport extends EventEmitter {
    connected = true;
    sent: unknown[] = [];
    send(message: unknown): boolean { this.sent.push(message); return true; }
  }
  const transport = new FakeTransport();
  const host = new HostIpcClient(transport, { timeoutMs: 500 });
  const client = new DelegatedMcpToolClient(host);
  const input = { toolId: "tool-1", toolCallId: "call-1", runContext: { runId: "run-1", channelId: "web", adapter: "web" as const }, arguments: { query: "test" } };
  const pending = client.executeTool(input);
  const request = transport.sent[0] as { id: string; type: string; toolId: string };
  assert.equal(request.type, "execute_mcp_tool");
  assert.equal(request.toolId, input.toolId);
  transport.emit("message", { id: request.id, type: "result", data: { content: [{ type: "text", text: "ok" }] } });
  assert.deepEqual(await pending, { content: [{ type: "text", text: "ok" }] });
  host.dispose();
});

test("MCP tool forwards binding and active run context", async () => {
  const calls: unknown[] = [];
  const context = { runId: "run-1", channelId: "web", adapter: "web" as const };
  const [tool] = createDelegatedMcpTools([definition], {
    async executeTool(input) { calls.push(input); return { content: [{ type: "text" as const, text: "ok" }] }; },
  }, { current: context });
  const result = await tool.execute("call-1", { query: "test" }, undefined, undefined, {} as any);
  assert.deepEqual(result.content, [{ type: "text", text: "ok" }]);
  assert.deepEqual(calls, [{ toolId: "tool-1", toolCallId: "call-1", runContext: context, arguments: { query: "test" } }]);
});

test("MCP isError becomes a tool error", async () => {
  const [tool] = createDelegatedMcpTools([definition], {
    async executeTool() { return { isError: true, content: [{ type: "text" as const, text: "provider rejected" }] }; },
  }, { current: { runId: "run-1", channelId: "web", adapter: "web" } });
  await assert.rejects(() => tool.execute("call-1", {}, undefined, undefined, {} as any), /provider rejected/);
});
