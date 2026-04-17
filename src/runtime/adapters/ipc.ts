import { configManager, type DataConfig, type ScheduledJobConfig } from "../config.js";
import type { ResultsQueryService } from "../artifacts/index.js";
import {
  ConversationService,
  DEFAULT_WEB_CHANNEL_ID,
} from "../services/conversation.js";
import type { SchedulerAdapter } from "./scheduler.js";
import type {
  AdapterContext,
  AgentEvent,
  BotCommand,
  IPackAgent,
  IpcBroadcaster,
  PlatformAdapter,
} from "./types.js";
import { isMessageSender } from "./types.js";

type IpcRequest =
  | { id: string; type: "get_conversations" }
  | { id: string; type: "create_conversation" }
  | { id: string; type: "get_messages"; channelId: string; limit?: number }
  | { id: string; type: "get_result_runs"; channelId?: string; limit?: number }
  | { id: string; type: "get_run_artifacts"; runId: string }
  | { id: string; type: "get_recent_artifacts"; channelId?: string; limit?: number }
  | { id: string; type: "send_message"; channelId: string; text: string }
  | { id: string; type: "command"; command: BotCommand; channelId: string }
  | { id: string; type: "get_config" }
  | { id: string; type: "update_config"; updates: Partial<DataConfig> }
  | { id: string; type: "get_status" }
  | { id: string; type: "get_scheduled_jobs" }
  | { id: string; type: "add_scheduled_job"; job: ScheduledJobConfig }
  | { id: string; type: "remove_scheduled_job"; name: string };

export class IpcAdapter implements PlatformAdapter, IpcBroadcaster {
  readonly name = "ipc";

  private agent: IPackAgent | null = null;
  private rootDir = "";
  private adapterMap: Map<string, PlatformAdapter> | null = null;
  private conversationService: ConversationService | null = null;
  private resultsQueryService: ResultsQueryService | null = null;
  private readonly createdChannels = new Set<string>();
  private messageListener?: (message: unknown) => void;
  private started = false;

  async start(ctx: AdapterContext): Promise<void> {
    // IPC channel only exists when spawned via child_process.fork/spawn with stdio "ipc".
    if (typeof process.send !== "function") {
      return;
    }

    this.agent = ctx.agent;
    this.rootDir = ctx.rootDir;
    this.adapterMap = ctx.adapterMap ?? null;
    this.conversationService = new ConversationService(ctx.rootDir);
    this.resultsQueryService = ctx.resultsQueryService ?? null;

    this.messageListener = (message: unknown) => {
      if (!this.isIpcRequest(message)) return;
      void this.handleRequest(message);
    };
    process.on("message", this.messageListener);

    this.started = true;
    console.log("[IpcAdapter] Started");
  }

  async stop(): Promise<void> {
    if (this.messageListener) {
      process.off("message", this.messageListener);
      this.messageListener = undefined;
    }

    if (this.started) {
      console.log("[IpcAdapter] Stopped");
    }
    this.started = false;
  }

  notifyReady(port: number): void {
    this.sendIpc({
      type: "ready",
      port,
    });
  }

  broadcastInbound(
    channelId: string,
    platform: string,
    sender: { id: string; username: string },
    text: string,
  ): void {
    this.sendIpc({
      type: "inbound_message",
      channelId,
      platform,
      sender,
      text,
      timestamp: Date.now(),
    });
  }

  broadcastAgentEvent(channelId: string, event: AgentEvent): void {
    this.sendIpc({
      type: "agent_event",
      channelId,
      event,
    });
  }

  private isIpcRequest(message: unknown): message is IpcRequest {
    if (!message || typeof message !== "object") return false;
    const maybe = message as Record<string, unknown>;
    return typeof maybe.id === "string" && typeof maybe.type === "string";
  }

  private async handleRequest(request: IpcRequest): Promise<void> {
    if (!this.agent || !this.conversationService) {
      this.replyError(request.id, "IPC adapter is not ready yet");
      return;
    }

    try {
      switch (request.type) {
        case "get_conversations": {
          const activeChannels = new Set(this.agent.getActiveChannelIds());
          for (const channelId of this.createdChannels) {
            activeChannels.add(channelId);
          }
          const conversations = this.conversationService.listConversations(activeChannels, {
            includeDefaultWeb: true,
            includeLegacyWeb: false,
          });
          this.reply(request.id, conversations);
          return;
        }

        case "create_conversation": {
          const channelId = DEFAULT_WEB_CHANNEL_ID;
          this.createdChannels.add(channelId);
          this.reply(request.id, { channelId });
          return;
        }

        case "get_messages": {
          if (!request.channelId || typeof request.channelId !== "string") {
            this.replyError(request.id, "channelId is required");
            return;
          }
          const messages = this.conversationService.getMessages(
            request.channelId,
            request.limit ?? 100,
          );
          this.reply(request.id, messages);
          return;
        }

        case "get_result_runs": {
          if (!this.resultsQueryService) {
            this.replyError(request.id, "Results query service is not available");
            return;
          }
          this.reply(request.id, this.resultsQueryService.listRecentRuns({
            channelId: request.channelId,
            limit: request.limit,
          }));
          return;
        }

        case "get_run_artifacts": {
          if (!this.resultsQueryService) {
            this.replyError(request.id, "Results query service is not available");
            return;
          }
          if (!request.runId || typeof request.runId !== "string") {
            this.replyError(request.id, "runId is required");
            return;
          }
          this.reply(request.id, this.resultsQueryService.getRunArtifacts(request.runId));
          return;
        }

        case "get_recent_artifacts": {
          if (!this.resultsQueryService) {
            this.replyError(request.id, "Results query service is not available");
            return;
          }
          this.reply(request.id, this.resultsQueryService.listRecentArtifacts({
            channelId: request.channelId,
            limit: request.limit,
          }));
          return;
        }

        case "send_message": {
          if (!request.channelId || typeof request.channelId !== "string") {
            this.replyError(request.id, "channelId is required");
            return;
          }
          if (typeof request.text !== "string") {
            this.replyError(request.id, "text is required");
            return;
          }

          const platform = this.detectPlatform(request.channelId);
          this.createdChannels.add(request.channelId);
          let fullText = "";

          const result = await this.agent.handleMessage(
            platform,
            request.channelId,
            request.text,
            (event) => {
              if (event.type === "text_delta") {
                fullText += event.delta;
              }
              this.broadcastAgentEvent(request.channelId, event);
            },
          );

          if (fullText.trim() && platform !== "web" && platform !== "scheduler") {
            const adapter = this.adapterMap?.get(platform);
            if (adapter && isMessageSender(adapter)) {
              await adapter.sendMessage(request.channelId, fullText);
            }
          }

          this.reply(request.id, {
            ...result,
            text: fullText,
          });
          return;
        }

        case "command": {
          if (!request.channelId || typeof request.channelId !== "string") {
            this.replyError(request.id, "channelId is required");
            return;
          }
          const result = await this.agent.handleCommand(request.command, request.channelId);
          this.reply(request.id, result);
          return;
        }

        case "get_config": {
          this.reply(request.id, configManager.getConfig());
          return;
        }

        case "update_config": {
          configManager.save(this.rootDir, request.updates || {});
          const updated = configManager.getConfig();
          const provider = updated.provider || "openai";
          this.agent.updateAuth(provider, updated.apiKey);
          this.reply(request.id, updated);
          return;
        }

        case "get_status": {
          this.reply(request.id, {
            status: "running",
            pid: process.pid,
          });
          return;
        }

        case "get_scheduled_jobs": {
          const scheduler = this.getSchedulerAdapter();
          this.reply(request.id, scheduler ? scheduler.listJobs() : []);
          return;
        }

        case "add_scheduled_job": {
          const scheduler = this.getSchedulerAdapter();
          if (!scheduler) {
            this.replyError(request.id, "Scheduler adapter is not available");
            return;
          }
          const result = scheduler.addJob(request.job);
          if (!result.success) {
            this.replyError(request.id, result.message);
            return;
          }
          this.reply(request.id, result);
          return;
        }

        case "remove_scheduled_job": {
          const scheduler = this.getSchedulerAdapter();
          if (!scheduler) {
            this.replyError(request.id, "Scheduler adapter is not available");
            return;
          }
          const result = scheduler.removeJob(request.name);
          if (!result.success) {
            this.replyError(request.id, result.message);
            return;
          }
          this.reply(request.id, result);
          return;
        }
      }
    } catch (err) {
      this.replyError(
        request.id,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private getSchedulerAdapter(): SchedulerAdapter | null {
    const adapter = this.adapterMap?.get("scheduler");
    if (!adapter) return null;
    return adapter as SchedulerAdapter;
  }

  private detectPlatform(
    channelId: string,
  ): "telegram" | "slack" | "web" | "scheduler" {
    if (channelId.startsWith("telegram-")) return "telegram";
    if (channelId.startsWith("slack-")) return "slack";
    if (channelId.startsWith("scheduler-")) return "scheduler";
    return "web";
  }

  private sendIpc(payload: unknown): void {
    if (typeof process.send === "function") {
      process.send(payload as any);
    }
  }

  private reply(id: string, data: unknown): void {
    this.sendIpc({ id, type: "result", data });
  }

  private replyError(id: string, message: string): void {
    this.sendIpc({ id, type: "error", message });
  }
}
