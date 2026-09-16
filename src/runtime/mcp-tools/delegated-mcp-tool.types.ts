import type { DelegatedToolRunContext } from "../custom-tools/delegated-custom-tool.types.js";

export interface DelegatedMcpToolDefinition {
  toolId: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface DelegatedMcpToolExecutionInput {
  toolId: string;
  toolCallId: string;
  runContext: DelegatedToolRunContext;
  arguments: unknown;
}

export interface DelegatedMcpToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}
