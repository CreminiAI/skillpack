import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildActiveToolNames,
  buildSystemPromptOverrides,
  createCustomProviderModelConfig,
  readAdditionalSkillPaths,
  readFrevanaSystemPrompts,
} from "../src/runtime/agent.js";

test("custom provider model config enables reasoning when requested", () => {
  const customModel = createCustomProviderModelConfig({
    modelId: "gpt-5.4",
    apiProtocol: "openai-completions",
    reasoning: true,
  });

  assert.equal(customModel.api, "openai-completions");
  assert.equal(customModel.reasoning, true);
  assert.deepEqual(customModel.input, ["text", "image"]);
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
