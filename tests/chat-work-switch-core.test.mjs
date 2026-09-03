import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(new URL("../extension/lib/chat-work-switch-core.js", import.meta.url), "utf8");
const context = {module: {exports: {}}};
context.globalThis = context;
vm.runInNewContext(source, context, {filename: "chat-work-switch-core.js"});
const SwitchCore = context.module.exports;

const conversationId = "12345678-abcd-4321-aaaa-0123456789ab";

function requestBody(mode) {
  const common = {
    conversation_id: conversationId,
    messages: [{id: "message-1", author: {role: "user"}, content: {parts: ["private prompt"]}}],
    parent_message_id: "parent-1",
    arbitrary: {keep: true}
  };
  if (mode === "work") {
    return {...common, model: "gpt-5.6-luna-wm", thinking_effort: "standard", conversation_origin: "tpp", service_tier: "standard"};
  }
  return {...common, model: "gpt-5-6-thinking", thinking_effort: "max"};
}

test("builds bounded configs for the existing conversation only", () => {
  const chat = SwitchCore.buildConfig("chat", {model: "gpt-5-6-thinking", thinkingEffort: "max", autoReload: true}, conversationId);
  const work = SwitchCore.buildConfig("work", {model: "gpt-5.6-luna-wm", thinkingEffort: "standard", autoReload: false}, conversationId);
  assert.equal(chat.endpoint, "/backend-api/f/conversation");
  assert.equal(work.endpoint, "/backend-api/f/conversation");
  assert.equal(work.autoReload, false);
  assert.equal(SwitchCore.buildConfig("work", {model: "bad value with spaces"}, conversationId), null);
  assert.equal(SwitchCore.buildConfig("other", {}, conversationId), null);
});

test("work transform changes only allowlisted control fields and preserves protected objects", () => {
  const original = requestBody("chat");
  const messages = original.messages;
  const config = SwitchCore.buildConfig("work", {}, conversationId);
  const result = SwitchCore.transformBody(original, config);
  assert.equal(result.status, "applied");
  assert.equal(result.transformed, true);
  assert.equal(result.body.conversation_id, conversationId);
  assert.strictEqual(result.body.messages, messages);
  assert.equal(result.body.parent_message_id, "parent-1");
  assert.equal(result.body.arbitrary.keep, true);
  assert.equal(result.body.model, "gpt-5.6-luna-wm");
  assert.equal(result.body.thinking_effort, "standard");
  assert.equal(result.body.conversation_origin, "tpp");
  assert.equal(result.body.service_tier, "standard");
  assert.equal(original.conversation_origin, undefined);
});

test("chat transform removes Work discriminators and preserves the message array", () => {
  const original = requestBody("work");
  const messages = original.messages;
  const config = SwitchCore.buildConfig("chat", {}, conversationId);
  const result = SwitchCore.transformBody(original, config);
  assert.equal(result.transformed, true);
  assert.strictEqual(result.body.messages, messages);
  assert.equal(result.body.conversation_id, conversationId);
  assert.equal(result.body.model, "gpt-5-6-thinking");
  assert.equal(result.body.thinking_effort, "max");
  assert.equal("conversation_origin" in result.body, false);
  assert.equal("service_tier" in result.body, false);
});

test("fails closed when the source profile is unknown", () => {
  const original = {...requestBody("chat"), conversation_origin: "unexpected"};
  const config = SwitchCore.buildConfig("work", {}, conversationId);
  const result = SwitchCore.transformBody(original, config);
  assert.equal(result.status, "source-profile-mismatch");
  assert.equal(result.transformed, false);
  assert.strictEqual(result.body, original);
});

test("exposes only the four approved writable paths", () => {
  assert.deepEqual(
    [...SwitchCore.allowedPaths].sort(),
    ['["conversation_origin"]', '["model"]', '["service_tier"]', '["thinking_effort"]'].sort()
  );
});
