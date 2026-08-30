import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const probe = fs.readFileSync(new URL("../extension/page-probe.js", import.meta.url), "utf8");
const protocol = fs.readFileSync(new URL("../extension/lib/protocol.js", import.meta.url), "utf8");
const core = fs.readFileSync(new URL("../extension/lib/core.js", import.meta.url), "utf8");

test("MAIN-world probe has no extension API or persistent browser storage access", () => {
  assert.doesNotMatch(probe, /\bchrome\s*\./);
  assert.doesNotMatch(probe, /\b(?:localStorage|sessionStorage|indexedDB)\b/);
  assert.doesNotMatch(probe, /document\.cookie/);
});

test("probe only clones responses and does not consume the original stream", () => {
  assert.match(probe, /response\.clone\(\)/);
  assert.match(probe, /Reflect\.apply\(nativeFetch/);
  assert.doesNotMatch(probe, /response\.text\s*\(/);
  assert.doesNotMatch(probe, /response\.json\s*\(/);
});

test("protocol metadata excludes raw payload fields", () => {
  assert.doesNotMatch(protocol, /raw(?:Data|Payload|Body)\s*:/);
  assert.doesNotMatch(protocol, /parts\s*:\s*parts/);
  assert.match(protocol, /assistantVisibleText/);
  assert.match(protocol, /topLevelKeys/);
});

test("isolated world stops and allowlist-reissues every page probe message", () => {
  assert.match(core, /sanitizeProbeMessage/);
  assert.match(core, /stopImmediatePropagation\(\)/);
  assert.match(core, /new MessageEvent\("message"/);
  assert.match(core, /forwardedEvents\.add/);
});
