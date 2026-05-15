import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  configManager,
  resolveRuntimeConfig,
  SKILLPACK_RUNTIME_ENV,
} from "../src/runtime/config.js";
import { getRuntimeConfigSignature } from "../src/runtime/adapters/web.js";

function createTempRootDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skillpack-config-"));
}

function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T,
): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("config manager can clear feishu adapter settings with null", () => {
  const rootDir = createTempRootDir();

  configManager.load(rootDir);
  configManager.save(rootDir, {
    adapters: {
      telegram: { token: "tg-token" },
      feishu: { appId: "cli_test", appSecret: "secret_test" },
    },
  });

  configManager.save(rootDir, {
    adapters: {
      feishu: null,
    },
  });

  const saved = JSON.parse(
    fs.readFileSync(path.join(rootDir, "data", "config.json"), "utf-8"),
  );

  assert.deepEqual(saved.adapters, {
    telegram: { token: "tg-token" },
  });
});

test("runtime config signature changes when feishu credentials change", () => {
  const before = getRuntimeConfigSignature({
    adapters: {
      feishu: {
        appId: "cli_test_a",
        appSecret: "secret_a",
      },
    },
  });

  const after = getRuntimeConfigSignature({
    adapters: {
      feishu: {
        appId: "cli_test_b",
        appSecret: "secret_a",
      },
    },
  });

  assert.notEqual(before, after);
});

test("runtime config signature changes when feishu domain changes", () => {
  const before = getRuntimeConfigSignature({
    adapters: {
      feishu: {
        appId: "cli_test_a",
        appSecret: "secret_a",
        domain: "feishu",
      },
    },
  });

  const after = getRuntimeConfigSignature({
    adapters: {
      feishu: {
        appId: "cli_test_a",
        appSecret: "secret_a",
        domain: "lark",
      },
    },
  });

  assert.notEqual(before, after);
});

test("skillpack runtime env overrides file config for pack agent options", () => {
  const rootDir = createTempRootDir();
  const configPath = path.join(rootDir, "data", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      apiKey: "file-key",
      provider: "anthropic",
      baseUrl: "https://old.example.com",
      apiProtocol: "openai-responses",
      reasoning: false,
    }),
    "utf-8",
  );

  const loaded = withEnv(
    {
      [SKILLPACK_RUNTIME_ENV.apiKey]: "frevana-token",
      [SKILLPACK_RUNTIME_ENV.provider]: "openai",
      [SKILLPACK_RUNTIME_ENV.baseUrl]: "http://localhost:8001/openai/v1",
      [SKILLPACK_RUNTIME_ENV.apiProtocol]: "openai-completions",
      [SKILLPACK_RUNTIME_ENV.reasoning]: "true",
      OPENAI_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
    },
    () => configManager.load(rootDir),
  );

  assert.equal(loaded.apiKey, "frevana-token");
  assert.equal(loaded.provider, "openai");
  assert.equal(loaded.baseUrl, "http://localhost:8001/openai/v1");
  assert.equal(loaded.apiProtocol, "openai-completions");
  assert.equal(loaded.reasoning, true);
});

test("explicit empty SKILLPACK_API_KEY overrides file config and provider env fallback", () => {
  const resolved = withEnv(
    {
      [SKILLPACK_RUNTIME_ENV.apiKey]: "",
      OPENAI_API_KEY: "fallback-key",
    },
    () =>
      resolveRuntimeConfig({
        apiKey: "file-key",
        provider: "anthropic",
      }),
  );

  assert.equal(resolved.apiKey, "");
  assert.equal(resolved.provider, "anthropic");
});

test("SKILLPACK_REASONING parses true and false values", () => {
  const enabled = withEnv(
    {
      [SKILLPACK_RUNTIME_ENV.reasoning]: "true",
    },
    () => resolveRuntimeConfig({}),
  );
  const disabled = withEnv(
    {
      [SKILLPACK_RUNTIME_ENV.reasoning]: "false",
    },
    () => resolveRuntimeConfig({ reasoning: true }),
  );

  assert.equal(enabled.reasoning, true);
  assert.equal(disabled.reasoning, false);
});

test("saving unrelated config does not persist skillpack runtime env overrides", () => {
  const rootDir = createTempRootDir();

  withEnv(
    {
      [SKILLPACK_RUNTIME_ENV.apiKey]: "frevana-token",
      [SKILLPACK_RUNTIME_ENV.provider]: "openai",
      [SKILLPACK_RUNTIME_ENV.baseUrl]: "http://localhost:8001/openai/v1",
      [SKILLPACK_RUNTIME_ENV.apiProtocol]: "openai-completions",
      [SKILLPACK_RUNTIME_ENV.reasoning]: "true",
    },
    () => {
      configManager.load(rootDir);
      configManager.save(rootDir, {
        adapters: {
          telegram: { token: "tg-token" },
        },
      });
    },
  );

  const saved = JSON.parse(
    fs.readFileSync(path.join(rootDir, "data", "config.json"), "utf-8"),
  );

  assert.deepEqual(saved, {
    adapters: {
      telegram: { token: "tg-token" },
    },
  });
});
