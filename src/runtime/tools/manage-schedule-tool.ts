import { Type, type Static } from "@sinclair/typebox";

import type {
  ToolDefinition,
  AgentToolResult,
} from "@mariozechner/pi-coding-agent";
import type { SchedulerAdapter } from "../adapters/scheduler.js";
import type { ScheduledJobConfig } from "../config.js";

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
  notifyAdapter: Type.Optional(
    Type.String({
      description:
        "Target adapter name for result notification: 'telegram' or 'slack'. Required for add.",
    }),
  ),
  notifyChannelId: Type.Optional(
    Type.String({
      description:
        "Target channelId for result notification (e.g. 'telegram-123456'). Required for add.",
    }),
  ),
  timezone: Type.Optional(
    Type.String({
      description:
        "Optional timezone for the cron schedule, e.g. 'Asia/Shanghai', 'America/New_York'.",
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
  _rootDirRef: { current: string },
): ToolDefinition<typeof ManageScheduleParams> {
  return {
    name: "manage_scheduled_task",
    label: "Manage Scheduled Task",
    description: [
      "Manage scheduled tasks (cron jobs) that automatically execute prompts and push results to IM channels.",
      "",
      "Actions:",
      "- add: Create a new scheduled task. Requires: name, cron, prompt, notifyAdapter, notifyChannelId. The prompt must describe only the work for each run, not the schedule itself.",
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
      "",
      "notifyAdapter: 'telegram' or 'slack'",
      "notifyChannelId: the channel ID where result will be sent (e.g. 'telegram-123456')",
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
          if (!params.notifyAdapter || !params.notifyChannelId) {
            return textResult(
              "Error: 'notifyAdapter' and 'notifyChannelId' are required for adding a task.",
            );
          }

          const jobConfig: ScheduledJobConfig = {
            name: params.name,
            cron: params.cron,
            prompt: params.prompt,
            notify: {
              adapter: params.notifyAdapter,
              channelId: params.notifyChannelId,
            },
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
