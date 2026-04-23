import type { ScheduledJobConfig } from "./job-config.js";

export function normalizeJobCron(cron: string | undefined | null): string | undefined {
  if (typeof cron !== "string") {
    return undefined;
  }

  const normalized = cron.trim();
  return normalized ? normalized : undefined;
}

export function hasJobSchedule(
  jobOrCron: Pick<ScheduledJobConfig, "cron"> | string | undefined | null,
): boolean {
  if (typeof jobOrCron === "string" || jobOrCron == null) {
    return !!normalizeJobCron(jobOrCron);
  }

  return !!normalizeJobCron(jobOrCron.cron);
}
