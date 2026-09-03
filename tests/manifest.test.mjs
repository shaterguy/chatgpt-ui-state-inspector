import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const manifest = JSON.parse(fs.readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
const sidepanelHtml = fs.readFileSync(new URL("../extension/sidepanel.html", import.meta.url), "utf8");
const sidepanelSource = fs.readFileSync(new URL("../extension/sidepanel.js", import.meta.url), "utf8");
const sidepanelSwitch = fs.readFileSync(new URL("../extension/sidepanel-switch.js", import.meta.url), "utf8");
const handshakeSource = fs.readFileSync(new URL("../extension/handshake.js", import.meta.url), "utf8");
const carrierSource = fs.readFileSync(new URL("../extension/lib/protocol-structure-carrier.js", import.meta.url), "utf8");
const nativeSource = fs.readFileSync(new URL("../extension/lib/work-native-state.js", import.meta.url), "utf8");
const switchCore = fs.readFileSync(new URL("../extension/lib/chat-work-switch-core.js", import.meta.url), "utf8");
const switchController = fs.readFileSync(new URL("../extension/switch-controller.js", import.meta.url), "utf8");
const backgroundSource = fs.readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const contentSource = fs.readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");
const pageProbeSource = fs.readFileSync(new URL("../extension/page-probe.js", import.meta.url), "utf8");

test("uses Manifest V3 and a single fixed host boundary across both worlds", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "0.2.0");
  assert.match(manifest.version_name, /0\.2\.0-dev1/);
  assert.equal(manifest.content_scripts.length, 2);
  for (const contentScript of manifest.content_scripts) {
    assert.deepEqual(contentScript.matches, ["https://chatgpt.com/*"]);
    assert.equal(contentScript.run_at, "document_start");
  }
  assert.equal(manifest.content_scripts[0].world, "MAIN");
  assert.equal(manifest.content_scripts[1].world, "ISOLATED");
  assert.equal(manifest.host_permissions, undefined);
});

test("keeps the existing permission set", () => {
  assert.deepEqual(
    [...manifest.permissions].sort(),
    ["activeTab", "scripting", "sidePanel", "storage", "unlimitedStorage"].sort()
  );
});

test("loads the switch core inside the existing MAIN probe chain without a second network wrapper", () => {
  assert.deepEqual(manifest.content_scripts[0].js, [
    "lib/protocol.js",
    "lib/protocol-structure-carrier.js",
    "lib/work-native-state.js",
    "lib/chat-work-switch-core.js",
    "page-probe.js"
  ]);
  assert.deepEqual(manifest.content_scripts[1].js, [
    "lib/core.js",
    "lib/turn-state.js",
    "content.js",
    "switch-controller.js",
    "handshake.js"
  ]);
  assert.match(switchCore, /BUILD_ID = "0\.2\.0-dev1"/);
  assert.match(pageProbeSource, /UiStateInspectorChatWorkSwitchCore/);
  assert.match(pageProbeSource, /prepareSwitchArgs/);
  assert.match(pageProbeSource, /Reflect\.apply\(nativeFetch/);
  assert.doesNotMatch(switchController, /\bfetch\s*\(/);
  assert.doesNotMatch(switchController, /\bXMLHttpRequest\b/);
});

test("retains the recorder and Work protocol classifiers", () => {
  assert.match(pageProbeSource, /__CHATGPT_UI_STATE_INSPECTOR_STATE__/);
  assert.match(contentSource, /turn_state_transition/);
  assert.match(handshakeSource, /GET_INSPECTOR_HANDSHAKE/);
  assert.match(carrierSource, /DECODER_BUILD = "0\.1\.7-dev11"/);
  assert.match(nativeSource, /BUILD_ID = "0\.1\.8-dev12"/);
  assert.match(nativeSource, /final_channel_token/);
  assert.match(nativeSource, /VISIBLE_ANSWER/);
});

test("integrates switching controls into the existing side panel", () => {
  assert.equal(manifest.side_panel.default_path, "sidepanel.html");
  assert.match(sidepanelHtml, /id="switch-chat"/);
  assert.match(sidepanelHtml, /id="switch-work"/);
  assert.match(sidepanelHtml, /<script src="sidepanel\.js"><\/script>/);
  assert.match(sidepanelHtml, /<script src="sidepanel-switch\.js"><\/script>/);
  assert.match(sidepanelSwitch, /SET_CHAT_WORK_SWITCH/);
  assert.match(sidepanelSwitch, /GET_CHAT_WORK_SWITCH_STATUS/);
  assert.match(sidepanelSource, /EXPECTED_CARRIER_BUILD\s*=\s*"0\.1\.3-dev7"/);
  assert.doesNotMatch(sidepanelSource, /chrome\.scripting\.executeScript/);
});

test("provides a programmatically generated toolbar icon in the service worker", () => {
  assert.match(backgroundSource, /new OffscreenCanvas/);
  assert.match(backgroundSource, /chrome\.action\.setIcon/);
  assert.match(backgroundSource, /\[16, 32, 48, 128\]/);
});

test("all manifest and side-panel files exist", () => {
  const files = [
    manifest.background.service_worker,
    manifest.side_panel.default_path,
    "sidepanel.css",
    "sidepanel.js",
    "sidepanel-switch.js",
    ...manifest.content_scripts.flatMap((script) => script.js)
  ];
  for (const file of files) {
    assert.equal(fs.existsSync(path.join(new URL("../extension/", import.meta.url).pathname, file)), true, file);
  }
});
