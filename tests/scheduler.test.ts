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
      handleCommand: async () => ({ success: true }),
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
          id: "daily-brief",
          name: "daily-brief",
          cron: "0 9 * * 1-5",
          prompt: "Send the daily brief",
          promptExamples: ["Summarize key headlines", "List notable movers"],
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
        id: job.id,
        name: job.name,
        cron: job.cron,
        promptExamples: job.promptExamples,
        enabled: job.enabled,
      })),
      [
        {
          id: "daily-brief",
          name: "daily-brief",
          cron: "0 9 * * 1-5",
          promptExamples: ["Summarize key headlines", "List notable movers"],
          enabled: true,
        },
      ],
    );

    await scheduler.stop();
  });
});

test("scheduler loads one-time jobs without creating a schedule", async () => {
  await withTempDir(async (dir) => {
    saveJobFile(dir, {
      jobs: [
        {
          id: "manual-brief",
          name: "manual-brief",
          prompt: "Send the manual brief",
          notify: {
            adapter: "web",
            channelId: "web",
          },
        },
      ],
    });

    const scheduler = new SchedulerAdapter();
    await scheduler.start(createSchedulerContext(dir));

    assert.deepEqual(scheduler.listJobs(), [
      {
        id: "manual-brief",
        name: "manual-brief",
        prompt: "Send the manual brief",
        notify: {
          adapter: "web",
          channelId: "web",
        },
        enabled: true,
        running: false,
        notifyFailed: false,
      },
    ]);

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
      id: "weekly-summary",
      name: "weekly-summary",
      cron: "0 18 * * 5",
      prompt: "Send the weekly summary",
      promptExamples: ["Summarize weekly wins", "Highlight blockers"],
      notify: {
        adapter: "slack",
        channelId: "slack-dm-1",
      },
    });

    assert.equal(added.success, true);
    assert.equal(fs.existsSync(getJobFilePath(dir)), true);
    assert.deepEqual(loadJobFile(dir).jobs, [
      {
        id: "weekly-summary",
        name: "weekly-summary",
        cron: "0 18 * * 5",
        prompt: "Send the weekly summary",
        promptExamples: ["Summarize weekly wins", "Highlight blockers"],
        notify: {
          adapter: "slack",
          channelId: "slack-dm-1",
        },
      },
    ]);
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

test("scheduler persists one-time jobs without cron, enabled, or timezone", async () => {
  await withTempDir(async (dir) => {
    const scheduler = new SchedulerAdapter();
    await scheduler.start(createSchedulerContext(dir));

    const added = scheduler.addJob({
      id: "manual-brief",
      name: "manual-brief",
      cron: "   ",
      prompt: "Send the manual brief",
      notify: {
        adapter: "web",
        channelId: "web",
      },
      enabled: false,
      timezone: "Asia/Shanghai",
    });

    assert.equal(added.success, true);
    assert.deepEqual(loadJobFile(dir), {
      jobs: [
        {
          id: "manual-brief",
          name: "manual-brief",
          prompt: "Send the manual brief",
          notify: {
            adapter: "web",
            channelId: "web",
          },
        },
      ],
    });

    await scheduler.stop();
  });
});

test("scheduler triggers jobs with the derived scheduler channelId only", async () => {
  await withTempDir(async (dir) => {
    saveJobFile(dir, {
      jobs: [
        {
          id: "metadata-job",
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

    const calls: Array<{ channelId: string; options: unknown }> = [];
    const scheduler = new SchedulerAdapter();
    await scheduler.start({
      ...createSchedulerContext(dir),
      agent: {
        handleCommand: async () => ({ success: true }),
        handleMessage: async (...args: unknown[]) => {
          calls.push({
            channelId: args[1] as string,
            options: args[5],
          });
          return { errorMessage: undefined };
        },
      },
    } as any);

    const result = await scheduler.triggerJob("metadata-job");
    assert.equal(result.success, true);
    assert.deepEqual(calls, [
      {
        channelId: "scheduler-metadata-job",
        options: undefined,
      },
    ]);

    await scheduler.stop();
  });
});

test("scheduler can manually trigger one-time jobs", async () => {
  await withTempDir(async (dir) => {
    saveJobFile(dir, {
      jobs: [
        {
          id: "manual-job",
          name: "manual-job",
          prompt: "Run once manually",
          notify: {
            adapter: "web",
            channelId: "web",
          },
        },
      ],
    });

    const calls: string[] = [];
    const scheduler = new SchedulerAdapter();
    await scheduler.start({
      ...createSchedulerContext(dir),
      agent: {
        handleCommand: async () => ({ success: true }),
        handleMessage: async (_adapter: string, channelId: string) => {
          calls.push(channelId);
          return { errorMessage: undefined };
        },
      },
    } as any);

    const result = await scheduler.triggerJob("manual-job");
    assert.equal(result.success, true);
    assert.deepEqual(calls, ["scheduler-manual-job"]);

    await scheduler.stop();
  });
});

test("scheduler broadcasts agent events over IPC", async () => {
  await withTempDir(async (dir) => {
    saveJobFile(dir, {
      jobs: [
        {
          id: "suggestion-job",
          name: "suggestion-job",
          prompt: "Run and suggest next steps",
          notify: {
            adapter: "web",
            channelId: "web",
          },
        },
      ],
    });

    const broadcasts: Array<{ channelId: string; type: string; delta?: string }> = [];
    const scheduler = new SchedulerAdapter();
    await scheduler.start({
      ...createSchedulerContext(dir),
      ipcBroadcaster: {
        broadcastInbound: () => undefined,
        broadcastAgentEvent: (channelId: string, event: any) => {
          broadcasts.push({
            channelId,
            type: event.type,
            delta: event.type === "text_delta" ? event.delta : undefined,
          });
        },
      },
      agent: {
        handleCommand: async () => ({ success: true }),
        handleMessage: async (
          _adapter: string,
          _channelId: string,
          _text: string,
          onEvent: (event: any) => void,
        ) => {
          onEvent({ type: "agent_start" });
          onEvent({ type: "text_delta", delta: "Consider increasing budget." });
          onEvent({ type: "agent_end" });
          return { errorMessage: undefined };
        },
      },
    } as any);

    const result = await scheduler.triggerJob("suggestion-job");
    assert.equal(result.success, true);
    assert.deepEqual(broadcasts, [
      { channelId: "scheduler-suggestion-job", type: "agent_start", delta: undefined },
      {
        channelId: "scheduler-suggestion-job",
        type: "text_delta",
        delta: "Consider increasing budget.",
      },
      { channelId: "scheduler-suggestion-job", type: "agent_end", delta: undefined },
    ]);

    await scheduler.stop();
  });
});

test("scheduler synthesizes agent_end when the runtime omits it", async () => {
  await withTempDir(async (dir) => {
    saveJobFile(dir, {
      jobs: [
        {
          id: "missing-agent-end-job",
          name: "missing-agent-end-job",
          prompt: "Run and stop without emitting agent_end",
          notify: {
            adapter: "web",
            channelId: "web",
          },
        },
      ],
    });

    const broadcasts: Array<{ channelId: string; type: string; delta?: string }> = [];
    const scheduler = new SchedulerAdapter();
    await scheduler.start({
      ...createSchedulerContext(dir),
      ipcBroadcaster: {
        broadcastInbound: () => undefined,
        broadcastAgentEvent: (channelId: string, event: any) => {
          broadcasts.push({
            channelId,
            type: event.type,
            delta: event.type === "text_delta" ? event.delta : undefined,
          });
        },
      },
      agent: {
        handleCommand: async () => ({ success: true }),
        handleMessage: async (
          _adapter: string,
          _channelId: string,
          _text: string,
          onEvent: (event: any) => void,
        ) => {
          onEvent({ type: "agent_start" });
          onEvent({ type: "text_delta", delta: "Consider trimming low-value searches." });
          return { errorMessage: undefined };
        },
      },
    } as any);

    const result = await scheduler.triggerJob("missing-agent-end-job");
    assert.equal(result.success, true);
    assert.deepEqual(broadcasts, [
      { channelId: "scheduler-missing-agent-end-job", type: "agent_start", delta: undefined },
      {
        channelId: "scheduler-missing-agent-end-job",
        type: "text_delta",
        delta: "Consider trimming low-value searches.",
      },
      { channelId: "scheduler-missing-agent-end-job", type: "agent_end", delta: undefined },
    ]);

    await scheduler.stop();
  });
});

test("scheduler clears previous context before running and keeps the same channelId", async () => {
  await withTempDir(async (dir) => {
    saveJobFile(dir, {
      jobs: [
        {
          id: "clean-context-job",
          name: "clean-context-job",
          cron: "0 9 * * 1-5",
          prompt: "Run with a fresh context",
          notify: {
            adapter: "telegram",
            channelId: "telegram-123",
          },
        },
      ],
    });

    const calls: Array<{
      type: "clear" | "message";
      channelId: string;
    }> = [];

    const scheduler = new SchedulerAdapter();
    await scheduler.start({
      ...createSchedulerContext(dir),
      agent: {
        handleCommand: async (command: string, channelId: string) => {
          calls.push({ type: command as "clear", channelId });
          return { success: true };
        },
        handleMessage: async (
          _adapter: string,
          channelId: string,
        ) => {
          calls.push({ type: "message", channelId });
          return { errorMessage: undefined };
        },
      },
    } as any);

    const result = await scheduler.triggerJob("clean-context-job");
    assert.equal(result.success, true);
    assert.deepEqual(calls, [
      { type: "clear", channelId: "scheduler-clean-context-job" },
      { type: "message", channelId: "scheduler-clean-context-job" },
    ]);

    await scheduler.stop();
  });
});

test("scheduler rejects enable or disable requests for one-time jobs", async () => {
  await withTempDir(async (dir) => {
    saveJobFile(dir, {
      jobs: [
        {
          id: "manual-job",
          name: "manual-job",
          prompt: "Run once manually",
          notify: {
            adapter: "web",
            channelId: "web",
          },
        },
      ],
    });

    const scheduler = new SchedulerAdapter();
    await scheduler.start(createSchedulerContext(dir));

    const result = scheduler.setEnabled("manual-job", false);
    assert.equal(result.success, false);
    assert.match(result.message, /does not have a schedule/);

    await scheduler.stop();
  });
});

test("scheduler updates jobs between recurring and one-time modes", async () => {
  await withTempDir(async (dir) => {
    saveJobFile(dir, {
      jobs: [
        {
          id: "mutable-job",
          name: "mutable-job",
          cron: "0 9 * * 1-5",
          prompt: "Initial recurring job",
          promptExamples: ["Initial example", "Second example"],
          notify: {
            adapter: "web",
            channelId: "web",
          },
        },
      ],
    });

    const scheduler = new SchedulerAdapter();
    await scheduler.start(createSchedulerContext(dir));

    const toOneTime = scheduler.updateJob("mutable-job", {
      prompt: "Now manual",
      promptExamples: ["Manual example", "  ", "Investigate a one-off issue"],
      notify: {
        adapter: "web",
        channelId: "web",
      },
    });

    assert.equal(toOneTime.success, true);
    assert.deepEqual(loadJobFile(dir), {
      jobs: [
        {
          id: "mutable-job",
          name: "mutable-job",
          prompt: "Now manual",
          promptExamples: ["Manual example", "Investigate a one-off issue"],
          notify: {
            adapter: "web",
            channelId: "web",
          },
        },
      ],
    });

    const toRecurring = scheduler.updateJob("mutable-job", {
      cron: "0 18 * * 5",
      prompt: "Back to recurring",
      promptExamples: ["Weekly wrap-up", "Highlight anomalies"],
      notify: {
        adapter: "web",
        channelId: "web",
      },
      enabled: false,
      timezone: "Asia/Shanghai",
    });

    assert.equal(toRecurring.success, true);
    assert.deepEqual(loadJobFile(dir), {
      jobs: [
        {
          id: "mutable-job",
          name: "mutable-job",
          cron: "0 18 * * 5",
          prompt: "Back to recurring",
          promptExamples: ["Weekly wrap-up", "Highlight anomalies"],
          notify: {
            adapter: "web",
            channelId: "web",
          },
          enabled: false,
          timezone: "Asia/Shanghai",
        },
      ],
    });

    await scheduler.stop();
  });
});
