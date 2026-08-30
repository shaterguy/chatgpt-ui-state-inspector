import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(new URL("../extension/lib/turn-state.js", import.meta.url), "utf8");
const context = {module: {exports: {}}};
context.globalThis = context;
vm.runInNewContext(source, context, {filename: "turn-state.js"});
const TurnState = context.module.exports;

test("tracks trusted submit, protocol first token, and completion", () => {
  const tracker = TurnState.createTracker();
  assert.equal(tracker.ingest("PROMPT_SUBMITTED", {source: "dom-click"}).state.phase, "THINKING");
  assert.equal(tracker.ingest("FIRST_VISIBLE_TOKEN", {source: "protocol"}).state.phase, "ANSWERING");
  assert.equal(tracker.ingest("STREAM_COMPLETE", {source: "protocol"}).state.phase, "COMPLETE");
});

test("ignores weak ambient generation evidence while idle", () => {
  const tracker = TurnState.createTracker();
  const weak = tracker.ingest("GENERATION_ACTIVE", {
    source: "dom",
    confidence: 0.82,
    reason: "generation control is active"
  });
  assert.equal(weak.state.phase, "IDLE");
  assert.equal(weak.state.generationActive, false);
  assert.equal(weak.changed, false);
});

test("allows explicit thinking live status as a recovery start", () => {
  const tracker = TurnState.createTracker();
  const result = tracker.ingest("GENERATION_ACTIVE", {
    source: "dom",
    confidence: 0.9,
    reason: "live status reports thinking"
  });
  assert.equal(result.state.phase, "THINKING");
  assert.equal(result.state.turnSequence, 1);
});

test("does not let background fetch preparation start a turn", () => {
  const tracker = TurnState.createTracker();
  const result = tracker.ingest("PROMPT_SUBMITTED", {
    source: "fetch",
    confidence: 0.9,
    reason: "conversation request observed"
  });
  assert.equal(result.state.phase, "IDLE");
  assert.equal(result.state.turnSequence, 0);
});

test("first visible token can recover when the start event was missed", () => {
  const tracker = TurnState.createTracker();
  const result = tracker.ingest("FIRST_VISIBLE_TOKEN", {source: "protocol"});
  assert.deepEqual(Array.from(result.transitions, (item) => item.phase), ["THINKING", "ANSWERING"]);
  assert.equal(result.state.turnSequence, 1);
});

test("DOM-only visible answer requires an already active turn", () => {
  const tracker = TurnState.createTracker();
  const idleNoise = tracker.ingest("VISIBLE_ANSWER", {source: "dom"});
  assert.equal(idleNoise.state.phase, "IDLE");

  tracker.ingest("PROMPT_SUBMITTED", {source: "dom-submit"});
  const answering = tracker.ingest("VISIBLE_ANSWER", {source: "dom"});
  assert.equal(answering.state.phase, "ANSWERING");
});

test("completion remains complete despite captured post-response noise", () => {
  const tracker = TurnState.createTracker();
  tracker.ingest("PROMPT_SUBMITTED", {source: "dom-click"});
  tracker.ingest("FIRST_VISIBLE_TOKEN", {source: "protocol"});
  tracker.ingest("STREAM_COMPLETE", {source: "protocol"});

  tracker.ingest("GENERATION_ACTIVE", {
    source: "dom",
    confidence: 0.82,
    reason: "generation control is active"
  });
  tracker.ingest("PROMPT_SUBMITTED", {
    source: "fetch",
    confidence: 0.9,
    reason: "conversation request observed"
  });
  tracker.ingest("VISIBLE_ANSWER", {source: "dom"});

  assert.equal(tracker.snapshot().phase, "COMPLETE");
  assert.equal(tracker.snapshot().turnSequence, 1);
  assert.equal(tracker.snapshot().generationActive, false);
});

test("ignores completion noise when no turn is active", () => {
  const tracker = TurnState.createTracker();
  const result = tracker.ingest("STREAM_COMPLETE", {source: "ambient"});
  assert.equal(result.state.phase, "IDLE");
  assert.equal(result.changed, false);
});

test("starts a new monotonic turn after completion only from trusted submit", () => {
  const tracker = TurnState.createTracker();
  tracker.ingest("PROMPT_SUBMITTED", {source: "dom-click"});
  tracker.ingest("STREAM_COMPLETE", {source: "protocol"});
  tracker.ingest("PROMPT_SUBMITTED", {source: "fetch"});
  assert.equal(tracker.snapshot().phase, "COMPLETE");
  const next = tracker.ingest("PROMPT_SUBMITTED", {source: "dom-submit"});
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
