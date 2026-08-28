import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(new URL("../extension/lib/core.js", import.meta.url), "utf8");
const context = {module: {exports: {}}, URL};
context.globalThis = context;
vm.runInNewContext(source, context, {filename: "core.js"});
const Core = context.module.exports;

test("sanitizes likely private free text", () => {
  assert.equal(Core.sanitizeText("person@example.com"), "[redacted]");
  assert.equal(Core.sanitizeText("https://example.com/private"), "[redacted]");
  assert.equal(Core.sanitizeText("+82 10-1234-5678"), "[redacted]");
  assert.equal(Core.sanitizeText("x".repeat(141)), "[redacted:long-text]");
});

test("keeps compact model-like control labels", () => {
  assert.equal(Core.sanitizeText("GPT-5 Thinking"), "GPT-5 Thinking");
  assert.equal(Core.sanitizeText("  Work   mode  "), "Work mode");
});

test("recognizes conversation-style paths as sensitive", () => {
  assert.equal(Core.isLikelySensitiveHref("/c/abc123"), true);
  assert.equal(Core.isLikelySensitiveHref("/g/g-123/name"), true);
  assert.equal(Core.isLikelySensitiveHref("/settings"), false);
});

test("filters unstable class tokens", () => {
  assert.deepEqual(
    Array.from(Core.stableClassTokens("flex css-deadbeef foo-123456789012 stable rounded")),
    ["flex", "stable", "rounded"]
  );
});
