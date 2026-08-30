import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const protocolSource = fs.readFileSync(new URL("../extension/lib/protocol.js", import.meta.url), "utf8");
const carrierSource = fs.readFileSync(new URL("../extension/lib/protocol-structure-carrier.js", import.meta.url), "utf8");
const nativeSource = fs.readFileSync(new URL("../extension/lib/work-native-state.js", import.meta.url), "utf8");

function load() {
  const context = {module: {exports: {}}, atob: globalThis.atob, TextDecoder: globalThis.TextDecoder};
  context.globalThis = context;
  vm.runInNewContext(protocolSource, context, {filename: "protocol.js"});
  vm.runInNewContext(carrierSource, context, {filename: "protocol-structure-carrier.js"});
  vm.runInNewContext(nativeSource, context, {filename: "work-native-state.js"});
  return context.UiStateInspectorProtocol;
}

function workFrame(marker) {
  const inner = JSON.stringify({
    type: "message_marker",
    conversation_id: "conversation-id",
    message_id: "message-id",
    marker,
    event: "first"
  });
  return [{
    type: "message",
    payload: {
      type: "id",
      payload: {
        type: "stream-item",
        encoded_item: `event: delta\ndata: ${inner}\n\n`
      }
    }
  }];
}

test("Work user_visible_token remains only an early visibility marker", () => {
  const Protocol = load();
  const summary = Protocol.summarizePayload(workFrame("user_visible_token"));
  const signals = Protocol.detectSignals(summary);
  assert.ok(signals.some((signal) => signal.code === "FIRST_VISIBLE_TOKEN"));
  assert.equal(signals.some((signal) => signal.code === "VISIBLE_ANSWER"), false);
});

test("Work final_channel_token first promotes native answer start", () => {
  const Protocol = load();
  const summary = Protocol.summarizePayload(workFrame("final_channel_token"));
  const signals = Protocol.detectSignals(summary);
  assert.ok(summary.messageKeys.includes("ec:s:marker:final_channel_token:marker"));
  assert.ok(summary.messageKeys.includes("ec:s:event:first:event"));
  assert.ok(signals.some((signal) => signal.code === "FIRST_VISIBLE_TOKEN"));
  assert.ok(signals.some((signal) => signal.code === "VISIBLE_ANSWER" && signal.confidence === 1));
});
