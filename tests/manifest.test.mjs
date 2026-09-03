import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const extensionRoot = new URL("../extension/", import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL("manifest.json", extensionRoot), "utf8"));
const sidepanelHtml = fs.readFileSync(new URL("sidepanel.html", extensionRoot), "utf8");
const sidepanelSource = fs.readFileSync(new URL("sidepanel.js", extensionRoot), "utf8");
const sidepanelSwitch = fs.readFileSync(new URL("sidepanel-switch.js", extensionRoot), "utf8");
const handshakeSource = fs.readFileSync(new URL("handshake.js", extensionRoot), "utf8");
const carrierSource = fs.readFileSync(new URL("lib/protocol-structure-carrier.js", extensionRoot), "utf8");
const nativeSource = fs.readFileSync(new URL("lib/work-native-state.js", extensionRoot), "utf8");
const switchCore = fs.readFileSync(new URL("lib/chat-work-switch-core.js", extensionRoot), "utf8");
const switchController = fs.readFileSync(new URL("switch-controller.js", extensionRoot), "utf8");
const backgroundSource = fs.readFileSync(new URL("background.js", extensionRoot), "utf8");
const contentSource = fs.readFileSync(new URL("content.js", extensionRoot), "utf8");
const pageProbeSource = fs.readFileSync(new URL("page-probe.js", extensionRoot), "utf8");
const expectedIcons = {
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
  "128": "icons/icon-128.png"
};

test("uses Manifest V3 and a single fixed host boundary across both worlds", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "0.2.0");
  assert.match(manifest.version_name, /0\.2\.0-dev2/);
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

test("reasserts the canonical side panel configuration whenever the service worker starts", () => {
  assert.match(backgroundSource, /async function ensureSidePanelReady\(\)/);
  assert.match(backgroundSource, /chrome\.sidePanel\.setOptions\(\{path: "sidepanel\.html", enabled: true\}\)/);
  assert.match(backgroundSource, /chrome\.sidePanel\.setPanelBehavior\(\{openPanelOnActionClick: true\}\)/);
  assert.match(backgroundSource, /chrome\.runtime\.onInstalled\.addListener\(initializeExtensionUi\)/);
  assert.match(backgroundSource, /chrome\.runtime\.onStartup\.addListener\(initializeExtensionUi\)/);
  assert.match(backgroundSource, /initializeExtensionUi\(\);/);
});

test("declares packaged PNG icons and retains the dynamic toolbar refresh", () => {
  assert.deepEqual(manifest.icons, expectedIcons);
  assert.deepEqual(manifest.action.default_icon, expectedIcons);
  for (const [sizeText, file] of Object.entries(expectedIcons)) {
    const size = Number(sizeText);
    const icon = fs.readFileSync(new URL(file, extensionRoot));
    assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], file);
    assert.equal(icon.readUInt32BE(16), size, `${file} width`);
    assert.equal(icon.readUInt32BE(20), size, `${file} height`);
  }
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
    ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap((script) => script.js)
  ];
  for (const file of files) {
    assert.equal(fs.existsSync(path.join(extensionRoot.pathname, file)), true, file);
  }
});
