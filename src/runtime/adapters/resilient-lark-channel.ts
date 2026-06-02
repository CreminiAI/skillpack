import * as Lark from "@larksuiteoapi/node-sdk";
import type {
  EventMap,
  EventName,
  LarkChannel,
  LarkChannelOptions,
} from "@larksuiteoapi/node-sdk";

export interface ResilientLarkHeartbeatOptions {
  intervalMs: number;
  pongTimeoutMs: number;
  rebuildCooldownMs: number;
  maxRetryDelayMs: number;
}

export interface ResilientLarkChannelOptions extends LarkChannelOptions {
  heartbeat?: Partial<ResilientLarkHeartbeatOptions>;
  channelFactory?: (options: LarkChannelOptions) => LarkChannel;
}

type ChannelHandlerRecord<K extends EventName = EventName> = {
  name: K;
  handler: EventMap[K];
  unsubscribe?: () => void;
};

type TimerHandle = ReturnType<typeof setTimeout>;

type RawWebSocketLike = {
  readyState: number;
  ping?: (callback?: (error?: Error) => void) => void;
  once?: (event: "pong", handler: () => void) => void;
  on?: (event: "pong", handler: () => void) => void;
  off?: (event: "pong", handler: () => void) => void;
  removeListener?: (event: "pong", handler: () => void) => void;
};

const WS_OPEN = 1;
const DEFAULT_HEARTBEAT: ResilientLarkHeartbeatOptions = {
  intervalMs: 30_000,
  pongTimeoutMs: 15_000,
  rebuildCooldownMs: 20_000,
  maxRetryDelayMs: 180_000,
};
const INITIAL_RETRY_DELAY_MS = 1_000;

export function createResilientLarkChannel(
  options: ResilientLarkChannelOptions,
): ResilientLarkChannel {
  return new ResilientLarkChannel(options);
}

export class ResilientLarkChannel {
  private readonly channelOptions: LarkChannelOptions;
  private readonly heartbeat: ResilientLarkHeartbeatOptions;
  private readonly channelFactory: (options: LarkChannelOptions) => LarkChannel;
  private readonly handlers: ChannelHandlerRecord[] = [];

  private channel: LarkChannel | null = null;
  private connectPromise: Promise<void> | null = null;
  private rebuildPromise: Promise<void> | null = null;
  private heartbeatTimer: TimerHandle | null = null;
  private retryTimer: TimerHandle | null = null;
  private stopped = true;
  private retryAttempt = 0;
  private lastRebuildAt = 0;

  constructor(options: ResilientLarkChannelOptions) {
    const { heartbeat, channelFactory, ...channelOptions } = options;
    this.channelOptions = channelOptions;
    this.heartbeat = {
      ...DEFAULT_HEARTBEAT,
      ...heartbeat,
    };
    this.channelFactory = channelFactory ?? Lark.createLarkChannel;
  }

  get rawClient(): LarkChannel["rawClient"] {
    return this.requireChannel().rawClient;
  }

  get rawWsClient(): LarkChannel["rawWsClient"] {
    return this.channel?.rawWsClient;
  }

  get botIdentity(): LarkChannel["botIdentity"] {
    return this.channel?.botIdentity;
  }

  async connect(): Promise<void> {
    if (this.connectPromise) {
      return this.connectPromise;
    }

    if (this.channel && !this.stopped) {
      return;
    }

    this.stopped = false;
    this.connectPromise = this.connectNewChannel("start").finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.clearHeartbeatTimer();
    this.clearRetryTimer();

    const channel = this.channel;
    this.channel = null;
    this.connectPromise = null;

    if (channel) {
      await this.disconnectChannel(channel);
    }
  }

  on<K extends EventName>(name: K, handler: EventMap[K]): () => void;
  on(handlers: Partial<EventMap>): () => void;
  on<K extends EventName>(
    nameOrMap: K | Partial<EventMap>,
    handler?: EventMap[K],
  ): () => void {
    if (typeof nameOrMap === "string") {
      if (!handler) {
        throw new Error(`[ResilientLarkChannel] Missing handler for ${nameOrMap}`);
      }
      return this.addHandler(nameOrMap, handler);
    }

    const unsubscribers = Object.entries(nameOrMap).map(([name, nextHandler]) =>
      this.addHandler(name as EventName, nextHandler as EventMap[EventName]),
    );
    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }

  async send(...args: Parameters<LarkChannel["send"]>): ReturnType<LarkChannel["send"]> {
    const channel = await this.getReadyChannel();
    return channel.send(...args);
  }

  async stream(...args: Parameters<LarkChannel["stream"]>): ReturnType<LarkChannel["stream"]> {
    const channel = await this.getReadyChannel();
    return channel.stream(...args);
  }

  async updateCard(
    ...args: Parameters<LarkChannel["updateCard"]>
  ): ReturnType<LarkChannel["updateCard"]> {
    const channel = await this.getReadyChannel();
    return channel.updateCard(...args);
  }

  async editMessage(
    ...args: Parameters<LarkChannel["editMessage"]>
  ): ReturnType<LarkChannel["editMessage"]> {
    const channel = await this.getReadyChannel();
    return channel.editMessage(...args);
  }

  async recallMessage(
    ...args: Parameters<LarkChannel["recallMessage"]>
  ): ReturnType<LarkChannel["recallMessage"]> {
    const channel = await this.getReadyChannel();
    return channel.recallMessage(...args);
  }

  async addReaction(
    ...args: Parameters<LarkChannel["addReaction"]>
  ): ReturnType<LarkChannel["addReaction"]> {
    const channel = await this.getReadyChannel();
    return channel.addReaction(...args);
  }

  async removeReaction(
    ...args: Parameters<LarkChannel["removeReaction"]>
  ): ReturnType<LarkChannel["removeReaction"]> {
    const channel = await this.getReadyChannel();
    return channel.removeReaction(...args);
  }

  async removeReactionByEmoji(
    ...args: Parameters<LarkChannel["removeReactionByEmoji"]>
  ): ReturnType<LarkChannel["removeReactionByEmoji"]> {
    const channel = await this.getReadyChannel();
    return channel.removeReactionByEmoji(...args);
  }

  async downloadResource(
    ...args: Parameters<LarkChannel["downloadResource"]>
  ): ReturnType<LarkChannel["downloadResource"]> {
    const channel = await this.getReadyChannel();
    return channel.downloadResource(...args);
  }

  async getChatInfo(
    ...args: Parameters<LarkChannel["getChatInfo"]>
  ): ReturnType<LarkChannel["getChatInfo"]> {
    const channel = await this.getReadyChannel();
    return channel.getChatInfo(...args);
  }

  updatePolicy(...args: Parameters<LarkChannel["updatePolicy"]>): void {
    this.requireChannel().updatePolicy(...args);
  }

  getPolicy(): ReturnType<LarkChannel["getPolicy"]> {
    return this.requireChannel().getPolicy();
  }

  private async connectNewChannel(reason: string): Promise<void> {
    const channel = this.createChannel();
    this.channel = channel;

    try {
      await channel.connect();
      if (this.stopped) {
        if (this.channel === channel) {
          this.channel = null;
        }
        await this.disconnectChannel(channel);
        return;
      }
      this.retryAttempt = 0;
      this.startHeartbeat();
      const botName = channel.botIdentity?.name;
      console.log(
        botName
          ? `[ResilientLarkChannel] Connected as ${botName} (${reason})`
          : `[ResilientLarkChannel] Connected (${reason})`,
      );
    } catch (error) {
      this.channel = null;
      await this.disconnectChannel(channel);
      throw error;
    }
  }

  private createChannel(): LarkChannel {
    const channel = this.channelFactory(this.channelOptions);
    this.attachHandlers(channel);
    return channel;
  }

  private attachHandlers(channel: LarkChannel): void {
    for (const record of this.handlers) {
      record.unsubscribe?.();
      record.unsubscribe = channel.on(
        record.name as never,
        record.handler as never,
      );
    }
  }

  private addHandler<K extends EventName>(
    name: K,
    handler: EventMap[K],
  ): () => void {
    const record: ChannelHandlerRecord<K> = {
      name,
      handler,
    };
    this.handlers.push(record as ChannelHandlerRecord);

    if (this.channel) {
      record.unsubscribe = this.channel.on(name, handler);
    }

    return () => {
      record.unsubscribe?.();
      const index = this.handlers.indexOf(record as ChannelHandlerRecord);
      if (index >= 0) {
        this.handlers.splice(index, 1);
      }
    };
  }

  private startHeartbeat(): void {
    this.clearHeartbeatTimer();
    if (this.stopped) {
      return;
    }

    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      void this.checkHeartbeat();
    }, this.heartbeat.intervalMs);
  }

  private async checkHeartbeat(): Promise<void> {
    if (this.stopped || this.rebuildPromise) {
      return;
    }

    const ws = this.getRawWebSocket();
    if (!ws || ws.readyState !== WS_OPEN) {
      this.triggerRebuild("ws-not-open");
      return;
    }

    const healthy = await this.pingWithPong(ws);
    if (this.stopped || this.rebuildPromise) {
      return;
    }

    if (!healthy) {
      this.triggerRebuild("pong-timeout");
      return;
    }

    this.startHeartbeat();
  }

  private pingWithPong(ws: RawWebSocketLike): Promise<boolean> {
    return new Promise((resolve) => {
      if (!ws.ping || (!ws.once && !ws.on)) {
        resolve(false);
        return;
      }

      let settled = false;
      let timeout: TimerHandle | null = null;
      const finish = (healthy: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        this.removePongListener(ws, onPong);
        resolve(healthy);
      };
      const onPong = () => finish(true);

      if (ws.once) {
        ws.once("pong", onPong);
      } else {
        ws.on?.("pong", onPong);
      }

      timeout = setTimeout(() => finish(false), this.heartbeat.pongTimeoutMs);

      try {
        ws.ping((error?: Error) => {
          if (error) {
            finish(false);
          }
        });
      } catch {
        finish(false);
      }
    });
  }

  private removePongListener(ws: RawWebSocketLike, handler: () => void): void {
    if (ws.off) {
      ws.off("pong", handler);
      return;
    }
    ws.removeListener?.("pong", handler);
  }

  private triggerRebuild(reason: string): void {
    void this.rebuildChannel(reason).catch((error) => {
      console.error(`[ResilientLarkChannel] Rebuild failed (${reason}):`, error);
    });
  }

  private rebuildChannel(reason: string): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }

    if (this.rebuildPromise) {
      return this.rebuildPromise;
    }

    const cooldownMs = Math.max(
      0,
      this.heartbeat.rebuildCooldownMs - (Date.now() - this.lastRebuildAt),
    );

    this.rebuildPromise = this.performRebuild(reason, cooldownMs).finally(() => {
      this.rebuildPromise = null;
    });
    return this.rebuildPromise;
  }

  private async performRebuild(reason: string, delayMs: number): Promise<void> {
    this.clearHeartbeatTimer();
    if (delayMs > 0) {
      await this.sleep(delayMs);
    }
    if (this.stopped) {
      return;
    }

    console.warn(`[ResilientLarkChannel] Rebuilding channel (${reason})`);
    const previous = this.channel;
    this.channel = null;

    if (previous) {
      await this.disconnectChannel(previous);
    }

    try {
      await this.connectNewChannel(`rebuild:${reason}`);
      this.lastRebuildAt = Date.now();
      this.clearRetryTimer();
    } catch (error) {
      this.scheduleRetry(reason);
      throw error;
    }
  }

  private scheduleRetry(reason: string): void {
    if (this.stopped || this.retryTimer) {
      return;
    }

    const delayMs = Math.min(
      this.heartbeat.maxRetryDelayMs,
      INITIAL_RETRY_DELAY_MS * 2 ** this.retryAttempt,
    );
    this.retryAttempt += 1;
    console.warn(
      `[ResilientLarkChannel] Scheduling rebuild retry in ${delayMs}ms (${reason})`,
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.triggerRebuild(`retry:${reason}`);
    }, delayMs);
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private async getReadyChannel(): Promise<LarkChannel> {
    if (this.rebuildPromise) {
      await this.rebuildPromise;
    }
    if (this.connectPromise) {
      await this.connectPromise;
    }
    return this.requireChannel();
  }

  private requireChannel(): LarkChannel {
    if (!this.channel) {
      throw new Error("[ResilientLarkChannel] Channel not connected");
    }
    return this.channel;
  }

  private getRawWebSocket(): RawWebSocketLike | null {
    const rawWsClient = this.channel?.rawWsClient as
      | {
          wsConfig?: {
            getWSInstance?: () => RawWebSocketLike | null;
          };
        }
      | undefined;
    return rawWsClient?.wsConfig?.getWSInstance?.() ?? null;
  }

  private async disconnectChannel(channel: LarkChannel): Promise<void> {
    try {
      await channel.disconnect();
    } catch (error) {
      console.error("[ResilientLarkChannel] Failed to disconnect channel:", error);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
