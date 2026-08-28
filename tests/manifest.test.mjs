import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));

test("uses Manifest V3 and a single host boundary", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://chatgpt.com/*"]);
  assert.equal(manifest.host_permissions, undefined);
});

test("requests only storage and side-panel permissions", () => {
  assert.deepEqual(
    [...manifest.permissions].sort(),
    ["sidePanel", "storage", "unlimitedStorage"].sort()
  );
});

test("all manifest files exist", () => {
  const files = [
    manifest.background.service_worker,
    manifest.side_panel.default_path,
    ...manifest.content_scripts.flatMap((script) => script.js)
  ];
  for (const file of files) {
    assert.equal(fs.existsSync(path.join(new URL("../extension/", root).pathname, file)), true, file);
  }
});
