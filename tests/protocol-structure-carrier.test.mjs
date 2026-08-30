import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const protocolSource = fs.readFileSync(new URL("../extension/lib/protocol.js", import.meta.url), "utf8");
const carrierSource = fs.readFileSync(new URL("../extension/lib/protocol-structure-carrier.js", import.meta.url), "utf8");

function load() {
  const context = {module: {exports: {}}};
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
