import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const manifest = JSON.parse(fs.readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
const sidepanelHtml = fs.readFileSync(new URL("../extension/sidepanel.html", import.meta.url), "utf8");
const sidepanelSource = fs.readFileSync(new URL("../extension/sidepanel.js", import.meta.url), "utf8");
const handshakeSource = fs.readFileSync(new URL("../extension/handshake.js", import.meta.url), "utf8");
const contentSource = fs.readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");
const pageProbeSource = fs.readFileSync(new URL("../extension/page-probe.js", import.meta.url), "utf8");

test("uses Manifest V3 and a single host boundary across both worlds", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.content_scripts.length, 2);
  for (const contentScript of manifest.content_scripts) {
    assert.deepEqual(contentScript.matches, ["https://chatgpt.com/*"]);
    assert.equal(contentScript.run_at, "document_start");
  }
  assert.equal(manifest.content_scripts[0].world, "MAIN");
  assert.equal(manifest.content_scripts[1].world, "ISOLATED");
  assert.equal(manifest.host_permissions, undefined);
});

test("requests only active-tab injection, storage, and side-panel permissions", () => {
  assert.deepEqual(
    [...manifest.permissions].sort(),
    ["activeTab", "scripting", "sidePanel", "storage", "unlimitedStorage"].sort()
  );
});

test("loads the structure carrier and isolated handshake around the existing recorder", () => {
  assert.deepEqual(manifest.content_scripts[0].js, [
    "lib/protocol.js",
    "lib/protocol-structure-carrier.js",
    "page-probe.js"
  ]);
  assert.deepEqual(manifest.content_scripts[1].js, [
    "lib/core.js",
    "lib/turn-state.js",
    "content.js",
    "handshake.js"
  ]);
  assert.match(pageProbeSource, /__CHATGPT_UI_STATE_INSPECTOR_STATE__/);
  assert.match(contentSource, /turn_state_transition/);
  assert.match(handshakeSource, /GET_INSPECTOR_HANDSHAKE/);
  assert.match(handshakeSource, /data-ui-state-inspector-carrier/);
});

test("loads the sidepanel UI immediately and verifies readiness by extension messaging", () => {
  assert.equal(manifest.side_panel.default_path, "sidepanel.html");
  assert.match(sidepanelHtml, /<script src="sidepanel\.js"><\/script>/);
  assert.doesNotMatch(sidepanelHtml, /sidepanel-(?:dev7-)?bootstrap\.js/);
  assert.match(sidepanelSource, /EXPECTED_CARRIER_BUILD\s*=\s*"0\.1\.3-dev7"/);
  assert.match(sidepanelSource, /GET_INSPECTOR_HANDSHAKE/);
  assert.doesNotMatch(sidepanelSource, /chrome\.scripting\.executeScript/);
  assert.match(sidepanelSource, /startButton\.addEventListener/);
});

test("does not infer ChatGPT from privileged tab URL properties", () => {
  assert.doesNotMatch(sidepanelSource, /tab\.url/);
  assert.match(sidepanelSource, /probeHandshake/);
  assert.match(sidepanelSource, /probeRecorder/);
  assert.match(sidepanelSource, /chrome\.tabs\.reload/);
  assert.match(contentSource, /__CHATGPT_UI_STATE_INSPECTOR_CONTENT_LOADED__/);
});

test("all manifest files exist", () => {
  const files = [
    manifest.background.service_worker,
    manifest.side_panel.default_path,
    ...manifest.content_scripts.flatMap((script) => script.js)
  ];
  for (const file of files) {
    assert.equal(fs.existsSync(path.join(new URL("../extension/", import.meta.url).pathname, file)), true, file);
  }
});
