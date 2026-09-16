import {
  HostIpcRequestTimeoutError,
  type HostIpcClient,
} from "../host-ipc/host-ipc-client.js";
import type {
  DelegatedMcpToolDefinition,
  DelegatedMcpToolExecutionInput,
  DelegatedMcpToolResult,
} from "./delegated-mcp-tool.types.js";

const MCP_TOOL_DEFINITION_TIMEOUT_MS = 60_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export class DelegatedMcpToolClient {
  constructor(
    private readonly host: Pick<HostIpcClient, "isAvailable" | "request">,
    private readonly enabled = true,
    private readonly definitionTimeoutMs = MCP_TOOL_DEFINITION_TIMEOUT_MS,
  ) {}

  async listDefinitions(): Promise<DelegatedMcpToolDefinition[]> {
    if (!this.enabled || !this.host.isAvailable()) return [];
    let data: unknown;
    try {
      data = await this.host.request("get_mcp_tool_definitions", undefined, {
        timeoutMs: this.definitionTimeoutMs,
      });
    } catch (error) {
      if (error instanceof HostIpcRequestTimeoutError) return [];
      throw error;
    }
    if (
      !Array.isArray(data) ||
      data.some(
        (item) =>
          !isObject(item) ||
          typeof item.toolId !== "string" ||
          typeof item.name !== "string" ||
          !isObject(item.inputSchema),
      )
    )
      throw new Error("Invalid delegated MCP tool definitions response");
    return data;
  }

  async executeTool(
    input: DelegatedMcpToolExecutionInput,
  ): Promise<DelegatedMcpToolResult> {
    if (!this.enabled)
      throw new Error("Delegated MCP tools are not enabled by the host");
    const data = await this.host.request("execute_mcp_tool", input);
    if (!isObject(data) || !Array.isArray(data.content)) {
      throw new Error("Invalid delegated MCP tool result");
    }
    return data as unknown as DelegatedMcpToolResult;
  }
}
