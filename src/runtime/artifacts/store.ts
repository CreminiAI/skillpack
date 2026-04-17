import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

import type {
  ListArtifactsOptions,
  ListRunsOptions,
  ResultArtifactRecord,
  ResultRunRecord,
  RunStatus,
  SnapshotArtifactRecord,
} from "./types.js";

interface CreateRunInput {
  runId: string;
  channelId: string;
  userText: string;
  startedAt: string;
}

interface CompleteRunInput {
  runId: string;
  assistantText: string;
  stopReason: string | null;
  completedAt: string;
  artifacts: SnapshotArtifactRecord[];
}

interface FailRunInput {
  runId: string;
  assistantText: string;
  status: Extract<RunStatus, "error" | "aborted">;
  stopReason: string | null;
  errorMessage: string | null;
  completedAt: string;
}

type SqliteRunRow = {
  run_id: string;
  channel_id: string;
  user_text: string;
  assistant_text: string | null;
  status: RunStatus;
  stop_reason: string | null;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
};

type SqliteArtifactRow = {
  artifact_id: string;
  run_id: string;
  channel_id: string;
  declaration_seq: number;
  artifact_order: number;
  original_path: string;
  snapshot_path: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number;
  title: string | null;
  description: string | null;
  is_primary: number;
  declared_at: string;
};

function mapRunRow(row: SqliteRunRow): ResultRunRecord {
  return {
    runId: row.run_id,
    channelId: row.channel_id,
    userText: row.user_text,
    assistantText: row.assistant_text,
    status: row.status,
    stopReason: row.stop_reason,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function mapArtifactRow(row: SqliteArtifactRow): ResultArtifactRecord {
  return {
    artifactId: row.artifact_id,
    runId: row.run_id,
    channelId: row.channel_id,
    declarationSeq: row.declaration_seq,
    artifactOrder: row.artifact_order,
    originalPath: row.original_path,
    snapshotPath: row.snapshot_path,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    title: row.title,
    description: row.description,
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
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    const userVersion = this.db.pragma("user_version", { simple: true }) as number;
    if (userVersion >= 1) {
      return;
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        user_text TEXT NOT NULL,
        assistant_text TEXT,
        status TEXT NOT NULL,
        stop_reason TEXT,
        error_message TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_runs_channel_completed_at
      ON runs(channel_id, completed_at DESC);

      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        declaration_seq INTEGER NOT NULL,
        artifact_order INTEGER NOT NULL,
        original_path TEXT NOT NULL,
        snapshot_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        mime_type TEXT,
        size_bytes INTEGER NOT NULL,
        title TEXT,
        description TEXT,
        is_primary INTEGER NOT NULL DEFAULT 0,
        declared_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(run_id)
      );

      CREATE INDEX IF NOT EXISTS idx_artifacts_run_order
      ON artifacts(run_id, declaration_seq, artifact_order);

      CREATE INDEX IF NOT EXISTS idx_artifacts_channel_declared_at
      ON artifacts(channel_id, declared_at DESC);
    `);

    this.db.pragma("user_version = 1");
  }

  createRun(input: CreateRunInput): void {
    this.db.prepare(`
      INSERT INTO runs (
        run_id,
        channel_id,
        user_text,
        assistant_text,
        status,
        stop_reason,
        error_message,
        started_at,
        completed_at
      ) VALUES (
        @runId,
        @channelId,
        @userText,
        NULL,
        'running',
        NULL,
        NULL,
        @startedAt,
        NULL
      )
    `).run(input);
  }

  completeRun(input: CompleteRunInput): void {
    const updateRun = this.db.prepare(`
      UPDATE runs
      SET
        assistant_text = @assistantText,
        status = 'completed',
        stop_reason = @stopReason,
        error_message = NULL,
        completed_at = @completedAt
      WHERE run_id = @runId
    `);
    const getChannelId = this.db.prepare(`
      SELECT channel_id
      FROM runs
      WHERE run_id = ?
    `);
    const insertArtifact = this.db.prepare(`
      INSERT INTO artifacts (
        artifact_id,
        run_id,
        channel_id,
        declaration_seq,
        artifact_order,
        original_path,
        snapshot_path,
        file_name,
        mime_type,
        size_bytes,
        title,
        description,
        is_primary,
        declared_at
      ) VALUES (
        @artifactId,
        @runId,
        @channelId,
        @declarationSeq,
        @artifactOrder,
        @originalPath,
        @snapshotPath,
        @fileName,
        @mimeType,
        @sizeBytes,
        @title,
        @description,
        @isPrimary,
        @declaredAt
      )
    `);

    const transaction = this.db.transaction((payload: CompleteRunInput) => {
      updateRun.run(payload);
      const row = getChannelId.get(payload.runId) as { channel_id?: string } | undefined;
      if (!row?.channel_id) {
        throw new Error(`Run not found: ${payload.runId}`);
      }

      for (const artifact of payload.artifacts) {
        insertArtifact.run({
          artifactId: randomUUID(),
          runId: payload.runId,
          channelId: row.channel_id,
          declarationSeq: artifact.declarationSeq,
          artifactOrder: artifact.artifactOrder,
          originalPath: artifact.originalPath,
          snapshotPath: artifact.snapshotPath,
          fileName: artifact.fileName,
          mimeType: artifact.mimeType ?? null,
          sizeBytes: artifact.sizeBytes,
          title: artifact.title ?? null,
          description: artifact.description ?? null,
          isPrimary: artifact.isPrimary ? 1 : 0,
          declaredAt: artifact.declaredAt,
        });
      }
    });

    transaction(input);
  }

  failRun(input: FailRunInput): void {
    this.db.prepare(`
      UPDATE runs
      SET
        assistant_text = @assistantText,
        status = @status,
        stop_reason = @stopReason,
        error_message = @errorMessage,
        completed_at = @completedAt
      WHERE run_id = @runId
    `).run(input);
  }

  listRecentRuns(options: ListRunsOptions = {}): ResultRunRecord[] {
    const limit = options.limit ?? 50;
    if (options.channelId) {
      const rows = this.db.prepare(`
        SELECT *
        FROM runs
        WHERE channel_id = ?
        ORDER BY COALESCE(completed_at, started_at) DESC
        LIMIT ?
      `).all(options.channelId, limit) as SqliteRunRow[];
      return rows.map(mapRunRow);
    }

    const rows = this.db.prepare(`
      SELECT *
      FROM runs
      ORDER BY COALESCE(completed_at, started_at) DESC
      LIMIT ?
    `).all(limit) as SqliteRunRow[];
    return rows.map(mapRunRow);
  }

  getRunArtifacts(runId: string): ResultArtifactRecord[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM artifacts
      WHERE run_id = ?
      ORDER BY declaration_seq ASC, artifact_order ASC
    `).all(runId) as SqliteArtifactRow[];
    return rows.map(mapArtifactRow);
  }

  listRecentArtifacts(options: ListArtifactsOptions = {}): ResultArtifactRecord[] {
    const limit = options.limit ?? 100;
    if (options.channelId) {
      const rows = this.db.prepare(`
        SELECT *
        FROM artifacts
        WHERE channel_id = ?
        ORDER BY declared_at DESC, declaration_seq DESC, artifact_order DESC
        LIMIT ?
      `).all(options.channelId, limit) as SqliteArtifactRow[];
      return rows.map(mapArtifactRow);
    }

    const rows = this.db.prepare(`
      SELECT *
      FROM artifacts
      ORDER BY declared_at DESC, declaration_seq DESC, artifact_order DESC
      LIMIT ?
    `).all(limit) as SqliteArtifactRow[];
    return rows.map(mapArtifactRow);
  }
}
