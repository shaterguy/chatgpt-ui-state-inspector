import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(new URL("../extension/lib/turn-state.js", import.meta.url), "utf8");
const context = {module: {exports: {}}};
context.globalThis = context;
vm.runInNewContext(source, context, {filename: "turn-state.js"});
const TurnState = context.module.exports;

test("tracks protocol-backed thinking, answering, and completion", () => {
  const tracker = TurnState.createTracker();
  assert.equal(tracker.ingest("PROMPT_SUBMITTED", {source: "fetch"}).state.phase, "THINKING");
  assert.equal(tracker.ingest("FIRST_VISIBLE_TOKEN", {source: "sse"}).state.phase, "ANSWERING");
  assert.equal(tracker.ingest("STREAM_COMPLETE", {source: "sse"}).state.phase, "COMPLETE");
});

test("supports DOM-only fallback signals", () => {
  const tracker = TurnState.createTracker();
  tracker.ingest("GENERATION_ACTIVE", {source: "dom"});
  tracker.ingest("VISIBLE_ANSWER", {source: "dom"});
  const result = tracker.ingest("GENERATION_INACTIVE", {source: "dom"});
  assert.equal(result.state.phase, "COMPLETE");
  assert.equal(result.state.sawVisibleAnswer, true);
});

test("emits both recovery transitions when the first observed signal is visible output", () => {
  const tracker = TurnState.createTracker();
  const result = tracker.ingest("VISIBLE_ANSWER", {source: "dom"});
  assert.deepEqual(Array.from(result.transitions, (item) => item.phase), ["THINKING", "ANSWERING"]);
});

test("ignores completion noise when no turn is active", () => {
  const tracker = TurnState.createTracker();
  const result = tracker.ingest("STREAM_COMPLETE", {source: "ambient"});
  assert.equal(result.state.phase, "IDLE");
  assert.equal(result.changed, false);
});

test("starts a new monotonic turn after completion", () => {
  const tracker = TurnState.createTracker();
  tracker.ingest("PROMPT_SUBMITTED");
  tracker.ingest("STREAM_COMPLETE");
  const next = tracker.ingest("PROMPT_SUBMITTED");
  assert.equal(next.state.phase, "THINKING");
  assert.equal(next.state.turnSequence, 2);
});

test("hydrates the last persisted canonical state", () => {
  const tracker = TurnState.createTracker({
    phase: "ANSWERING",
    turnSequence: 4,
    turnId: "turn-4",
    generationActive: true,
    sawVisibleAnswer: true,
    source: "protocol"
  });
  assert.equal(tracker.snapshot().phase, "ANSWERING");
  assert.equal(tracker.snapshot().turnSequence, 4);
});
