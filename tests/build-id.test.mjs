import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const manifest = JSON.parse(fs.readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
const source = fs.readFileSync(new URL("../extension/lib/protocol.js", import.meta.url), "utf8");
const context = {module: {exports: {}}};
context.globalThis = context;
vm.runInNewContext(source, context, {filename: "protocol.js"});
const Protocol = context.module.exports;

test("dev12 has a distinct Chrome version while retaining the stamped dev5 parser build", () => {
  assert.equal(manifest.version, "0.1.8");
  assert.match(manifest.version_name, /dev12/);
  const summary = Protocol.summarizePayload({status: "running"});
  assert.equal(summary.buildId, "0.1.1-dev5");
  assert.equal(summary.rootKind, "object");
  assert.ok(Array.isArray(summary.keyPaths));
  assert.ok(Array.isArray(summary.stateCandidates));
});
