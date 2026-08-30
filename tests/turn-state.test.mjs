import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(new URL("../extension/lib/turn-state.js", import.meta.url), "utf8");
const context = {module: {exports: {}}};
context.globalThis = context;
vm.runInNewContext(source, context, {filename: "turn-state.js"});
const TurnState = context.module.exports;

test("keeps first-token metadata in THINKING until current-turn output is visible", () => {
  const tracker = TurnState.createTracker();
  assert.equal(tracker.ingest("PROMPT_SUBMITTED", {source: "dom-click"}).state.phase, "THINKING");
  const marker = tracker.ingest("FIRST_VISIBLE_TOKEN", {source: "protocol"});
  assert.equal(marker.state.phase, "THINKING");
  assert.ok(marker.state.firstVisibleTokenAt);
  assert.equal(marker.state.sawVisibleAnswer, false);
  assert.equal(tracker.ingest("VISIBLE_ANSWER", {source: "dom"}).state.phase, "ANSWERING");
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

test("allows a filtered canonical fetch to begin the next turn", () => {
  const tracker = TurnState.createTracker();
  tracker.ingest("PROMPT_SUBMITTED", {source: "dom-click"});
  tracker.ingest("DOM_COMPLETE", {source: "dom"});
  const next = tracker.ingest("PROMPT_SUBMITTED", {source: "fetch"});
  assert.equal(next.state.phase, "THINKING");
  assert.equal(next.state.turnSequence, 2);
});

test("first visible token can recover a missed start without claiming rendered output", () => {
  const tracker = TurnState.createTracker();
  const result = tracker.ingest("FIRST_VISIBLE_TOKEN", {source: "protocol"});
  assert.deepEqual(Array.from(result.transitions, (item) => item.phase), ["THINKING"]);
  assert.equal(result.state.turnSequence, 1);
  assert.equal(result.state.phase, "THINKING");
  assert.equal(result.state.sawVisibleAnswer, false);
});

test("DOM-only visible answer requires an already active turn", () => {
  const tracker = TurnState.createTracker();
  const idleNoise = tracker.ingest("VISIBLE_ANSWER", {source: "dom"});
  assert.equal(idleNoise.state.phase, "IDLE");

  tracker.ingest("PROMPT_SUBMITTED", {source: "dom-submit"});
  const answering = tracker.ingest("VISIBLE_ANSWER", {source: "dom"});
  assert.equal(answering.state.phase, "ANSWERING");
});

test("completion remains complete despite weak post-response DOM noise", () => {
  const tracker = TurnState.createTracker();
  tracker.ingest("PROMPT_SUBMITTED", {source: "dom-click"});
  tracker.ingest("VISIBLE_ANSWER", {source: "dom"});
  tracker.ingest("STREAM_COMPLETE", {source: "protocol"});

  tracker.ingest("GENERATION_ACTIVE", {
    source: "dom",
    confidence: 0.82,
    reason: "generation control is active"
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

test("starts a new monotonic turn after completion from trusted submit", () => {
  const tracker = TurnState.createTracker();
  tracker.ingest("PROMPT_SUBMITTED", {source: "dom-click"});
  tracker.ingest("STREAM_COMPLETE", {source: "protocol"});
  const next = tracker.ingest("PROMPT_SUBMITTED", {source: "dom-submit"});
  assert.equal(next.state.phase, "THINKING");
  assert.equal(next.state.turnSequence, 2);
});

test("recognizes only canonical conversation request paths", () => {
  assert.equal(TurnState.isCanonicalConversationPath("/backend-api/f/conversation"), true);
  assert.equal(TurnState.isCanonicalConversationPath("/backend-api/f/responses"), true);
  assert.equal(TurnState.isCanonicalConversationPath("/backend-api/f/conversation/prepare"), false);
  assert.equal(TurnState.isCanonicalConversationPath("/backend-api/f/conversation/abc"), false);
});

test("classifies Work status and lets explicit completion override stale generation controls", () => {
  assert.equal(TurnState.classifyLiveStatus("작업 중"), "thinking");
  assert.equal(TurnState.classifyLiveStatus("응답 완료"), "complete");
  assert.equal(TurnState.isDomGenerationActive({statusKind: "complete", stopButton: true, streamMarker: true}), false);
  assert.equal(TurnState.isDomGenerationActive({statusKind: "thinking", stopButton: false, streamMarker: false}), true);
});

test("new assistant output excludes stale previous-turn text and accepts replaced roots", () => {
  assert.equal(TurnState.hasNewAssistantOutput(1, 1, true, false), false);
  assert.equal(TurnState.hasNewAssistantOutput(2, 1, true, false), true);
  assert.equal(TurnState.hasNewAssistantOutput(1, 1, true, true), true);
  assert.equal(TurnState.hasNewAssistantOutput(2, 1, false, true), false);
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
