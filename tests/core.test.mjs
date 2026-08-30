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

test("omits descriptive and value-like attributes on sensitive surfaces", () => {
  const values = {
    "aria-label": "private prompt",
    "data-value": "private input",
    "data-testid": "composer-input",
    "class": "stable"
  };
  const element = {
    matches: () => true,
    closest: () => null,
    hasAttribute: (name) => Object.hasOwn(values, name),
    getAttribute: (name) => values[name] ?? null
  };
  const attrs = Core.attributeSnapshot(element);
  assert.equal(attrs["aria-label"], undefined);
  assert.equal(attrs["data-value"], undefined);
  assert.equal(attrs["data-testid"], "composer-input");
  assert.deepEqual(Array.from(attrs.classTokens), ["stable"]);
});

test("revalidates forged protocol frames with a field allowlist", () => {
  const secret = "private answer body 12345";
  const sanitized = Core.sanitizeProbeMessage("protocol_frame", {
    transport: "fetch-sse",
    requestId: "fetch-1",
    path: "/backend-api/conversation/12345678901234567890",
    rawBody: secret,
    summary: {
      type: secret,
      marker: "user_visible_token",
      topLevelKeys: ["type", secret],
      rawBody: secret,
      byteLength: 42
    },
    signals: [{code: "FIRST_VISIBLE_TOKEN", reason: secret, confidence: 0.99}]
  });
  const json = JSON.stringify(sanitized);
  assert.equal(json.includes(secret), false);
  assert.equal(sanitized.path, "/backend-api/conversation/:id");
  assert.equal(sanitized.summary.type, null);
  assert.deepEqual(Array.from(sanitized.summary.topLevelKeys), ["type"]);
  assert.equal(sanitized.signals[0].reason, "first user-visible token marker observed");
});

test("ignores page-supplied free-text reasons and unknown signals", () => {
  const accepted = Core.sanitizeProbeMessage("state_signal", {
    code: "STREAM_COMPLETE",
    reason: "private completion text",
    source: "protocol",
    confidence: 0.9
  });
  assert.equal(accepted.reason, "stream completion signal observed");
  assert.equal(Core.sanitizeProbeMessage("state_signal", {code: "PRIVATE_PROMPT"}), null);
});

test("rejects unknown bridge message types", () => {
  assert.equal(Core.sanitizeProbeMessage("store_raw_payload", {text: "secret"}), null);
});
