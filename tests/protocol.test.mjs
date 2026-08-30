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

test("detects the first final-channel token marker", () => {
  const result = Protocol.summarizeSseData(JSON.stringify({
    type: "message_marker",
    marker: "final_channel_token",
    event: "first"
  }));
  assert.equal(result.signals[0].code, "FIRST_VISIBLE_TOKEN");
  assert.equal(result.signals[0].confidence, 1);
});

test("detects explicit stream completion variants", () => {
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

test("treats SSE DONE as transport metadata, not whole-turn completion", () => {
  const result = Protocol.summarizeSseData("[DONE]");
  assert.equal(result.summary.type, "sse_done");
  assert.deepEqual(Array.from(result.signals), []);
});

test("describes array-root Work websocket envelopes without recording body text", () => {
  const secret = "do not record this work body";
  const summary = Protocol.summarizePayload([
    "channel_event",
    {
      type: "task_update",
      payload: {
        task_status: "running",
        phase: "working",
        body: secret
      }
    }
  ], 512);

  assert.equal(summary.rootKind, "array");
  assert.equal(summary.rootArrayLengthBucket, 4);
  assert.ok(summary.keyPaths.some((entry) => entry.path === "$[1].type"));
  assert.ok(summary.keyPaths.some((entry) => entry.path === "$[1].payload.task_status"));
  assert.ok(summary.stateCandidates.some((entry) => entry.path === "$[1].type" && entry.value === "task_update"));
  assert.ok(summary.stateCandidates.some((entry) => entry.path === "$[1].payload.task_status" && entry.value === "running"));
  assert.ok(summary.stateCandidates.some((entry) => entry.path === "$[1].payload.phase" && entry.value === "working"));
  assert.equal(JSON.stringify(summary).includes(secret), false);
});

test("descends into stringified JSON envelopes while retaining only structural metadata", () => {
  const secret = "private tool output";
  const summary = Protocol.summarizePayload([
    JSON.stringify({
      event: {
        type: "run_state",
        status: "completed",
        result: secret
      }
    })
  ]);

  assert.ok(summary.nestedJsonPaths.includes("$[0]::<json>"));
  assert.ok(summary.keyPaths.some((entry) => entry.path === "$[0]::<json>.event.status"));
  assert.ok(summary.stateCandidates.some((entry) => entry.path === "$[0]::<json>.event.status" && entry.value === "completed"));
  assert.equal(JSON.stringify(summary).includes(secret), false);
});

test("does not expose arbitrary short string values from non-state keys", () => {
  const secret = "short_private_text";
  const summary = Protocol.summarizePayload({
    payload: {
      title: secret,
      status: "running"
    }
  });

  assert.equal(JSON.stringify(summary).includes(secret), false);
  assert.ok(summary.stateCandidates.some((entry) => entry.value === "running"));
});
