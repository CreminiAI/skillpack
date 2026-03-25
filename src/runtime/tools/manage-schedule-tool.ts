import type { SchedulerAdapter } from "../adapters/scheduler.js";
import type { ScheduledJobConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ManageScheduleParams {
  action: "add" | "list" | "remove" | "trigger" | "enable" | "disable";
  name?: string;
  cron?: string;
  prompt?: string;
  notifyAdapter?: string;
  notifyChannelId?: string;
  timezone?: string;
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
  rootDirRef: { current: string },
) {
  return {
    name: "manage_scheduled_task",
    description: [
      "Manage scheduled tasks (cron jobs) that automatically execute prompts and push results to IM channels.",
      "",
      "Actions:",
      "- add: Create a new scheduled task. Requires: name, cron, prompt, notifyAdapter, notifyChannelId.",
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
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: ["add", "list", "remove", "trigger", "enable", "disable"],
          description: "The action to perform.",
        },
        name: {
          type: "string" as const,
          description:
            "Unique name for the scheduled task. Required for add/remove/trigger/enable/disable.",
        },
        cron: {
          type: "string" as const,
          description:
            "Cron expression (5 fields: minute hour day month weekday). Required for add.",
        },
        prompt: {
          type: "string" as const,
          description:
            "The prompt to execute when the task triggers. Required for add.",
        },
        notifyAdapter: {
          type: "string" as const,
          description:
            "Target adapter name for result notification: 'telegram' or 'slack'. Required for add.",
        },
        notifyChannelId: {
          type: "string" as const,
          description:
            "Target channelId for result notification (e.g. 'telegram-123456'). Required for add.",
        },
        timezone: {
          type: "string" as const,
          description:
            "Optional timezone for the cron schedule, e.g. 'Asia/Shanghai', 'America/New_York'.",
        },
      },
      required: ["action"],
    },
    execute: async (params: ManageScheduleParams): Promise<string> => {
      const scheduler = schedulerRef.current;
      if (!scheduler) {
        return "Error: Scheduler is not available. The scheduled task system may not be initialized.";
      }

      switch (params.action) {
        case "list": {
          const jobs = scheduler.listJobs();
          if (jobs.length === 0) {
            return "No scheduled tasks configured.";
          }
          const lines = jobs.map(
            (j) =>
              `- **${j.name}**: \`${j.cron}\` → ${j.notify.adapter}:${j.notify.channelId} [${j.enabled ? "enabled" : "disabled"}]${j.running ? " (running)" : ""}${j.lastRunAt ? ` (last: ${j.lastRunAt})` : ""}`,
          );
          return `Scheduled tasks (${jobs.length}):\n${lines.join("\n")}`;
        }

        case "add": {
          if (!params.name || !params.cron || !params.prompt) {
            return "Error: 'name', 'cron', and 'prompt' are required for adding a task.";
          }
          if (!params.notifyAdapter || !params.notifyChannelId) {
            return "Error: 'notifyAdapter' and 'notifyChannelId' are required for adding a task.";
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
          return result.message;
        }

        case "remove": {
          if (!params.name) {
            return "Error: 'name' is required for removing a task.";
          }
          const result = scheduler.removeJob(params.name);
          return result.message;
        }

        case "trigger": {
          if (!params.name) {
            return "Error: 'name' is required for triggering a task.";
          }
          const result = await scheduler.triggerJob(params.name);
          return result.message;
        }

        case "enable": {
          if (!params.name) {
            return "Error: 'name' is required for enabling a task.";
          }
          const result = scheduler.setEnabled(params.name, true);
          return result.message;
        }

        case "disable": {
          if (!params.name) {
            return "Error: 'name' is required for disabling a task.";
          }
          const result = scheduler.setEnabled(params.name, false);
          return result.message;
        }

        default:
          return `Error: Unknown action '${params.action}'. Use: add, list, remove, trigger, enable, disable.`;
      }
    },
  };
}
