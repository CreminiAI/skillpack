import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ArtifactPersistenceService,
  ArtifactSnapshotService,
  createSaveArtifactsTool,
  ResultStore,
  type SaveArtifactsCallback,
} from "../src/runtime/artifacts/index.js";

async function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillpack-artifacts-"));
  try {
    await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writePackFile(rootDir: string, relativePath: string, content: string): string {
  const filePath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

async function executeSaveArtifacts(
  rootDir: string,
  saveArtifacts: SaveArtifactsCallback,
  artifacts: Array<{ filePath: string; title?: string; isPrimary?: boolean }>,
): Promise<void> {
  const tool = createSaveArtifactsTool(rootDir, { current: saveArtifacts });
  await tool.execute(
    "tool-call",
    { artifacts },
    new AbortController().signal,
    async () => undefined,
    {} as never,
  );
}

test("save_artifacts saves snapshots and database records immediately", async () => {
  await withTempDir(async (dir) => {
    const store = new ResultStore(dir);
    const snapshotService = new ArtifactSnapshotService(dir);
    const persistenceService = new ArtifactPersistenceService(snapshotService, store);
    const filePath = writePackFile(dir, "outputs/report.md", "# report");

    await executeSaveArtifacts(
      dir,
      (artifacts) => persistenceService.saveArtifacts({
        runId: "run-1",
        channelId: "scheduler-daily-report",
        artifacts,
      }),
      [{ filePath, title: "Daily report", isPrimary: true }],
    );

    const records = store.listRecentArtifacts({
      channelId: "scheduler-daily-report",
      limit: 10,
    });

    assert.equal(records.length, 1);
    assert.equal(records[0]?.runId, "run-1");
    assert.equal(records[0]?.title, "Daily report");
    assert.equal(records[0]?.isPrimary, true);
    assert.equal(records[0]?.originalPath, "outputs/report.md");
    assert.equal(
      fs.existsSync(path.join(dir, records[0]!.snapshotPath)),
      true,
    );
  });
});

test("save_artifacts appends multiple saves under the same runId", async () => {
  await withTempDir(async (dir) => {
    const store = new ResultStore(dir);
    const snapshotService = new ArtifactSnapshotService(dir);
    const persistenceService = new ArtifactPersistenceService(snapshotService, store);
    const filePath = writePackFile(dir, "outputs/report.md", "# report");
    const saveArtifacts: SaveArtifactsCallback = (artifacts) =>
      persistenceService.saveArtifacts({
        runId: "run-append",
        channelId: "scheduler-weekly-summary",
        artifacts,
      });

    await executeSaveArtifacts(dir, saveArtifacts, [{ filePath, title: "First save" }]);
    await executeSaveArtifacts(dir, saveArtifacts, [{ filePath, title: "Second save" }]);

    const records = store.listRecentArtifacts({
      channelId: "scheduler-weekly-summary",
      limit: 10,
    });

    assert.equal(records.length, 2);
    assert.deepEqual(
      new Set(records.map((record) => record.runId)),
      new Set(["run-append"]),
    );
    assert.equal(
      new Set(records.map((record) => record.snapshotPath)).size,
      2,
    );
  });
});

test("save_artifacts fails atomically when any file is invalid", async () => {
  await withTempDir(async (dir) => {
    const store = new ResultStore(dir);
    const snapshotService = new ArtifactSnapshotService(dir);
    const persistenceService = new ArtifactPersistenceService(snapshotService, store);
    const validFilePath = writePackFile(dir, "outputs/report.md", "# report");
    const invalidFilePath = path.join(dir, "outputs", "missing.md");

    await assert.rejects(
      executeSaveArtifacts(
        dir,
        (artifacts) => persistenceService.saveArtifacts({
          runId: "run-invalid",
          channelId: "scheduler-invalid",
          artifacts,
        }),
        [
          { filePath: validFilePath, title: "Valid" },
          { filePath: invalidFilePath, title: "Missing" },
        ],
      ),
      /File not found/,
    );

    assert.equal(
      store.listRecentArtifacts({ channelId: "scheduler-invalid", limit: 10 }).length,
      0,
    );
    assert.equal(fs.existsSync(path.join(dir, "data", "artifacts")), false);
  });
});
