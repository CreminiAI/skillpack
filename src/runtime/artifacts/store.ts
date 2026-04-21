import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

import type {
  ListArtifactsOptions,
  ResultArtifactRecord,
  SnapshotArtifactRecord,
} from "./types.js";

interface InsertArtifactsInput {
  runId: string;
  channelId: string;
  artifacts: SnapshotArtifactRecord[];
}

type SqliteArtifactRow = {
  artifact_id: string;
  run_id: string;
  channel_id: string;
  original_path: string;
  snapshot_path: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number;
  title: string | null;
  is_primary: number;
  declared_at: string;
};

function mapArtifactRow(row: SqliteArtifactRow): ResultArtifactRecord {
  return {
    artifactId: row.artifact_id,
    runId: row.run_id,
    channelId: row.channel_id,
    originalPath: row.original_path,
    snapshotPath: row.snapshot_path,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    title: row.title,
    isPrimary: row.is_primary === 1,
    declaredAt: row.declared_at,
  };
}

export class ResultStore {
  private readonly db: Database.Database;

  constructor(rootDir: string) {
    const dataDir = path.resolve(rootDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, "result.db"));
    this.db.pragma("journal_mode = WAL");
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        original_path TEXT NOT NULL,
        snapshot_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        mime_type TEXT,
        size_bytes INTEGER NOT NULL,
        title TEXT,
        is_primary INTEGER NOT NULL DEFAULT 0,
        declared_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_artifacts_channel_declared_at
      ON artifacts(channel_id, declared_at DESC);
    `);
  }

  insertArtifacts(input: InsertArtifactsInput): void {
    if (input.artifacts.length === 0) {
      return;
    }

    const insertArtifact = this.db.prepare(`
      INSERT INTO artifacts (
        artifact_id,
        run_id,
        channel_id,
        original_path,
        snapshot_path,
        file_name,
        mime_type,
        size_bytes,
        title,
        is_primary,
        declared_at
      ) VALUES (
        @artifactId,
        @runId,
        @channelId,
        @originalPath,
        @snapshotPath,
        @fileName,
        @mimeType,
        @sizeBytes,
        @title,
        @isPrimary,
        @declaredAt
      )
    `);

    const transaction = this.db.transaction((payload: InsertArtifactsInput) => {
      for (const artifact of payload.artifacts) {
        insertArtifact.run({
          artifactId: randomUUID(),
          runId: payload.runId,
          channelId: payload.channelId,
          originalPath: artifact.originalPath,
          snapshotPath: artifact.snapshotPath,
          fileName: artifact.fileName,
          mimeType: artifact.mimeType ?? null,
          sizeBytes: artifact.sizeBytes,
          title: artifact.title ?? null,
          isPrimary: artifact.isPrimary ? 1 : 0,
          declaredAt: artifact.declaredAt,
        });
      }
    });

    transaction(input);
  }

  listRecentArtifacts(options: ListArtifactsOptions = {}): ResultArtifactRecord[] {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (options.channelId) {
      conditions.push("channel_id = ?");
      params.push(options.channelId);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";
    const rows = this.db.prepare(`
      SELECT *
      FROM artifacts
      ${whereClause}
      ORDER BY declared_at DESC, rowid DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as SqliteArtifactRow[];

    return rows.map(mapArtifactRow);
  }
}
