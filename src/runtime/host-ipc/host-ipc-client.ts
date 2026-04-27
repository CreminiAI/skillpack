import { randomUUID } from "node:crypto";

type HostIpcRequestType = "channel_session_cleared";

type HostIpcResultMessage = {
  id: string;
  type: "result";
  data: unknown;
};

type HostIpcErrorMessage = {
  id: string;
  type: "error";
  message: string;
};

type HostIpcResponseMessage = HostIpcResultMessage | HostIpcErrorMessage;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export interface HostIpcTransport {
  connected?: boolean;
  send?: (message: unknown) => boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  off(event: "message", listener: (message: unknown) => void): unknown;
}

export interface HostIpcClientOptions {
  timeoutMs?: number;
}

export interface ChannelSessionClearedInput {
  channelId: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export class HostIpcClient {
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly timeoutMs: number;
  private disposed = false;

  constructor(
    private readonly transport: HostIpcTransport = process as unknown as HostIpcTransport,
    options: HostIpcClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
    this.transport.on("message", this.handleMessage);
  }

  isAvailable(): boolean {
    return (
      typeof this.transport.send === "function" &&
      this.transport.connected !== false
    );
  }

  async notifyChannelSessionCleared(
    input: ChannelSessionClearedInput,
  ): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }

    await this.sendRequest("channel_session_cleared", input);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.transport.off("message", this.handleMessage);
    this.rejectAllPending(new Error("Host IPC client disposed"));
  }

  private sendRequest(
    type: HostIpcRequestType,
    payload?: object,
  ): Promise<unknown> {
    if (!this.isAvailable()) {
      throw new Error("Host IPC channel is not available");
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
        reject(new Error(`Host IPC request timed out: ${type}`));
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

    const payload = message as HostIpcResponseMessage;
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
