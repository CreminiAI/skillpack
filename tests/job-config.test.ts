import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getJobFilePath,
  loadJobFile,
  saveJobFile,
} from "../src/job-config.js";

async function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillpack-job-config-"));
  try {
    await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("loadJobFile returns an empty list when job.json is missing", async () => {
  await withTempDir((dir) => {
    assert.deepEqual(loadJobFile(dir), { jobs: [] });
  });
});

test("saveJobFile writes normalized jobs and loadJobFile reads them back", async () => {
  await withTempDir((dir) => {
    saveJobFile(dir, {
      jobs: [
        {
          name: "  morning-brief  ",
          cron: " 0 9 * * 1-5 ",
          prompt: "Send the morning brief",
          notify: {
            adapter: " telegram ",
            channelId: " telegram-123 ",
          },
          enabled: true,
          timezone: " Asia/Shanghai ",
        },
      ],
    });

    assert.equal(fs.existsSync(getJobFilePath(dir)), true);
    assert.deepEqual(loadJobFile(dir), {
      jobs: [
        {
          name: "morning-brief",
          cron: "0 9 * * 1-5",
          prompt: "Send the morning brief",
          notify: {
            adapter: "telegram",
            channelId: "telegram-123",
          },
          enabled: true,
          timezone: "Asia/Shanghai",
        },
      ],
    });
  });
});

test("loadJobFile rejects invalid job.json structure", async () => {
  await withTempDir((dir) => {
    fs.writeFileSync(
      getJobFilePath(dir),
      JSON.stringify({ jobs: { name: "not-an-array" } }, null, 2),
      "utf-8",
    );

    assert.throws(
      () => loadJobFile(dir),
      /"jobs" must be an array/,
    );
  });
});
