import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const protocolSource = fs.readFileSync(new URL("../extension/lib/protocol.js", import.meta.url), "utf8");
const carrierSource = fs.readFileSync(new URL("../extension/lib/protocol-structure-carrier.js", import.meta.url), "utf8");

function load() {
  const context = {module: {exports: {}}, atob: globalThis.atob, TextDecoder: globalThis.TextDecoder};
  context.globalThis = context;
  vm.runInNewContext(protocolSource, context, {filename: "protocol.js"});
  vm.runInNewContext(carrierSource, context, {filename: "protocol-structure-carrier.js"});
  return context;
}

test("encodes parser identity, state candidates, and key paths into sanitizer-safe token arrays", () => {
  const context = load();
  const summary = context.UiStateInspectorProtocol.summarizePayload({
    type: "conversation-update",
    payload: {
      status: "running",
      phase: "analysis",
      end_turn: false,
      nested: JSON.stringify({state: "streaming"})
    },
    metadata: {kind: "work"}
  });

  assert.ok(summary.topLevelKeys.some((item) => item === "carrier:0.1.3-dev7"));
  assert.ok(summary.topLevelKeys.some((item) => item === "decoder:0.1.6-dev10"));
  assert.ok(summary.topLevelKeys.some((item) => item === "parser:0.1.1-dev5"));
  assert.ok(summary.messageKeys.some((item) => item.startsWith("sc:s:status:running:")));
  assert.ok(summary.messageKeys.some((item) => item.startsWith("sc:s:phase:analysis:")));
  assert.ok(summary.messageKeys.some((item) => item.startsWith("sc:b:end_turn:false:")));
  assert.ok(summary.messageKeys.some((item) => item.includes(":state:streaming:")));
  assert.ok(summary.metadataKeys.some((item) => item.startsWith("kp:")));
  for (const field of [summary.topLevelKeys, summary.messageKeys, summary.metadataKeys]) {
    assert.ok(field.every((item) => /^[A-Za-z0-9_.:/-]{1,80}$/.test(item)));
  }
});

test("decodes base64 JSON encoded_item but retains only structural and state-like metadata", () => {
  const context = load();
  const inner = {
    type: "assistant_message",
    status: "in_progress",
    phase: "final",
    end_turn: false,
    content: "private user supplied answer text must never be exported"
  };
  const encodedItem = Buffer.from(JSON.stringify(inner), "utf8").toString("base64");
  const summary = context.UiStateInspectorProtocol.summarizePayload([{
    type: "message",
    payload: {
      type: "id",
      payload: {
        type: "stream-item",
        encoded_item: encodedItem
      }
    }
  }]);

  assert.ok(summary.topLevelKeys.includes("decoder:0.1.6-dev10"));
  assert.ok(summary.topLevelKeys.includes("ei:count:1"));
  assert.ok(summary.topLevelKeys.includes("ei:codec:b64-json"));
  assert.ok(summary.messageKeys.some((item) => item.startsWith("ec:s:type:assistant_message:")));
  assert.ok(summary.messageKeys.some((item) => item.startsWith("ec:s:status:in_progress:")));
  assert.ok(summary.messageKeys.some((item) => item.startsWith("ec:s:phase:final:")));
  assert.ok(summary.messageKeys.some((item) => item.startsWith("ec:b:end_turn:false:")));
  assert.ok(summary.metadataKeys.some((item) => item.startsWith("ek:")));

  const joined = [...summary.topLevelKeys, ...summary.messageKeys, ...summary.metadataKeys].join(" ");
  assert.doesNotMatch(joined, /private|supplied|answer|exported/);
});

test("classifies opaque encoded_item values without exposing their contents", () => {
  const context = load();
  const secret = "opaque-secret-value-that-must-not-escape";
  const summary = context.UiStateInspectorProtocol.summarizePayload([{
    type: "message",
    payload: {type: "id", payload: {type: "stream-item", encoded_item: secret}}
  }]);
  const joined = [...summary.topLevelKeys, ...summary.messageKeys, ...summary.metadataKeys].join(" ");
  assert.ok(summary.topLevelKeys.some((item) => item.startsWith("ei:codec:")));
  assert.doesNotMatch(joined, /opaque|secret|escape/);
});

test("promotes the Work websocket done envelope to native stream completion", () => {
  const context = load();
  const summary = context.UiStateInspectorProtocol.summarizePayload([{
    type: "message",
    payload: {
      type: "id",
      payload: {type: "done", conversation_id: "conversation-id", turn_id: "turn-id"}
    }
  }], 309);
  const signals = context.UiStateInspectorProtocol.detectSignals(summary);
  assert.ok(summary.messageKeys.some((item) => item.startsWith("sc:s:type:done:")));
  assert.ok(signals.some((signal) => signal.code === "STREAM_COMPLETE" && signal.confidence >= 0.99));
});

test("does not encode arbitrary non-state free text", () => {
  const context = load();
  const summary = context.UiStateInspectorProtocol.summarizePayload({
    type: "conversation-update",
    payload: {
      message: "this is private user supplied prose and must not pass",
      description: "another private sentence",
      status: "running"
    }
  });
  const joined = [...summary.topLevelKeys, ...summary.messageKeys, ...summary.metadataKeys].join(" ");
  assert.doesNotMatch(joined, /private|sentence|prose|supplied/);
  assert.match(joined, /sc:s:status:running:/);
});
