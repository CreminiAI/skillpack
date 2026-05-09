import test from "node:test";
import assert from "node:assert/strict";

import { createManageScheduleTool } from "../src/runtime/tools/manage-schedule-tool.js";

test("manage_scheduled_task can create a scheduled job from web chat", async () => {
  let capturedJob: any = null;
  const tool = createManageScheduleTool(
    {
      current: {
        addJob(job: unknown) {
          capturedJob = job;
          return { success: true, message: "created" };
        },
      } as any,
    },
    "web",
    "web",
    () => "generated-job-id",
  );

  const result = await tool.execute(
    "call-1",
    {
      action: "add",
      name: "daily-brief",
      cron: "0 9 * * 1-5",
      prompt: "Send the daily brief",
    },
    {} as AbortSignal,
    async () => {},
    {} as any,
  );

  assert.equal(result.content[0]?.type, "text");
  assert.equal((result.content[0] as any)?.text, "created");
  assert.deepEqual(capturedJob, {
    id: "generated-job-id",
    name: "daily-brief",
    cron: "0 9 * * 1-5",
    prompt: "Send the daily brief",
    notify: {
      adapter: "web",
      channelId: "web",
    },
    enabled: true,
    timezone: undefined,
  });
});

test("manage_scheduled_task requires notify override fields as a pair", async () => {
  const tool = createManageScheduleTool(
    {
      current: {
        addJob() {
          throw new Error("should not be called");
        },
      } as any,
    },
    "web",
    "web",
  );

  const result = await tool.execute(
    "call-2",
    {
      action: "add",
      name: "daily-brief",
      cron: "0 9 * * 1-5",
      prompt: "Send the daily brief",
      notifyAdapter: "slack",
    },
    {} as AbortSignal,
    async () => {},
    {} as any,
  );

  assert.equal(result.content[0]?.type, "text");
  assert.match(
    (result.content[0] as any)?.text,
    /'notifyAdapter' and 'notifyChannelId' must be provided together/,
  );
});

test("manage_scheduled_task can use the current feishu chat as default notify target", async () => {
  let capturedJob: any = null;
  const tool = createManageScheduleTool(
    {
      current: {
        addJob(job: unknown) {
          capturedJob = job;
          return { success: true, message: "created" };
        },
      } as any,
    },
    "feishu",
    "feishu-oc_test_chat",
    () => "generated-feishu-job-id",
  );

  const result = await tool.execute(
    "call-3",
    {
      action: "add",
      name: "feishu-daily-brief",
      cron: "0 9 * * 1-5",
      prompt: "Send the daily brief",
    },
    {} as AbortSignal,
    async () => {},
    {} as any,
  );

  assert.equal(result.content[0]?.type, "text");
  assert.equal((result.content[0] as any)?.text, "created");
  assert.deepEqual(capturedJob, {
    id: "generated-feishu-job-id",
    name: "feishu-daily-brief",
    cron: "0 9 * * 1-5",
    prompt: "Send the daily brief",
    notify: {
      adapter: "feishu",
      channelId: "feishu-oc_test_chat",
    },
    enabled: true,
    timezone: undefined,
  });
});
