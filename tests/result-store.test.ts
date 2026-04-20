import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import { ResultStore } from "../src/runtime/artifacts/store.js";

async function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillpack-result-store-"));
  try {
    await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("result store migrates old databases by adding the job_name column", async () => {
  await withTempDir((dir) => {
    const dataDir = path.join(dir, "data");
    fs.mkdirSync(dataDir, { recursive: true });

    const db = new Database(path.join(dataDir, "result.db"));
    db.exec(`
      CREATE TABLE runs (
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

      CREATE TABLE artifacts (
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
    `);
    db.pragma("user_version = 1");
    db.close();

    const store = new ResultStore(dir);
    const migratedDb = new Database(path.join(dataDir, "result.db"), { readonly: true });
    const columns = migratedDb.prepare(`PRAGMA table_info(artifacts)`).all() as Array<{ name: string }>;

    assert.equal(columns.some((column) => column.name === "job_name"), true);
    assert.equal(migratedDb.pragma("user_version", { simple: true }), 2);

    migratedDb.close();
    void store;
  });
});

test("result store filters recent artifacts by job name", async () => {
  await withTempDir((dir) => {
    const store = new ResultStore(dir);
    store.createRun({
      runId: "run-1",
      channelId: "scheduler-daily-report",
      userText: "Generate report",
      startedAt: "2026-04-20T00:00:00.000Z",
    });

    store.completeRun({
      runId: "run-1",
      assistantText: "Done",
      stopReason: "completed",
      completedAt: "2026-04-20T00:01:00.000Z",
      artifacts: [
        {
          declarationSeq: 1,
          artifactOrder: 1,
          declaredAt: "2026-04-20T00:01:00.000Z",
          jobName: "daily-report",
          originalPath: "outputs/report.md",
          snapshotPath: "data/artifacts/run-1/001-001-report.md",
          fileName: "report.md",
          mimeType: "text/markdown",
          sizeBytes: 123,
          title: "Report",
          description: undefined,
          isPrimary: true,
        },
        {
          declarationSeq: 1,
          artifactOrder: 2,
          declaredAt: "2026-04-20T00:01:00.000Z",
          jobName: null,
          originalPath: "outputs/notes.md",
          snapshotPath: "data/artifacts/run-1/001-002-notes.md",
          fileName: "notes.md",
          mimeType: "text/markdown",
          sizeBytes: 77,
          title: "Notes",
          description: undefined,
          isPrimary: false,
        },
      ],
    });

    const filtered = store.listRecentArtifacts({ jobName: "daily-report", limit: 10 });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]?.jobName, "daily-report");
    assert.equal(filtered[0]?.fileName, "report.md");

    const unfiltered = store.listRecentArtifacts({ limit: 10 });
    assert.equal(unfiltered.length, 2);
  });
});
