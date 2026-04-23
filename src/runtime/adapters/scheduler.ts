import cron from "node-cron";

import type {
  PlatformAdapter,
  AdapterContext,
  IPackAgent,
  AgentEvent,
} from "./types.js";
import {
  loadJobFile,
  saveJobFile,
  normalizeScheduledJobConfig,
  type ScheduledJobConfig,
} from "../../job-config.js";
import { hasJobSchedule, normalizeJobCron } from "../../job-schedule.js";

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
  /** null when the job is one-time or disabled (no cron task created) */
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
  cron?: string;
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

function isRecurringJob(jobConfig: ScheduledJobConfig): boolean {
  return hasJobSchedule(jobConfig);
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

    const jobConfigs = loadJobFile(this.rootDir).jobs;

    let scheduledCount = 0;
    let disabledCount = 0;
    let oneTimeCount = 0;
    for (const jc of jobConfigs) {
      const result = this.registerJob(jc);
      if (result.registered) {
        if (!isRecurringJob(jc)) {
          oneTimeCount++;
        } else if (jc.enabled === false) {
          disabledCount++;
        } else {
          scheduledCount++;
        }
      }
    }

    const parts: string[] = [];
    if (scheduledCount > 0) parts.push(`${scheduledCount} active`);
    if (disabledCount > 0) parts.push(`${disabledCount} disabled`);
    if (oneTimeCount > 0) parts.push(`${oneTimeCount} one-time`);
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
    const normalizedConfig = normalizeScheduledJobConfig(jobConfig);
    const normalizedCron = normalizeJobCron(normalizedConfig.cron);

    // Validate name
    if (!isValidJobName(normalizedConfig.name)) {
      const msg = `[Scheduler] Invalid job name "${normalizedConfig.name}": must match ${VALID_JOB_NAME} and be ≤64 chars`;
      console.error(msg);
      return { registered: false, message: msg };
    }

    if (normalizedCron) {
      // Validate cron expression
      if (!cron.validate(normalizedCron)) {
        const msg = `[Scheduler] Invalid cron expression for job "${normalizedConfig.name}": ${normalizedCron}`;
        console.error(msg);
        return { registered: false, message: msg };
      }

      // Validate timezone if provided
      if (normalizedConfig.timezone && !isValidTimezone(normalizedConfig.timezone)) {
        const msg = `[Scheduler] Invalid timezone for job "${normalizedConfig.name}": ${normalizedConfig.timezone}`;
        console.error(msg);
        return { registered: false, message: msg };
      }
    }

    // Stop/remove existing job with the same name if any
    this.removeFromMap(normalizedConfig.name);

    // Create cron task only for recurring enabled jobs
    let task: ReturnType<typeof cron.schedule> | null = null;
    if (normalizedCron && normalizedConfig.enabled !== false) {
      task = this.createCronTask(normalizedConfig);
      console.log(
        `[Scheduler] Job "${normalizedConfig.name}" scheduled: ${normalizedCron}${normalizedConfig.timezone ? ` (${normalizedConfig.timezone})` : ""}`,
      );
    } else if (normalizedCron) {
      console.log(
        `[Scheduler] Job "${normalizedConfig.name}" registered (disabled)`,
      );
    } else {
      console.log(
        `[Scheduler] Job "${normalizedConfig.name}" registered as one-time (manual trigger only)`,
      );
    }

    this.jobs.set(normalizedConfig.name, {
      config: normalizedConfig,
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
      await this.clearJobContext(channelId);

      const result = await this.agent.handleMessage(
        "scheduler",
        channelId,
        jobConfig.prompt,
        onEvent,
        undefined,
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

  private async clearJobContext(channelId: string): Promise<void> {
    const result = await this.agent.handleCommand("clear", channelId);
    if (!result.success) {
      throw new Error(result.message || `Failed to clear context for ${channelId}`);
    }
  }

  // -------------------------------------------------------------------------
  // Dynamic management API
  // -------------------------------------------------------------------------

  /**
   * Add a new job, persist to job.json.
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

    const recurring = isRecurringJob(jobConfig);
    const enabled = recurring ? jobConfig.enabled !== false : true;
    return {
      success: true,
      message: recurring
        ? enabled
          ? `Job "${jobConfig.name}" created and scheduled.`
          : `Job "${jobConfig.name}" created (disabled).`
        : `Job "${jobConfig.name}" created as a one-time task.`,
    };
  }

  /**
   * Remove a job and persist to job.json.
   */
  removeJob(name: string): { success: boolean; message: string } {
    if (!this.jobs.has(name)) {
      return { success: false, message: `Job "${name}" not found.` };
    }

    this.removeFromMap(name);
    this.persistJobs();

    return { success: true, message: `Job "${name}" removed.` };
  }

  updateJob(
    name: string,
    updates: Omit<ScheduledJobConfig, "name">,
  ): { success: boolean; message: string } {
    const job = this.jobs.get(name);
    if (!job) {
      return { success: false, message: `Job "${name}" not found.` };
    }

    const nextConfig: ScheduledJobConfig = {
      name,
      cron: updates.cron,
      prompt: updates.prompt,
      notify: updates.notify,
      enabled: updates.enabled,
      timezone: updates.timezone,
    };

    const result = this.registerJob(nextConfig);
    if (!result.registered) {
      return { success: false, message: result.message };
    }

    this.persistJobs();
    return {
      success: true,
      message: `Job "${name}" updated.`,
    };
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

    if (!isRecurringJob(job.config)) {
      return {
        success: false,
        message: `Job "${name}" does not have a schedule and cannot be enabled or disabled.`,
      };
    }

    job.config.enabled = enabled;

    if (enabled && !job.task) {
      // Create a new cron task for a previously disabled job
      job.task = this.createCronTask(job.config);
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
        ...(job.config.cron ? { cron: job.config.cron } : {}),
        prompt: job.config.prompt,
        notify: job.config.notify,
        enabled: isRecurringJob(job.config) ? job.config.enabled !== false : true,
        ...(job.config.timezone ? { timezone: job.config.timezone } : {}),
        ...(job.lastRunAt ? { lastRunAt: job.lastRunAt } : {}),
        ...(job.lastError ? { lastError: job.lastError } : {}),
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
   * Persist all current jobs to job.json.
   */
  private persistJobs(): void {
    const configs: ScheduledJobConfig[] = [];
    for (const [, job] of this.jobs) {
      configs.push(job.config);
    }
    saveJobFile(this.rootDir, { jobs: configs });
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

  private createCronTask(jobConfig: ScheduledJobConfig): ReturnType<typeof cron.schedule> {
    const cronExpr = normalizeJobCron(jobConfig.cron);
    if (!cronExpr) {
      throw new Error(`Job "${jobConfig.name}" does not have a valid cron expression`);
    }

    return cron.schedule(
      cronExpr,
      () => {
        void this.runJob(jobConfig);
      },
      {
        timezone: jobConfig.timezone,
      },
    );
  }
}
