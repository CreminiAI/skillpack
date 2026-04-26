import { randomUUID } from "node:crypto";

import type {
  DelegatedCustomToolDefinition,
  DelegatedCustomToolExecutionInput,
  DelegatedCustomToolExecutor,
  DelegatedCustomToolResult,
} from "./delegated-custom-tool.types.js";

type DelegatedRequestType =
  | "get_custom_tool_definitions"
  | "execute_custom_tool";

type DelegatedIpcResultMessage = {
  id: string;
  type: "result";
  data: unknown;
};

type DelegatedIpcErrorMessage = {
  id: string;
  type: "error";
  message: string;
};

type DelegatedIpcResponseMessage =
  | DelegatedIpcResultMessage
  | DelegatedIpcErrorMessage;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export interface DelegatedCustomToolTransport {
  connected?: boolean;
  send?: (message: unknown) => boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  off(event: "message", listener: (message: unknown) => void): unknown;
}

export interface DelegatedCustomToolClientOptions {
  timeoutMs?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertToolDefinitions(
  value: unknown,
): asserts value is DelegatedCustomToolDefinition[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid delegated custom tool definitions response");
  }

  for (const definition of value) {
    if (
      !isObject(definition) ||
      typeof definition.name !== "string" ||
      typeof definition.label !== "string" ||
      typeof definition.description !== "string" ||
      !isObject(definition.parameters)
    ) {
      throw new Error("Invalid delegated custom tool definition");
    }
  }
}

function assertToolResult(
  value: unknown,
): asserts value is DelegatedCustomToolResult {
  if (!isObject(value) || !Array.isArray(value.content)) {
    throw new Error("Invalid delegated custom tool result");
  }
}

export class DelegatedCustomToolClient
  implements DelegatedCustomToolExecutor
{
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly timeoutMs: number;
  private disposed = false;

  constructor(
    private readonly transport: DelegatedCustomToolTransport =
      process as unknown as DelegatedCustomToolTransport,
    options: DelegatedCustomToolClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
    this.transport.on("message", this.handleMessage);
  }

  isAvailable(): boolean {
    return typeof this.transport.send === "function" && this.transport.connected !== false;
  }

  async listDefinitions(): Promise<DelegatedCustomToolDefinition[]> {
    if (!this.isAvailable()) {
      return [];
    }

    const data = await this.sendRequest("get_custom_tool_definitions");
    assertToolDefinitions(data);
    return data;
  }

  async executeTool(
    input: DelegatedCustomToolExecutionInput,
  ): Promise<DelegatedCustomToolResult> {
    const data = await this.sendRequest("execute_custom_tool", input);
    assertToolResult(data);
    return data;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.transport.off("message", this.handleMessage);
    this.rejectAllPending(new Error("Delegated custom tool client disposed"));
  }

  private sendRequest(
    type: DelegatedRequestType,
    payload?: object,
  ): Promise<unknown> {
    if (!this.isAvailable()) {
      throw new Error("Delegated custom tool IPC channel is not available");
    }

    const id = randomUUID();
    const request = {
      id,
      type,
      ...(payload || {}),
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Delegated custom tool request timed out: ${type}`));
      }, this.timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      try {
        this.transport.send!(request);
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private readonly handleMessage = (message: unknown) => {
    if (!isObject(message)) {
      return;
    }

    const payload = message as DelegatedIpcResponseMessage;
    if (
      typeof payload.id !== "string" ||
      (payload.type !== "result" && payload.type !== "error")
    ) {
      return;
    }

    const pending = this.pendingRequests.get(payload.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(payload.id);

    if (payload.type === "error") {
      pending.reject(new Error(payload.message));
      return;
    }

    pending.resolve(payload.data);
  };

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }
}
