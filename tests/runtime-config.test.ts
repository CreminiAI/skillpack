import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { configManager } from "../src/runtime/config.js";
import { getRuntimeConfigSignature } from "../src/runtime/adapters/web.js";

function createTempRootDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skillpack-config-"));
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
