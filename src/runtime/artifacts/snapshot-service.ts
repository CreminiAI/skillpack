import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { toPackRelativePath } from "../files/metadata.js";
import type {
  FinalArtifactDeclaration,
  SnapshotArtifactRecord,
} from "./types.js";

function sanitizeFileName(fileName: string): string {
  const sanitized = fileName.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return sanitized || "artifact";
}

function formatSnapshotStamp(isoDate: string): string {
  const normalized = isoDate.replace(/\D+/g, "").slice(0, 14);
  return normalized || String(Date.now());
}

export class ArtifactSnapshotService {
  constructor(private readonly rootDir: string) {}

  createSnapshots(
    runId: string,
    artifacts: readonly FinalArtifactDeclaration[],
    declaredAt: string,
  ): SnapshotArtifactRecord[] {
    if (artifacts.length === 0) {
      return [];
    }

    const artifactsRoot = path.resolve(this.rootDir, "data", "artifacts");
    const runDir = path.join(artifactsRoot, runId);
    const tempDir = path.join(
      artifactsRoot,
      `.tmp-${runId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const snapshots: SnapshotArtifactRecord[] = [];
    const movedPaths: string[] = [];
    const snapshotNames = artifacts.map((artifact) => [
      formatSnapshotStamp(declaredAt),
      randomUUID(),
      sanitizeFileName(artifact.fileName),
    ].join("-"));

    fs.mkdirSync(artifactsRoot, { recursive: true });
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      snapshotNames.forEach((snapshotName, index) => {
        fs.copyFileSync(
          artifacts[index]!.filePath,
          path.join(tempDir, snapshotName),
        );
      });

      fs.mkdirSync(runDir, { recursive: true });

      snapshotNames.forEach((snapshotName, index) => {
        const artifact = artifacts[index]!;
        const tempSnapshotPath = path.join(tempDir, snapshotName);
        const finalSnapshotPath = path.join(runDir, snapshotName);
        fs.renameSync(tempSnapshotPath, finalSnapshotPath);
        movedPaths.push(finalSnapshotPath);

        snapshots.push({
          declaredAt,
          originalPath: toPackRelativePath(this.rootDir, artifact.filePath),
          snapshotPath: path.join("data", "artifacts", runId, snapshotName).split(path.sep).join("/"),
          fileName: artifact.fileName,
          mimeType: artifact.mimeType,
          sizeBytes: artifact.sizeBytes,
          title: artifact.title,
          isPrimary: artifact.isPrimary,
        });
      });

      fs.rmSync(tempDir, { recursive: true, force: true });
      return snapshots;
    } catch (error) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      movedPaths.forEach((filePath) => fs.rmSync(filePath, { force: true }));
      this.removeEmptyRunDirectory(runDir);
      throw error;
    }
  }

  removeSnapshots(snapshotPaths: readonly string[]): void {
    const visitedRunDirs = new Set<string>();

    for (const snapshotPath of snapshotPaths) {
      const resolvedPath = path.resolve(this.rootDir, snapshotPath);
      fs.rmSync(resolvedPath, { force: true });
      visitedRunDirs.add(path.dirname(resolvedPath));
    }

    visitedRunDirs.forEach((runDir) => this.removeEmptyRunDirectory(runDir));
  }

  private removeEmptyRunDirectory(runDir: string): void {
    try {
      if (!fs.existsSync(runDir)) {
        return;
      }

      if (fs.readdirSync(runDir).length === 0) {
        fs.rmdirSync(runDir);
      }
    } catch {
      // Best-effort cleanup only.
    }
  }
}
