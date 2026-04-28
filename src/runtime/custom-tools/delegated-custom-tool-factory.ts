import type {
  AgentToolResult,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";

import type {
  DelegatedCustomToolDefinition,
  DelegatedCustomToolExecutor,
  DelegatedCustomToolResult,
  DelegatedToolRunContextRef,
} from "./delegated-custom-tool.types.js";

function toAgentToolResult(
  result: DelegatedCustomToolResult,
): AgentToolResult<unknown> {
  return {
    content: result.content as AgentToolResult<unknown>["content"],
    details: result.details,
  };
}

export function createDelegatedCustomTools(
  definitions: readonly DelegatedCustomToolDefinition[],
  client: DelegatedCustomToolExecutor,
  runContextRef: DelegatedToolRunContextRef,
): ToolDefinition[] {
  return definitions.map((definition) => ({
    name: definition.name,
    label: definition.label,
    description: definition.description,
    promptSnippet: definition.promptSnippet,
    promptGuidelines: definition.promptGuidelines,
    parameters: definition.parameters as TSchema,
    async execute(toolCallId, params) {
      const runContext = runContextRef.current;
      if (!runContext) {
        throw new Error(
          `Delegated custom tool ${definition.name} is not available outside an active run.`,
        );
      }

      return toAgentToolResult(
        await client.executeTool({
          toolName: definition.name,
          toolCallId,
          runContext,
          params,
        }),
      );
    },
  }));
}

