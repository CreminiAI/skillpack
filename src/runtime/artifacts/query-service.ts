import type {
  ListArtifactsOptions,
  ListRunsOptions,
  ResultArtifactRecord,
  ResultRunRecord,
} from "./types.js";
import { ResultStore } from "./store.js";

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(limit)) {
    return fallback;
  }

  const normalized = Math.floor(limit as number);
  return Math.max(1, Math.min(normalized, max));
}

export class ResultsQueryService {
  constructor(private readonly resultStore: ResultStore) {}

  listRecentRuns(options: ListRunsOptions = {}): ResultRunRecord[] {
    return this.resultStore.listRecentRuns({
      channelId: options.channelId,
      limit: clampLimit(options.limit, 50, 200),
    });
  }

  getRunArtifacts(runId: string): ResultArtifactRecord[] {
    return this.resultStore.getRunArtifacts(runId);
  }

  listRecentArtifacts(options: ListArtifactsOptions = {}): ResultArtifactRecord[] {
    return this.resultStore.listRecentArtifacts({
      channelId: options.channelId,
      limit: clampLimit(options.limit, 100, 500),
    });
  }
}
