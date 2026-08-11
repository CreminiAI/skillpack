import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PackAgent,
  applyRequestHeadersToModel,
  buildActiveToolNames,
  buildSystemPromptOverrides,
  createCustomProviderModelConfig,
  readAdditionalSkillPaths,
  readFrevanaSystemPrompts,
  sanitizeRequestHeaders,
} from "../src/runtime/agent.js";

test("request headers are sanitized and restored after a model call", () => {
  const sanitized = sanitizeRequestHeaders({
    "X-Agent-Run-Id": "run-1",
    Authorization: "must-not-override-auth",
    "Bad Header": "ignored",
    "X-Injection": "one\r\ntwo",
  });
  assert.deepEqual(sanitized, { "X-Agent-Run-Id": "run-1" });

  const model = { headers: { "X-Existing": "kept" } };
  const restore = applyRequestHeadersToModel(model, sanitized);
  assert.deepEqual(model.headers, {
    "X-Existing": "kept",
    "X-Agent-Run-Id": "run-1",
  });
  restore();
  assert.deepEqual(model.headers, { "X-Existing": "kept" });
});

test("handleMessage forwards the final agent_end after an automatic retry", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "skillpack-agent-"));
  const listeners = new Set<(event: { type: string }) => void>();
  const session = {
    _agentEventQueue: Promise.resolve(),
    state: { messages: [] },
    systemPrompt: "",
    subscribe(listener: (event: { type: string }) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      for (const type of [
        "agent_start",
        "agent_end",
        "agent_start",
        "agent_end",
      ]) {
        for (const listener of listeners) {
          listener({ type });
        }
      }
    },
  };
  const channelSession = {
    session,
    running: false,
    pending: Promise.resolve(),
    fileOutputCallbackRef: { current: null },
    delegatedToolRunContextRef: { current: null },
  };
  const agent = new PackAgent({
    apiKey: "",
    rootDir,
    provider: "openai",
    modelId: "gpt-5.4",
    lifecycleHandler: {
      requestRestart: async () => ({ success: true }),
      requestShutdown: async () => ({ success: true }),
    },
  });
  const events: string[] = [];

  (agent as any).getOrCreateSession = async () => channelSession;

  try {
    await agent.handleMessage(
      "scheduler",
      "scheduler-video",
      "render",
      (event) => {
        events.push(event.type);
      },
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }

  assert.deepEqual(events, [
    "agent_start",
    "agent_end",
    "agent_start",
    "agent_end",
  ]);
});

test("handleMessage applies provider headers only for the current run", async () => {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "skillpack-agent-headers-"),
  );
  const model = { headers: { "X-Base": "base" } };
  let receivedContext:
    | { runId: string; channelId: string; jobId?: string; triggerType: string }
    | undefined;
  const session = {
    model,
    _agentEventQueue: Promise.resolve(),
    state: { messages: [] },
    systemPrompt: "",
    subscribe() {
      return () => undefined;
    },
    async prompt() {
      assert.equal(model.headers["X-Base"], "base");
      assert.equal(
        (model.headers as Record<string, string>)["X-Execution-Run"],
        receivedContext?.runId,
      );
    },
  };
  const channelSession = {
    session,
    running: false,
    pending: Promise.resolve(),
    fileOutputCallbackRef: { current: null },
    delegatedToolRunContextRef: { current: null },
  };
  const agent = new PackAgent({
    apiKey: "",
    rootDir,
    provider: "openai",
    modelId: "gpt-5.4",
    requestHeadersProvider: async (context) => {
      receivedContext = context;
      return { "X-Execution-Run": context.runId };
    },
    lifecycleHandler: {
      requestRestart: async () => ({ success: true }),
      requestShutdown: async () => ({ success: true }),
    },
  });
  (agent as any).getOrCreateSession = async () => channelSession;

  try {
    await agent.handleMessage(
      "scheduler",
      "scheduler-daily",
      "run",
      () => undefined,
    );
    assert.equal(receivedContext?.channelId, "scheduler-daily");
    assert.equal(receivedContext?.jobId, "daily");
    assert.equal(receivedContext?.triggerType, "scheduler");
    assert.deepEqual(model.headers, { "X-Base": "base" });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("PackAgent reuses its host IPC client for request headers", async () => {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "skillpack-agent-host-headers-"),
  );
  const agent = new PackAgent({
    apiKey: "",
    rootDir,
    provider: "openai",
    modelId: "gpt-5.4",
    hostRequestHeadersEnabled: true,
    lifecycleHandler: {
      requestRestart: async () => ({ success: true }),
      requestShutdown: async () => ({ success: true }),
    },
  });
  const context = {
    runId: "run-1",
    channelId: "web",
    triggerType: "web" as const,
  };
  let receivedContext: typeof context | undefined;
  const hostIpcClient = (agent as any).hostIpcClient;
  hostIpcClient.getRequestHeaders = async (input: typeof context) => {
    receivedContext = input;
    return { "X-Host-Run-Id": input.runId };
  };

  try {
    const headers = await (agent as any).resolveRequestHeaders(context);
    assert.deepEqual(receivedContext, context);
    assert.deepEqual(headers, { "X-Host-Run-Id": "run-1" });
  } finally {
    hostIpcClient.dispose();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("custom provider model config enables reasoning when requested", () => {
  const customModel = createCustomProviderModelConfig({
    provider: "openai",
    modelId: "gpt-5.4",
    apiProtocol: "openai-completions",
    reasoning: true,
  });

  assert.equal(customModel.api, "openai-completions");
  assert.equal(customModel.reasoning, true);
  assert.deepEqual(customModel.input, ["text", "image"]);
});

test("custom provider model config reuses registry metadata except api", () => {
  const customModel = createCustomProviderModelConfig(
    {
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      apiProtocol: "openai-completions",
    },
    {
      find(provider, modelId) {
        assert.equal(provider, "anthropic");
        assert.equal(modelId, "claude-opus-4-6");

        return {
          id: "claude-opus-4-6",
          name: "Claude Opus 4.6",
          api: "anthropic-messages",
          provider: "anthropic",
          baseUrl: "https://api.anthropic.com",
          reasoning: true,
          thinkingLevelMap: { off: null, medium: "enabled" },
          input: ["text"],
          cost: {
            input: 15,
            output: 75,
            cacheRead: 1.5,
            cacheWrite: 18.75,
          },
          contextWindow: 200000,
          maxTokens: 32000,
          headers: { "x-test": "1" },
        };
      },
    },
  );

  assert.equal(customModel.api, "openai-completions");
  assert.equal(customModel.name, "Claude Opus 4.6");
  assert.equal(customModel.reasoning, true);
  assert.deepEqual(customModel.thinkingLevelMap, {
    off: null,
    medium: "enabled",
  });
  assert.deepEqual(customModel.input, ["text"]);
  assert.deepEqual(customModel.cost, {
    input: 15,
    output: 75,
    cacheRead: 1.5,
    cacheWrite: 18.75,
  });
  assert.equal(customModel.contextWindow, 200000);
  assert.equal(customModel.maxTokens, 32000);
  assert.deepEqual(customModel.headers, { "x-test": "1" });
  assert.equal("baseUrl" in customModel, false);
});

test("system prompt overrides preserve existing behavior without Frevana prompts", () => {
  assert.deepEqual(buildSystemPromptOverrides("pack prompt", {}), [
    "pack prompt",
  ]);
  assert.deepEqual(buildSystemPromptOverrides(undefined, {}), []);
});

test("system prompt overrides ignore blank Frevana prompts", () => {
  const env = { FREVANA_SYSTEM_PROMPTS: " \n\t " };

  assert.equal(readFrevanaSystemPrompts(env), undefined);
  assert.deepEqual(buildSystemPromptOverrides("pack prompt", env), [
    "pack prompt",
  ]);
});

test("system prompt overrides prepend Frevana prompts before pack prompts", () => {
  const env = { FREVANA_SYSTEM_PROMPTS: "host prompt" };

  assert.deepEqual(buildSystemPromptOverrides("pack prompt", env), [
    "host prompt",
    "pack prompt",
  ]);
});

test("system prompt overrides can inject only Frevana prompts", () => {
  const env = { FREVANA_SYSTEM_PROMPTS: "host prompt" };

  assert.deepEqual(buildSystemPromptOverrides(undefined, env), ["host prompt"]);
});

test("Frevana system prompts trim outer whitespace and preserve internal newlines", () => {
  const env = {
    FREVANA_SYSTEM_PROMPTS: "\n# Host Policy\n\nLine one\nLine two\n",
  };

  assert.equal(
    readFrevanaSystemPrompts(env),
    "# Host Policy\n\nLine one\nLine two",
  );
});

test("additional skill paths are empty when env is unset", () => {
  assert.deepEqual(readAdditionalSkillPaths({}), []);
});

test("additional skill paths parse valid directories and ignore invalid entries", () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "skillpack-extra-skills-"),
  );
  const validDir = path.join(tempDir, "valid");
  const duplicateDir = path.join(tempDir, "valid");
  const filePath = path.join(tempDir, "file.txt");
  const missingDir = path.join(tempDir, "missing");

  fs.mkdirSync(validDir);
  fs.writeFileSync(filePath, "not a directory", "utf-8");

  try {
    assert.deepEqual(
      readAdditionalSkillPaths({
        SKILLPACK_ADDITIONAL_SKILL_PATHS: [
          validDir,
          filePath,
          missingDir,
          duplicateDir,
          "",
        ].join(path.delimiter),
      }),
      [validDir],
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("active tool allowlist includes SDK custom tools", () => {
  assert.deepEqual(
    buildActiveToolNames([
      { name: "send_file" },
      { name: "save_artifacts" },
      { name: "send_file" },
      { name: "" },
      { name: undefined },
    ]),
    ["read", "bash", "edit", "write", "send_file", "save_artifacts"],
  );
});
