import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(new URL("../extension/lib/protocol.js", import.meta.url), "utf8");
const context = {module: {exports: {}}};
context.globalThis = context;
vm.runInNewContext(source, context, {filename: "protocol.js"});
const Protocol = context.module.exports;

test("detects the first user-visible token marker", () => {
  const result = Protocol.summarizeSseData(JSON.stringify({
    type: "message_marker",
    marker: "user_visible_token",
    event: "first"
  }));
  assert.equal(result.signals[0].code, "FIRST_VISIBLE_TOKEN");
});

test("detects stream completion variants", () => {
  assert.equal(
    Protocol.detectSignals(Protocol.summarizePayload({type: "message_stream_complete"}))[0].code,
    "STREAM_COMPLETE"
  );
  assert.equal(
    Protocol.detectSignals(Protocol.summarizePayload({message: {status: "finished_successfully", end_turn: true}}))[0].code,
    "STREAM_COMPLETE"
  );
});

test("never returns assistant message text in sanitized frame metadata", () => {
  const secret = "private answer body 12345";
  const summary = Protocol.summarizePayload({
    type: "message",
    message: {
      author: {role: "assistant"},
      content: {content_type: "text", parts: [secret]},
      status: "in_progress"
    }
  });
  assert.equal(summary.assistantVisibleText, true);
  assert.equal(JSON.stringify(summary).includes(secret), false);
});

test("does not echo an unparsed frame", () => {
  const secret = "person@example.com private prompt";
  const result = Protocol.summarizeSseData(secret);
  assert.equal(result.summary.parseError, true);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("treats the SSE done sentinel as completion", () => {
  const result = Protocol.summarizeSseData("[DONE]");
  assert.equal(result.signals[0].code, "STREAM_COMPLETE");
});
