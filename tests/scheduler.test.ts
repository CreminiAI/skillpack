import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getJobFilePath, loadJobFile, saveJobFile } from "../src/job-config.js";
import { SchedulerAdapter } from "../src/runtime/adapters/scheduler.js";

async function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillpack-scheduler-"));
  try {
    await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createSchedulerContext(rootDir: string) {
  return {
    agent: {
      handleMessage: async () => ({ errorMessage: undefined }),
    },
    server: {},
    app: {},
    rootDir,
    lifecycle: {},
    notify: async () => {},
  } as any;
}

test("scheduler loads jobs from job.json on startup", async () => {
  await withTempDir(async (dir) => {
    saveJobFile(dir, {
      jobs: [
        {
          name: "daily-brief",
          cron: "0 9 * * 1-5",
          prompt: "Send the daily brief",
          notify: {
            adapter: "telegram",
            channelId: "telegram-123",
          },
        },
      ],
    });

    const scheduler = new SchedulerAdapter();
    await scheduler.start(createSchedulerContext(dir));

    assert.deepEqual(
      scheduler.listJobs().map((job) => ({
        name: job.name,
        cron: job.cron,
        enabled: job.enabled,
      })),
      [
        {
          name: "daily-brief",
          cron: "0 9 * * 1-5",
          enabled: true,
        },
      ],
    );

    await scheduler.stop();
  });
});

test("scheduler persists add/remove/enable changes only to job.json", async () => {
  await withTempDir(async (dir) => {
    const dataDir = path.join(dir, "data");
    fs.mkdirSync(dataDir, { recursive: true });

    const configPath = path.join(dataDir, "config.json");
    const originalConfig = JSON.stringify(
      {
        provider: "openai",
        apiKey: "sk-test",
      },
      null,
      2,
    ) + "\n";
    fs.writeFileSync(configPath, originalConfig, "utf-8");

    const scheduler = new SchedulerAdapter();
    await scheduler.start(createSchedulerContext(dir));

    const added = scheduler.addJob({
      name: "weekly-summary",
      cron: "0 18 * * 5",
      prompt: "Send the weekly summary",
      notify: {
        adapter: "slack",
        channelId: "slack-dm-1",
      },
    });

    assert.equal(added.success, true);
    assert.equal(fs.existsSync(getJobFilePath(dir)), true);
    assert.deepEqual(loadJobFile(dir).jobs.map((job) => job.name), ["weekly-summary"]);
    assert.equal(fs.readFileSync(configPath, "utf-8"), originalConfig);

    const disabled = scheduler.setEnabled("weekly-summary", false);
    assert.equal(disabled.success, true);
    assert.equal(loadJobFile(dir).jobs[0]?.enabled, false);
    assert.equal(fs.readFileSync(configPath, "utf-8"), originalConfig);

    const removed = scheduler.removeJob("weekly-summary");
    assert.equal(removed.success, true);
    assert.deepEqual(loadJobFile(dir), { jobs: [] });
    assert.equal(fs.readFileSync(configPath, "utf-8"), originalConfig);

    await scheduler.stop();
  });
});

test("scheduler passes jobName metadata when triggering a job", async () => {
  await withTempDir(async (dir) => {
    saveJobFile(dir, {
      jobs: [
        {
          name: "metadata-job",
          cron: "0 9 * * 1-5",
          prompt: "Send the metadata report",
          notify: {
            adapter: "telegram",
            channelId: "telegram-123",
          },
        },
      ],
    });

    const calls: unknown[] = [];
    const scheduler = new SchedulerAdapter();
    await scheduler.start({
      ...createSchedulerContext(dir),
      agent: {
        handleMessage: async (...args: unknown[]) => {
          calls.push(args[5]);
          return { errorMessage: undefined };
        },
      },
    } as any);

    const result = await scheduler.triggerJob("metadata-job");
    assert.equal(result.success, true);
    assert.deepEqual(calls, [{ jobName: "metadata-job" }]);

    await scheduler.stop();
  });
});
