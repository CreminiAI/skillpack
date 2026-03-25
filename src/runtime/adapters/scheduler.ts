import cron from "node-cron";

import type {
  PlatformAdapter,
  AdapterContext,
  IPackAgent,
  AgentEvent,
} from "./types.js";
import type { ScheduledJobConfig } from "../config.js";
import { configManager } from "../config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Only allow safe characters in job names to prevent path traversal. */
const VALID_JOB_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ManagedJob {
  config: ScheduledJobConfig;
  /** null when the job is disabled (no cron task created) */
  task: ReturnType<typeof cron.schedule> | null;
  lastRunAt?: string;
  lastResult?: string;
  lastError?: string;
  /** true while the agent is executing the prompt */
  running: boolean;
  /** true while notification delivery failed on the last run */
  notifyFailed: boolean;
}

export interface JobStatus {
  name: string;
  cron: string;
  prompt: string;
  notify: { adapter: string; channelId: string };
  enabled: boolean;
  timezone?: string;
  lastRunAt?: string;
  lastError?: string;
  running: boolean;
  notifyFailed: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate that a timezone string is recognised by the runtime.
 * Returns true if valid, false otherwise.
 */
function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a job name: must be non-empty, match the safe pattern,
 * and must not contain path-separator tricks.
 */
function isValidJobName(name: string): boolean {
  return VALID_JOB_NAME.test(name) && name.length <= 64;
}

// ---------------------------------------------------------------------------
// SchedulerAdapter
// ---------------------------------------------------------------------------

export class SchedulerAdapter implements PlatformAdapter {
  readonly name = "scheduler";

  private agent!: IPackAgent;
  private rootDir = "";
  private notifyFn: (
    adapter: string,
    channelId: string,
    text: string,
  ) => Promise<void> = async () => {};
  private jobs = new Map<string, ManagedJob>();

  async start(ctx: AdapterContext): Promise<void> {
    this.agent = ctx.agent;
    this.rootDir = ctx.rootDir;
    this.notifyFn = ctx.notify || (async () => {});

    // Load initial jobs from config
    const config = configManager.getConfig();
    const jobConfigs = config.scheduledJobs || [];

    let scheduledCount = 0;
    let disabledCount = 0;
    for (const jc of jobConfigs) {
      const result = this.registerJob(jc);
      if (result.registered) {
        if (jc.enabled === false) {
          disabledCount++;
        } else {
          scheduledCount++;
        }
      }
    }

    const parts: string[] = [];
    if (scheduledCount > 0) parts.push(`${scheduledCount} active`);
    if (disabledCount > 0) parts.push(`${disabledCount} disabled`);
    if (parts.length > 0) {
      console.log(`[SchedulerAdapter] Started with ${parts.join(", ")} job(s)`);
    } else {
      console.log("[SchedulerAdapter] Started (no jobs configured)");
    }
  }

  // -------------------------------------------------------------------------
  // Core: register a job into the managed map
  // -------------------------------------------------------------------------

  /**
   * Register a job: validate, create cron task (if enabled), store in map.
   * Does NOT persist – callers decide when to persist.
   */
  private registerJob(
    jobConfig: ScheduledJobConfig,
  ): { registered: boolean; message: string } {
    // Validate name
    if (!isValidJobName(jobConfig.name)) {
      const msg = `[Scheduler] Invalid job name "${jobConfig.name}": must match ${VALID_JOB_NAME} and be ≤64 chars`;
      console.error(msg);
      return { registered: false, message: msg };
    }

    // Validate cron expression
    if (!cron.validate(jobConfig.cron)) {
      const msg = `[Scheduler] Invalid cron expression for job "${jobConfig.name}": ${jobConfig.cron}`;
      console.error(msg);
      return { registered: false, message: msg };
    }

    // Validate timezone if provided
    if (jobConfig.timezone && !isValidTimezone(jobConfig.timezone)) {
      const msg = `[Scheduler] Invalid timezone for job "${jobConfig.name}": ${jobConfig.timezone}`;
      console.error(msg);
      return { registered: false, message: msg };
    }

    // Stop/remove existing job with the same name if any
    this.removeFromMap(jobConfig.name);

    // Create cron task only when enabled
    let task: ReturnType<typeof cron.schedule> | null = null;
    if (jobConfig.enabled !== false) {
      task = cron.schedule(
        jobConfig.cron,
        () => {
          void this.runJob(jobConfig);
        },
        {
          timezone: jobConfig.timezone,
        },
      );

      console.log(
        `[Scheduler] Job "${jobConfig.name}" scheduled: ${jobConfig.cron}${jobConfig.timezone ? ` (${jobConfig.timezone})` : ""}`,
      );
    } else {
      console.log(
        `[Scheduler] Job "${jobConfig.name}" registered (disabled)`,
      );
    }

    this.jobs.set(jobConfig.name, {
      config: jobConfig,
      task,
      running: false,
      notifyFailed: false,
    });

    return { registered: true, message: "" };
  }

  // -------------------------------------------------------------------------
  // Job execution
  // -------------------------------------------------------------------------

  /**
   * Execute a scheduled job: call agent.handleMessage and push results.
   * Returns { text, notifyFailed } so callers can produce accurate status.
   */
  private async runJob(
    jobConfig: ScheduledJobConfig,
  ): Promise<{ text: string; notifyFailed: boolean }> {
    const channelId = `scheduler-${jobConfig.name}`;
    const job = this.jobs.get(jobConfig.name);

    if (job?.running) {
      console.warn(
        `[Scheduler] Job "${jobConfig.name}" is already running, skipping this trigger`,
      );
      return { text: "", notifyFailed: false };
    }

    if (job) job.running = true;

    console.log(`[Scheduler] Running job "${jobConfig.name}"`);

    let fullText = "";
    let agentFailed = false;
    const pendingFiles: Array<{ filePath: string; caption?: string }> = [];

    const onEvent = (event: AgentEvent) => {
      if (event.type === "text_delta") fullText += event.delta;
      if (event.type === "file_output") {
        pendingFiles.push({
          filePath: event.filePath,
          caption: event.caption,
        });
      }
    };

    try {
      const result = await this.agent.handleMessage(
        channelId,
        jobConfig.prompt,
        onEvent,
      );

      if (result.errorMessage) {
        fullText = `❌ 定时任务 "${jobConfig.name}" 执行失败：${result.errorMessage}`;
        agentFailed = true;
        if (job) job.lastError = result.errorMessage;
      } else {
        if (job) job.lastError = undefined;
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      fullText = `❌ 定时任务 "${jobConfig.name}" 异常：${errorMsg}`;
      agentFailed = true;
      if (job) job.lastError = errorMsg;
    }

    // Update run timestamp
    if (job) {
      job.lastRunAt = new Date().toISOString();
      job.lastResult = fullText.slice(0, 200);
    }

    // Push text result to IM
    let notifyFailed = false;
    if (fullText.trim()) {
      try {
        await this.notifyFn(
          jobConfig.notify.adapter,
          jobConfig.notify.channelId,
          fullText,
        );
      } catch (err) {
        notifyFailed = true;
        const notifyErr = err instanceof Error ? err.message : String(err);
        console.error(
          `[Scheduler] Failed to notify for job "${jobConfig.name}":`,
          err,
        );
        // Append notify failure to lastError so it's visible via API
        if (job) {
          job.lastError = agentFailed
            ? `${job.lastError}; Notify also failed: ${notifyErr}`
            : `Notify failed: ${notifyErr}`;
        }
      }
    }

    if (job) {
      job.running = false;
      job.notifyFailed = notifyFailed;
    }

    return { text: fullText, notifyFailed };
  }

  // -------------------------------------------------------------------------
  // Dynamic management API
  // -------------------------------------------------------------------------

  /**
   * Add a new job, persist to config.json.
   */
  addJob(jobConfig: ScheduledJobConfig): { success: boolean; message: string } {
    if (this.jobs.has(jobConfig.name)) {
      return {
        success: false,
        message: `Job "${jobConfig.name}" already exists. Remove it first.`,
      };
    }

    const result = this.registerJob(jobConfig);
    if (!result.registered) {
      return { success: false, message: result.message };
    }

    this.persistJobs();

    const enabled = jobConfig.enabled !== false;
    return {
      success: true,
      message: enabled
        ? `Job "${jobConfig.name}" created and scheduled.`
        : `Job "${jobConfig.name}" created (disabled).`,
    };
  }

  /**
   * Remove a job and persist to config.json.
   */
  removeJob(name: string): { success: boolean; message: string } {
    if (!this.jobs.has(name)) {
      return { success: false, message: `Job "${name}" not found.` };
    }

    this.removeFromMap(name);
    this.persistJobs();

    return { success: true, message: `Job "${name}" removed.` };
  }

  /**
   * Enable or disable a job and persist.
   */
  setEnabled(
    name: string,
    enabled: boolean,
  ): { success: boolean; message: string } {
    const job = this.jobs.get(name);
    if (!job) {
      return { success: false, message: `Job "${name}" not found.` };
    }

    job.config.enabled = enabled;

    if (enabled && !job.task) {
      // Create a new cron task for a previously disabled job
      job.task = cron.schedule(
        job.config.cron,
        () => {
          void this.runJob(job.config);
        },
        {
          timezone: job.config.timezone,
        },
      );
    } else if (enabled && job.task) {
      job.task.start();
    } else if (!enabled && job.task) {
      job.task.stop();
    }

    this.persistJobs();

    return {
      success: true,
      message: `Job "${name}" ${enabled ? "enabled" : "disabled"}.`,
    };
  }

  /**
   * Manually trigger a job (runs immediately, ignoring cron schedule).
   */
  async triggerJob(name: string): Promise<{ success: boolean; message: string }> {
    const job = this.jobs.get(name);
    if (!job) {
      return { success: false, message: `Job "${name}" not found.` };
    }

    const { text, notifyFailed } = await this.runJob(job.config);

    if (!text) {
      return {
        success: true,
        message: `Job "${name}" triggered but produced no output.`,
      };
    }
    if (notifyFailed) {
      return {
        success: true,
        message: `Job "${name}" executed, but notification to ${job.config.notify.adapter} failed. Check logs.`,
      };
    }
    return {
      success: true,
      message: `Job "${name}" triggered. Result sent to ${job.config.notify.adapter}.`,
    };
  }

  /**
   * List all jobs with their current status.
   */
  listJobs(): JobStatus[] {
    const result: JobStatus[] = [];
    for (const [, job] of this.jobs) {
      result.push({
        name: job.config.name,
        cron: job.config.cron,
        prompt: job.config.prompt,
        notify: job.config.notify,
        enabled: job.config.enabled !== false,
        timezone: job.config.timezone,
        lastRunAt: job.lastRunAt,
        lastError: job.lastError,
        running: job.running,
        notifyFailed: job.notifyFailed,
      });
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Stop the cron task and remove a job from the map (does NOT persist).
   */
  private removeFromMap(name: string): void {
    const existing = this.jobs.get(name);
    if (existing) {
      existing.task?.stop();
      this.jobs.delete(name);
    }
  }

  /**
   * Persist all current jobs to data/config.json.
   */
  private persistJobs(): void {
    const configs: ScheduledJobConfig[] = [];
    for (const [, job] of this.jobs) {
      configs.push(job.config);
    }
    configManager.save(this.rootDir, { scheduledJobs: configs });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async stop(): Promise<void> {
    for (const [, job] of this.jobs) {
      job.task?.stop();
    }
    this.jobs.clear();
    console.log("[SchedulerAdapter] All jobs stopped.");
  }
}
