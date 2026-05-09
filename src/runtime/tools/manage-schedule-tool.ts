import { Type, type Static } from "@sinclair/typebox";

import type {
  ToolDefinition,
  AgentToolResult,
} from "@mariozechner/pi-coding-agent";
import type { SchedulerAdapter } from "../adapters/scheduler.js";
import type {
  NotifyTargetPlatform,
  RuntimePlatform,
} from "../adapters/types.js";
import type { ScheduledJobConfig } from "../../job-config.js";

// ---------------------------------------------------------------------------
// Parameter schema (TypeBox)
// ---------------------------------------------------------------------------

const ManageScheduleParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("add"),
      Type.Literal("list"),
      Type.Literal("remove"),
      Type.Literal("trigger"),
      Type.Literal("enable"),
      Type.Literal("disable"),
    ],
    { description: "The action to perform." },
  ),
  name: Type.Optional(
    Type.String({
      description:
        "Unique name for the scheduled task. Required for add/remove/trigger/enable/disable.",
    }),
  ),
  cron: Type.Optional(
    Type.String({
      description:
        "Cron expression (5 fields: minute hour day month weekday). Required for add.",
    }),
  ),
  prompt: Type.Optional(
    Type.String({
      description:
        "The work prompt to execute when the task triggers. Required for add. Describe only what to do each run; do not repeat timing, cron, or 'every N minutes' instructions here.",
    }),
  ),
  timezone: Type.Optional(
    Type.String({
      description:
        "Optional timezone for the cron schedule, e.g. 'Asia/Shanghai', 'America/New_York'.",
    }),
  ),
  notifyAdapter: Type.Optional(
    Type.String({
      description:
        "Optional target adapter for notifications. If omitted, the current chat is used when supported (Telegram, Slack, Feishu, or Web).",
    }),
  ),
  notifyChannelId: Type.Optional(
    Type.String({
      description:
        "Optional target channelId for notifications. Must be provided together with notifyAdapter when overriding the default target.",
    }),
  ),
});

type ManageScheduleInput = Static<typeof ManageScheduleParams>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

function getDefaultNotifyTarget(
  adapter: RuntimePlatform,
  channelId: string,
): { adapter: NotifyTargetPlatform; channelId: string } | null {
  if (adapter === "telegram" && channelId.startsWith("telegram-")) {
    return { adapter: "telegram", channelId };
  }

  if (adapter === "slack" && channelId.startsWith("slack-")) {
    return { adapter: "slack", channelId };
  }

  if (adapter === "feishu" && channelId.startsWith("feishu-")) {
    return { adapter: "feishu", channelId };
  }

  if (adapter === "web") {
    return { adapter: "web", channelId };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

/**
 * Create the manage_scheduled_task tool definition for the Agent.
 *
 * The tool allows the Agent to create, list, remove, enable/disable,
 * or manually trigger scheduled tasks through natural language conversation.
 */
export function createManageScheduleTool(
  schedulerRef: { current: SchedulerAdapter | null },
  adapter: RuntimePlatform,
  channelId: string,
): ToolDefinition<typeof ManageScheduleParams> {

  return {
    name: "manage_scheduled_task",
    label: "Manage Scheduled Task",
    description: [
      "Manage scheduled tasks (cron jobs) that automatically execute prompts and push results to IM channels.",
      "",
      "Actions:",
      "- add: Create a new scheduled task. Requires: name, cron, prompt. Notifications default to the current Telegram, Slack, Feishu, or Web chat. You can override the destination with notifyAdapter + notifyChannelId. The prompt must describe only the work for each run, not the schedule itself.",
      "- list: List all scheduled tasks with their status.",
      "- remove: Remove a scheduled task by name.",
      "- trigger: Manually trigger a scheduled task by name (runs immediately).",
      "- enable: Enable a disabled scheduled task.",
      "- disable: Disable a scheduled task without removing it.",
      "",
      "Cron expression format: '* * * * *' (minute hour day month weekday)",
      "Examples:",
      "  '0 9 * * 1-5'  = every weekday at 9:00 AM",
      "  '0 18 * * 5'   = every Friday at 6:00 PM",
      "  '*/30 * * * *'  = every 30 minutes",
    ].join("\n"),
    parameters: ManageScheduleParams,
    async execute(
      _toolCallId,
      params: ManageScheduleInput,
      _signal,
      _onUpdate,
      _ctx,
    ): Promise<AgentToolResult<undefined>> {
      const scheduler = schedulerRef.current;
      if (!scheduler) {
        return textResult(
          "Error: Scheduler is not available. The scheduled task system may not be initialized.",
        );
      }

      switch (params.action) {
        case "list": {
          const jobs = scheduler.listJobs();
          if (jobs.length === 0) {
            return textResult("No scheduled tasks configured.");
          }
          const lines = jobs.map(
            (j) =>
              `- **${j.name}**: \`${j.cron}\` → ${j.notify.adapter}:${j.notify.channelId} [${j.enabled ? "enabled" : "disabled"}]${j.running ? " (running)" : ""}${j.lastRunAt ? ` (last: ${j.lastRunAt})` : ""}`,
          );
          return textResult(
            `Scheduled tasks (${jobs.length}):\n${lines.join("\n")}`,
          );
        }

        case "add": {
          if (!params.name || !params.cron || !params.prompt) {
            return textResult(
              "Error: 'name', 'cron', and 'prompt' are required for adding a task.",
            );
          }

          if (
            (params.notifyAdapter && !params.notifyChannelId) ||
            (!params.notifyAdapter && params.notifyChannelId)
          ) {
            return textResult(
              "Error: 'notifyAdapter' and 'notifyChannelId' must be provided together when overriding the notification target.",
            );
          }

          const notify = params.notifyAdapter && params.notifyChannelId
            ? {
              adapter: params.notifyAdapter,
              channelId: params.notifyChannelId,
            }
            : getDefaultNotifyTarget(adapter, channelId);

          if (!notify) {
            return textResult(
              "Error: No default notification target is available for this chat. Provide 'notifyAdapter' and 'notifyChannelId'.",
            );
          }

          const jobConfig: ScheduledJobConfig = {
            name: params.name,
            cron: params.cron,
            prompt: params.prompt,
            notify,
            enabled: true,
            timezone: params.timezone,
          };

          const result = scheduler.addJob(jobConfig);
          return textResult(result.message);
        }

        case "remove": {
          if (!params.name) {
            return textResult(
              "Error: 'name' is required for removing a task.",
            );
          }
          const result = scheduler.removeJob(params.name);
          return textResult(result.message);
        }

        case "trigger": {
          if (!params.name) {
            return textResult(
              "Error: 'name' is required for triggering a task.",
            );
          }
          const result = await scheduler.triggerJob(params.name);
          return textResult(result.message);
        }

        case "enable": {
          if (!params.name) {
            return textResult(
              "Error: 'name' is required for enabling a task.",
            );
          }
          const result = scheduler.setEnabled(params.name, true);
          return textResult(result.message);
        }

        case "disable": {
          if (!params.name) {
            return textResult(
              "Error: 'name' is required for disabling a task.",
            );
          }
          const result = scheduler.setEnabled(params.name, false);
          return textResult(result.message);
        }

        default:
          return textResult(
            `Error: Unknown action '${params.action}'. Use: add, list, remove, trigger, enable, disable.`,
          );
      }
    },
  };
}
