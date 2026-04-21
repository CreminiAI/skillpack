import type { FinalArtifactDeclaration } from "./types.js";
import { ArtifactSnapshotService } from "./snapshot-service.js";
import { ResultStore } from "./store.js";

interface SaveArtifactsInput {
  runId: string;
  channelId: string;
  artifacts: FinalArtifactDeclaration[];
}

export class ArtifactPersistenceService {
  constructor(
    private readonly snapshotService: ArtifactSnapshotService,
    private readonly resultStore: ResultStore,
  ) {}

  saveArtifacts(input: SaveArtifactsInput): number {
    const declaredAt = new Date().toISOString();
    const snapshots = this.snapshotService.createSnapshots(
      input.runId,
      input.artifacts,
      declaredAt,
    );

    try {
      this.resultStore.insertArtifacts({
        runId: input.runId,
        channelId: input.channelId,
        artifacts: snapshots,
      });
      return snapshots.length;
    } catch (error) {
      this.snapshotService.removeSnapshots(
        snapshots.map((artifact) => artifact.snapshotPath),
      );
      throw error;
    }
  }
}
