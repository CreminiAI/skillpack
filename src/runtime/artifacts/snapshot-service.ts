import fs from "node:fs";
import path from "node:path";

import {
  toPackRelativePath,
} from "../files/metadata.js";
import type {
  ArtifactDeclarationBatch,
  SnapshotArtifactRecord,
} from "./types.js";

function sanitizeFileName(fileName: string): string {
  const sanitized = fileName.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return sanitized || "artifact";
}

export class ArtifactSnapshotService {
  constructor(private readonly rootDir: string) {}

  createSnapshots(
    runId: string,
    declarations: readonly ArtifactDeclarationBatch[],
    jobName?: string,
  ): SnapshotArtifactRecord[] {
    if (declarations.length === 0) {
      return [];
    }

    const artifactsRoot = path.resolve(this.rootDir, "data", "artifacts");
    const runDir = path.join(artifactsRoot, runId);
    const tempDir = `${runDir}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const snapshots: SnapshotArtifactRecord[] = [];

    fs.mkdirSync(artifactsRoot, { recursive: true });
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      for (const declaration of declarations) {
        declaration.artifacts.forEach((artifact, index) => {
          const artifactOrder = index + 1;
          const snapshotName = [
            String(declaration.declarationSeq).padStart(3, "0"),
            String(artifactOrder).padStart(3, "0"),
            sanitizeFileName(artifact.fileName),
          ].join("-");
          const tempSnapshotPath = path.join(tempDir, snapshotName);

          fs.copyFileSync(artifact.filePath, tempSnapshotPath);

          snapshots.push({
            declarationSeq: declaration.declarationSeq,
            artifactOrder,
            declaredAt: declaration.declaredAt,
            jobName: jobName ?? null,
            originalPath: toPackRelativePath(this.rootDir, artifact.filePath),
            snapshotPath: path.join("data", "artifacts", runId, snapshotName).split(path.sep).join("/"),
            fileName: artifact.fileName,
            mimeType: artifact.mimeType,
            sizeBytes: artifact.sizeBytes,
            title: artifact.title,
            description: artifact.description,
            isPrimary: artifact.isPrimary,
          });
        });
      }

      fs.renameSync(tempDir, runDir);
      return snapshots;
    } catch (error) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      fs.rmSync(runDir, { recursive: true, force: true });
      throw error;
    }
  }
}
