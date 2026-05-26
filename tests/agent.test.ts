import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSystemPromptOverrides,
  createCustomProviderModelConfig,
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

  assert.deepEqual(buildSystemPromptOverrides(undefined, env), [
    "host prompt",
  ]);
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
