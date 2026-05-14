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
          id: "  morning-brief-id  ",
          name: "  morning-brief  ",
          cron: " 0 9 * * 1-5 ",
          prompt: "Send the morning brief",
          promptExamples: ["  Summarize the market open  ", " ", "Draft a quick recap"],
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
          id: "morning-brief-id",
          name: "morning-brief",
          cron: "0 9 * * 1-5",
          prompt: "Send the morning brief",
          promptExamples: ["Summarize the market open", "Draft a quick recap"],
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

test("saveJobFile normalizes blank cron jobs into one-time jobs", async () => {
  await withTempDir((dir) => {
    saveJobFile(dir, {
      jobs: [
        {
          id: "  manual-brief-id  ",
          name: "  manual-brief  ",
          cron: "   ",
          prompt: "Send the manual brief",
          notify: {
            adapter: " web ",
            channelId: " web ",
          },
          enabled: false,
          timezone: " Asia/Shanghai ",
        },
      ],
    });

    assert.deepEqual(loadJobFile(dir), {
      jobs: [
        {
          id: "manual-brief-id",
          name: "manual-brief",
          prompt: "Send the manual brief",
          notify: {
            adapter: "web",
            channelId: "web",
          },
        },
      ],
    });
  });
});

test("loadJobFile accepts jobs without cron", async () => {
  await withTempDir((dir) => {
    fs.writeFileSync(
      getJobFilePath(dir),
      JSON.stringify(
        {
          jobs: [
            {
              id: "manual-brief-id",
              name: "manual-brief",
              prompt: "Send the manual brief",
              notify: {
                adapter: "web",
                channelId: "web",
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    assert.deepEqual(loadJobFile(dir), {
      jobs: [
        {
          id: "manual-brief-id",
          name: "manual-brief",
          prompt: "Send the manual brief",
          notify: {
            adapter: "web",
            channelId: "web",
          },
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

test("loadJobFile rejects non-string promptExamples items", async () => {
  await withTempDir((dir) => {
    fs.writeFileSync(
      getJobFilePath(dir),
      JSON.stringify(
        {
          jobs: [
            {
              id: "bad-job",
              name: "bad-job",
              prompt: "Bad prompt examples",
              promptExamples: ["valid", 123],
              notify: {
                adapter: "web",
                channelId: "web",
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    assert.throws(
      () => loadJobFile(dir),
      /"jobs\[0\]\.promptExamples" must be an array of strings/,
    );
  });
});
