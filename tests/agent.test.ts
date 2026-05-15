import assert from "node:assert/strict";
import test from "node:test";

import { createCustomProviderModelConfig } from "../src/runtime/agent.js";

test("custom provider model config enables reasoning when requested", () => {
  const customModel = createCustomProviderModelConfig({
    modelId: "gpt-5.4",
    apiProtocol: "openai-completions",
    reasoning: true,
  });

  assert.equal(customModel.api, "openai-completions");
  assert.equal(customModel.reasoning, true);
});

