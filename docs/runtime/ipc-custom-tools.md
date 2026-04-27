# IPC Delegated Custom Tools

This document describes how SkillPack exposes custom tools to the LLM while delegating their implementation to an embedding host such as Frevana Electron.

## Goals

- Keep `skill-pack` runtime lightweight and host-agnostic.
- Let Frevana own host-specific behavior such as artifact snapshots, SQLite writes, downloads, and future desktop-only tools.
- Keep all SkillPack custom tool code organized under a dedicated bounded context instead of mixing it with generic services.

## Ownership

### `skill-pack`

`skill-pack` owns only the bridge:

```text
src/runtime/custom-tools/
  delegated-custom-tool-client.ts
  delegated-custom-tool-factory.ts
  delegated-custom-tool.types.ts
  index.ts
```

Responsibilities:

- Request tool definitions from the parent process.
- Register those definitions as pi-coding-agent `customTools`.
- Forward tool calls back to the parent process with the active run context.
- Let IPC failures surface as normal tool execution errors.

`skill-pack` does not persist artifacts, open SQLite, or query recent artifacts.

### Frevana

Frevana owns the concrete tool registry, execution, and persistence:

```text
src/main/services/skillpack/
  artifacts/
  custom-tools/
```

Responsibilities:

- Register available SkillPack custom tools.
- Execute handlers with `{ teamId, projectDir, runId, channelId, adapter, toolCallId }`.
- Own host-specific storage and APIs.
- Query `data/result-v2.db` directly for overview/results UI.

## IPC Contract

The child process sends requests to the parent process using the same response envelope as parent-to-child requests.

### Get Tool Definitions

Request:

```ts
{
  id: string;
  type: "get_custom_tool_definitions";
}
```

Response:

```ts
{
  id: string;
  type: "result";
  data: SkillpackCustomToolDefinition[];
}
```

Definition shape:

```ts
interface SkillpackCustomToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: Record<string, unknown>; // TypeBox-compatible JSON schema
}
```

### Execute Tool

Request:

```ts
{
  id: string;
  type: "execute_custom_tool";
  toolName: string;
  toolCallId: string;
  runContext: {
    runId: string;
    channelId: string;
    adapter: "telegram" | "slack" | "web" | "scheduler";
  };
  params: unknown;
}
```

Success response:

```ts
{
  id: string;
  type: "result";
  data: {
    content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
    details?: unknown;
  };
}
```

Failure response:

```ts
{
  id: string;
  type: "error";
  message: string;
}
```

The `skill-pack` bridge rejects the tool execution promise on `type: "error"`, so the agent follows the standard custom tool error flow.

## Runtime Flow

1. `PackAgent` creates a channel session.
2. `DelegatedCustomToolClient` asks the parent for `get_custom_tool_definitions`.
3. `createDelegatedCustomTools()` registers each returned definition with pi-coding-agent.
4. `PackAgent.handleMessage()` creates a new `runId` and stores the active run context for the turn.
5. When the LLM calls a delegated tool, `skill-pack` sends `execute_custom_tool` to the parent.
6. Frevana resolves the tool by name, executes the handler, and returns a pi-coding-agent compatible tool result.

Standalone `skill-pack run` has no parent IPC channel, so delegated tool discovery returns an empty list.

## Adding a Tool in Frevana

Add a new subdirectory under:

```text
frevana-electron-app/src/main/services/skillpack/custom-tools/<tool-name>/
```

Recommended structure:

```text
<tool-name>.schema.ts
<tool-name>.definition.ts
<tool-name>.handler.ts
index.ts
```

Implementation steps:

1. Define a TypeBox parameter schema in `<tool-name>.schema.ts`.
2. Export a `SkillpackCustomToolDefinition` from `<tool-name>.definition.ts`.
3. Implement handler logic in `<tool-name>.handler.ts`.
4. Export `{ definition, handler }` as a `SkillpackCustomTool` from `index.ts`.
5. Register the tool in `custom-tool-registry.ts`.
6. Keep any domain-specific services in a sibling bounded context, not in generic app services.

## Current Tool: `save_artifacts`

`save_artifacts` is exposed to the LLM by `skill-pack`, but implemented in Frevana.

Frevana behavior:

- Validates every artifact path is absolute, readable, a file, and inside `projectDir`.
- Copies files into `data/artifacts/<runId>/`.
- Writes rows into `data/result-v2.db` table `artifacts`.
- Cleans up snapshots if the database write fails.
- Serves overview/results/download flows from Frevana main without calling child IPC.

