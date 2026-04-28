export type DelegatedToolAdapter = "telegram" | "slack" | "web" | "scheduler";

export interface DelegatedToolRunContext {
  runId: string;
  channelId: string;
  adapter: DelegatedToolAdapter;
}

export interface DelegatedCustomToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: Record<string, unknown>;
}

export interface DelegatedCustomToolTextContent {
  type: "text";
  text: string;
}

export interface DelegatedCustomToolImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export type DelegatedCustomToolContent =
  | DelegatedCustomToolTextContent
  | DelegatedCustomToolImageContent;

export interface DelegatedCustomToolResult {
  content: DelegatedCustomToolContent[];
  details?: unknown;
}

export interface DelegatedCustomToolExecutionInput {
  toolName: string;
  toolCallId: string;
  runContext: DelegatedToolRunContext;
  params: unknown;
}

export interface DelegatedCustomToolExecutor {
  executeTool(
    input: DelegatedCustomToolExecutionInput,
  ): Promise<DelegatedCustomToolResult>;
}

export type DelegatedToolRunContextRef = {
  current: DelegatedToolRunContext | null;
};

