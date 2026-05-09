import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConversationService } from "../src/runtime/services/conversation.js";

test("conversation service detects feishu platform from channel id", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "skillpack-conversations-"));
  const service = new ConversationService(rootDir);

  const [conversation] = service.listConversations(new Set(["feishu-oc_test_chat"]));

  assert.equal(conversation?.channelId, "feishu-oc_test_chat");
  assert.equal(conversation?.platform, "feishu");
});
