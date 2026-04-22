import type {
  ListArtifactsOptions,
  ResultArtifactRecord,
} from "./types.js";
import { ResultStore } from "./store.js";

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(limit)) {
    return fallback;
  }

  const normalized = Math.floor(limit as number);
  return Math.max(1, Math.min(normalized, max));
}

function clampOffset(offset: number | undefined): number {
  if (!Number.isFinite(offset)) {
    return 0;
  }

  return Math.max(0, Math.floor(offset as number));
}

export class ResultsQueryService {
  constructor(private readonly resultStore: ResultStore) {}

  async listRecentArtifacts(options: ListArtifactsOptions = {}): Promise<ResultArtifactRecord[]> {
    return this.resultStore.listRecentArtifacts({
      channelId: options.channelId,
      limit: clampLimit(options.limit, 100, 500),
      offset: clampOffset(options.offset),
    });
  }
}
