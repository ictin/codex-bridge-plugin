import test from "node:test";
import assert from "node:assert/strict";

import { buildConversationKey, parseConversationKey } from "../lib/conversation-key.js";

test("buildConversationKey for DM", () => {
  const key = buildConversationKey({
    channel: "telegram",
    accountId: "default",
    to: "tg:123456789",
  });
  assert.equal(key, "telegram:default:dm:123456789");
});

test("buildConversationKey for group topic", () => {
  const key = buildConversationKey({
    channel: "telegram",
    accountId: "opsbot",
    to: "tg:-1001234567890",
    messageThreadId: 42,
  });
  assert.equal(key, "telegram:opsbot:group:-1001234567890:topic:42");
});

test("parseConversationKey parses topic id when present", () => {
  const parsed = parseConversationKey("telegram:opsbot:group:-1001234567890:topic:42");
  assert.deepEqual(parsed, {
    channel: "telegram",
    accountId: "opsbot",
    peerKind: "group",
    peerId: "-1001234567890",
    topicId: 42,
  });
});
