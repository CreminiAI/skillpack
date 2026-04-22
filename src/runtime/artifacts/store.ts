import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sqlite3 from "sqlite3";

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

type SqliteParameter = string | number | null;
type SqliteParameters = SqliteParameter[] | Record<string, SqliteParameter>;

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
  private db: sqlite3.Database | null = null;
  private readonly ready: Promise<void>;

  constructor(rootDir: string) {
    const dataDir = path.resolve(rootDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    this.ready = this.initialize(path.join(dataDir, "result-v2.db"));
  }

  private async initialize(databasePath: string): Promise<void> {
    this.db = await openDatabase(databasePath);
    await this.exec("PRAGMA journal_mode = WAL");
    await this.exec(`
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

  async insertArtifacts(input: InsertArtifactsInput): Promise<void> {
    await this.ready;

    if (input.artifacts.length === 0) {
      return;
    }

    const insertArtifact = `
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
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?
      )
    `;

    await this.exec("BEGIN");
    try {
      for (const artifact of input.artifacts) {
        await this.run(insertArtifact, [
          randomUUID(),
          input.runId,
          input.channelId,
          artifact.originalPath,
          artifact.snapshotPath,
          artifact.fileName,
          artifact.mimeType ?? null,
          artifact.sizeBytes,
          artifact.title ?? null,
          artifact.isPrimary ? 1 : 0,
          artifact.declaredAt,
        ]);
      }
      await this.exec("COMMIT");
    } catch (error) {
      await this.rollback();
      throw error;
    }
  }

  async listRecentArtifacts(options: ListArtifactsOptions = {}): Promise<ResultArtifactRecord[]> {
    await this.ready;

    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    const conditions: string[] = [];
    const params: SqliteParameter[] = [];

    if (options.channelId) {
      conditions.push("channel_id = ?");
      params.push(options.channelId);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";
    const rows = await this.all<SqliteArtifactRow>(`
      SELECT *
      FROM artifacts
      ${whereClause}
      ORDER BY declared_at DESC, rowid DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    return rows.map(mapArtifactRow);
  }

  private getDatabase(): sqlite3.Database {
    if (!this.db) {
      throw new Error("Result store database is not ready");
    }

    return this.db;
  }

  private exec(sql: string): Promise<void> {
    const db = this.getDatabase();
    return new Promise((resolve, reject) => {
      db.exec(sql, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private run(sql: string, params: SqliteParameters = []): Promise<void> {
    const db = this.getDatabase();
    return new Promise((resolve, reject) => {
      db.run(sql, params, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private all<T>(sql: string, params: SqliteParameters = []): Promise<T[]> {
    const db = this.getDatabase();
    return new Promise((resolve, reject) => {
      db.all(sql, params, (error, rows) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(rows as T[]);
      });
    });
  }

  private async rollback(): Promise<void> {
    try {
      await this.exec("ROLLBACK");
    } catch {
      // Ignore rollback failures so the original write error is preserved.
    }
  }
}

function openDatabase(databasePath: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(databasePath, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(db);
    });
  });
}
