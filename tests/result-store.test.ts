import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ResultStore } from "../src/runtime/artifacts/store.js";

async function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillpack-result-store-"));
  try {
    await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("result store filters recent artifacts by channelId and offset", async () => {
  await withTempDir(async (dir) => {
    const store = new ResultStore(dir);

    await store.insertArtifacts({
      runId: "run-1",
      channelId: "scheduler-daily-report",
      artifacts: [
        {
          declaredAt: "2026-04-20T00:01:00.000Z",
          originalPath: "outputs/report-1.md",
          snapshotPath: "data/artifacts/run-1/report-1.md",
          fileName: "report-1.md",
          mimeType: "text/markdown",
          sizeBytes: 123,
          title: "Report 1",
          isPrimary: true,
        },
        {
          declaredAt: "2026-04-20T00:02:00.000Z",
          originalPath: "outputs/report-2.md",
          snapshotPath: "data/artifacts/run-1/report-2.md",
          fileName: "report-2.md",
          mimeType: "text/markdown",
          sizeBytes: 77,
          title: "Report 2",
          isPrimary: false,
        },
      ],
    });

    await store.insertArtifacts({
      runId: "run-2",
      channelId: "web-default",
      artifacts: [
        {
          declaredAt: "2026-04-20T00:03:00.000Z",
          originalPath: "outputs/notes.md",
          snapshotPath: "data/artifacts/run-2/notes.md",
          fileName: "notes.md",
          mimeType: "text/markdown",
          sizeBytes: 44,
          title: "Notes",
          isPrimary: false,
        },
      ],
    });

    const filtered = await store.listRecentArtifacts({
      channelId: "scheduler-daily-report",
      limit: 10,
      offset: 0,
    });
    assert.equal(filtered.length, 2);
    assert.equal(filtered[0]?.fileName, "report-2.md");
    assert.equal(filtered[1]?.fileName, "report-1.md");

    const paged = await store.listRecentArtifacts({
      channelId: "scheduler-daily-report",
      limit: 1,
      offset: 1,
    });
    assert.equal(paged.length, 1);
    assert.equal(paged[0]?.fileName, "report-1.md");
  });
});
