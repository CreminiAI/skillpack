import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";

import type { DelegatedToolRunContextRef } from "../custom-tools/delegated-custom-tool.types.js";
import type { DelegatedMcpToolClient } from "./delegated-mcp-tool-client.js";
import type { DelegatedMcpToolDefinition } from "./delegated-mcp-tool.types.js";

export function createDelegatedMcpTools(
  definitions: readonly DelegatedMcpToolDefinition[],
  client: Pick<DelegatedMcpToolClient, "executeTool">,
  runContextRef: DelegatedToolRunContextRef,
): ToolDefinition[] {
  return definitions.map((definition) => ({
    name: definition.name,
    label: definition.name,
    description: definition.description ?? "MCP tool",
    parameters: definition.inputSchema as TSchema,
    async execute(toolCallId, params) {
      const runContext = runContextRef.current;
      if (!runContext) {
        throw new Error(`MCP tool ${definition.name} is not available outside an active run.`);
      }

      const result = await client.executeTool({
        toolId: definition.toolId,
        toolCallId,
        runContext,
        arguments: params,
      });
      if (result.isError) {
        const message = result.content
          .filter((item): item is { type: "text"; text: string } => item.type === "text")
          .map((item) => item.text)
          .join("\n");
        throw new Error(message || `MCP tool ${definition.name} failed.`);
      }

      return {
        content: result.content as AgentToolResult<unknown>["content"],
        details: result.structuredContent,
      };
    },
  }));
}
