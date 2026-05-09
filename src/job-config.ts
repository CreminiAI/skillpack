import fs from "node:fs";
import path from "node:path";

import { normalizeJobCron } from "./job-schedule.js";

export interface ScheduledJobConfig {
  /** Stable machine identifier */
  id: string;
  /** Human-readable display name */
  name: string;
  /** Standard 5-field cron expression; omit for one-time manual jobs */
  cron?: string;
  /** Prompt to send to the Agent when triggered */
  prompt: string;
  /** Where to push the result */
  notify: {
    adapter: string;
    channelId: string;
  };
  /** Defaults to true; set false to skip */
  enabled?: boolean;
  /** Optional timezone, e.g. "Asia/Shanghai" */
  timezone?: string;
}

export interface JobFile {
  jobs: ScheduledJobConfig[];
}

export const JOB_FILE = "job.json";

export function getJobFilePath(workDir: string): string {
  return path.join(workDir, JOB_FILE);
}

function validateScheduledJobConfig(
  value: unknown,
  sourceLabel: string,
  index: number,
): asserts value is ScheduledJobConfig {
  if (!value || typeof value !== "object") {
    throw new Error(
      `Invalid job config from ${sourceLabel}: "jobs[${index}]" must be an object`,
    );
  }

  const job = value as Record<string, unknown>;
  if (typeof job.id !== "string" || !job.id.trim()) {
    throw new Error(
      `Invalid job config from ${sourceLabel}: "jobs[${index}].id" is required`,
    );
  }

  if (typeof job.name !== "string" || !job.name.trim()) {
    throw new Error(
      `Invalid job config from ${sourceLabel}: "jobs[${index}].name" is required`,
    );
  }

  if (job.cron !== undefined && typeof job.cron !== "string") {
    throw new Error(
      `Invalid job config from ${sourceLabel}: "jobs[${index}].cron" must be a string`,
    );
  }

  if (typeof job.prompt !== "string" || !job.prompt.trim()) {
    throw new Error(
      `Invalid job config from ${sourceLabel}: "jobs[${index}].prompt" is required`,
    );
  }

  if (!job.notify || typeof job.notify !== "object") {
    throw new Error(
      `Invalid job config from ${sourceLabel}: "jobs[${index}].notify" must be an object`,
    );
  }

  const notify = job.notify as Record<string, unknown>;
  if (typeof notify.adapter !== "string" || !notify.adapter.trim()) {
    throw new Error(
      `Invalid job config from ${sourceLabel}: "jobs[${index}].notify.adapter" is required`,
    );
  }

  if (typeof notify.channelId !== "string" || !notify.channelId.trim()) {
    throw new Error(
      `Invalid job config from ${sourceLabel}: "jobs[${index}].notify.channelId" is required`,
    );
  }

  if (job.enabled !== undefined && typeof job.enabled !== "boolean") {
    throw new Error(
      `Invalid job config from ${sourceLabel}: "jobs[${index}].enabled" must be a boolean`,
    );
  }

  if (job.timezone !== undefined && typeof job.timezone !== "string") {
    throw new Error(
      `Invalid job config from ${sourceLabel}: "jobs[${index}].timezone" must be a string`,
    );
  }
}

export function validateJobFileShape(
  value: unknown,
  sourceLabel: string,
): asserts value is JobFile {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid job config from ${sourceLabel}: expected a JSON object`);
  }

  const jobFile = value as Record<string, unknown>;
  if (!Array.isArray(jobFile.jobs)) {
    throw new Error(`Invalid job config from ${sourceLabel}: "jobs" must be an array`);
  }

  const ids = new Set<string>();
  jobFile.jobs.forEach((job, index) => {
    validateScheduledJobConfig(job, sourceLabel, index);
    const normalizedId = job.id.trim().toLowerCase();
    if (ids.has(normalizedId)) {
      throw new Error(
        `Invalid job config from ${sourceLabel}: duplicate job id "${job.id}" is not allowed`,
      );
    }
    ids.add(normalizedId);
  });
}

function normalizeJobFile(jobFile: JobFile): JobFile {
  return {
    jobs: jobFile.jobs.map((job) => ({
      ...normalizeScheduledJobConfig(job),
    })),
  };
}

export function normalizeScheduledJobConfig(job: ScheduledJobConfig): ScheduledJobConfig {
  const normalizedCron = normalizeJobCron(job.cron);
  const normalizedTimezone =
    typeof job.timezone === "string" && job.timezone.trim()
      ? job.timezone.trim()
      : undefined;

  return {
    id: job.id.trim(),
    name: job.name.trim(),
    ...(normalizedCron ? { cron: normalizedCron } : {}),
    prompt: job.prompt,
    notify: {
      adapter: job.notify.adapter.trim(),
      channelId: job.notify.channelId.trim(),
    },
    ...(normalizedCron && job.enabled !== undefined ? { enabled: job.enabled } : {}),
    ...(normalizedCron && normalizedTimezone ? { timezone: normalizedTimezone } : {}),
  };
}

export function loadJobFile(workDir: string): JobFile {
  const filePath = getJobFilePath(workDir);
  if (!fs.existsSync(filePath)) {
    return { jobs: [] };
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  validateJobFileShape(parsed, filePath);
  return normalizeJobFile(parsed);
}

export function saveJobFile(workDir: string, jobFile: JobFile): void {
  const filePath = getJobFilePath(workDir);
  const normalized = normalizeJobFile(jobFile);
  validateJobFileShape(normalized, filePath);
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2) + "\n", "utf-8");
}
