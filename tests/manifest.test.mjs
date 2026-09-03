import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const extensionRoot = new URL("../extension/", import.meta.url).pathname;
const manifest = JSON.parse(fs.readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
const sidepanelHtml = fs.readFileSync(new URL("../extension/sidepanel.html", import.meta.url), "utf8");
const sidepanelSource = fs.readFileSync(new URL("../extension/sidepanel.js", import.meta.url), "utf8");
const calibratorSource = fs.readFileSync(new URL("../extension/request-calibrator.js", import.meta.url), "utf8");
const snapshotProbeSource = fs.readFileSync(new URL("../extension/request-snapshot-probe.js", import.meta.url), "utf8");
const snapshotContentSource = fs.readFileSync(new URL("../extension/request-snapshot-content.js", import.meta.url), "utf8");
const backgroundSource = fs.readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const handshakeSource = fs.readFileSync(new URL("../extension/handshake.js", import.meta.url), "utf8");
const carrierSource = fs.readFileSync(new URL("../extension/lib/protocol-structure-carrier.js", import.meta.url), "utf8");
const nativeSource = fs.readFileSync(new URL("../extension/lib/work-native-state.js", import.meta.url), "utf8");
const contentSource = fs.readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");
const pageProbeSource = fs.readFileSync(new URL("../extension/page-probe.js", import.meta.url), "utf8");

test("uses Manifest V3 and one fixed chatgpt.com boundary across both worlds", () => {
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

test("keeps the existing permission set and declares packaged inspector icons", () => {
  assert.deepEqual(
    [...manifest.permissions].sort(),
    ["activeTab", "scripting", "sidePanel", "storage", "unlimitedStorage"].sort()
  );
  assert.deepEqual(manifest.icons, {
    "16": "icons/icon-16.png", "32": "icons/icon-32.png", "48": "icons/icon-48.png", "128": "icons/icon-128.png"
  });
  assert.deepEqual(manifest.action.default_icon, manifest.icons);
});

test("loads persistent automatic request profile capture before the existing turn-state recorder without request switching", () => {
  assert.deepEqual(manifest.content_scripts[0].js, [
    "lib/request-snapshot-core.js",
    "request-snapshot-probe.js",
    "lib/protocol.js",
    "lib/protocol-structure-carrier.js",
    "lib/work-native-state.js",
    "page-probe.js"
  ]);
  assert.deepEqual(manifest.content_scripts[1].js, [
    "lib/core.js",
    "lib/turn-state.js",
    "content.js",
    "handshake.js",
    "request-snapshot-content.js"
  ]);
  assert.match(snapshotProbeSource, /RS_CAPTURED/);
  assert.match(snapshotProbeSource, /RS_SET_CAPTURE_ENABLED/);
  assert.match(snapshotProbeSource, /buildSnapshot/);
  assert.match(snapshotProbeSource, /Reflect\.apply\(originalFetch/);
  assert.match(snapshotContentSource, /chatGptRequestProfileCaptureEnabledV2/);
  assert.match(snapshotContentSource, /SAVE_REQUEST_PROFILE_CAPTURE/);
  assert.match(calibratorSource, /start-request-capture/);
  assert.match(calibratorSource, /SET_REQUEST_PROFILE_CAPTURE_ENABLED/);
  assert.match(backgroundSource, /chatGptRequestProfilesV2/);
  assert.match(backgroundSource, /migrateLegacyRequestProfiles/);
  assert.doesNotMatch(snapshotProbeSource, /RS_ARM_SCENARIO|armedScenarioId/);
  assert.doesNotMatch(calibratorSource, /chatModels|workModels|buildScenarioPlan|armScenario/);
  assert.doesNotMatch(snapshotProbeSource, /SET_CHAT_WORK_SWITCH|prepareSwitchArgs/);
  assert.equal(fs.existsSync(path.join(extensionRoot, "switch-controller.js")), false);
  assert.equal(fs.existsSync(path.join(extensionRoot, "sidepanel-switch.js")), false);
  assert.equal(fs.existsSync(path.join(extensionRoot, "lib/chat-work-switch-core.js")), false);
});

test("retains the validated turn-state and Work protocol classifier chain", () => {
  assert.match(pageProbeSource, /__CHATGPT_UI_STATE_INSPECTOR_STATE__/);
  assert.match(contentSource, /turn_state_transition/);
  assert.match(handshakeSource, /GET_INSPECTOR_HANDSHAKE/);
  assert.match(carrierSource, /DECODER_BUILD = "0\.1\.7-dev11"/);
  assert.match(carrierSource, /ei:codec:sse/);
  assert.match(nativeSource, /BUILD_ID = "0\.1\.8-dev12"/);
  assert.match(nativeSource, /final_channel_token/);
  assert.match(nativeSource, /VISIBLE_ANSWER/);
});

test("side panel exposes automatic request capture and the existing turn-state recorder", () => {
  assert.equal(manifest.side_panel.default_path, "sidepanel.html");
  assert.match(sidepanelHtml, /id="request-calibrator-heading"/);
  assert.match(sidepanelHtml, /id="start-request-capture"/);
  assert.match(sidepanelHtml, /id="stop-request-capture"/);
  assert.match(sidepanelHtml, /id="request-profile-list"/);
  assert.doesNotMatch(sidepanelHtml, /id="chat-models"|id="chat-reasoning"|id="work-models"|id="work-reasoning"|id="generate-scenarios"|id="arm-next"/);
  assert.match(sidepanelHtml, /id="record-heading"/);
  assert.match(sidepanelHtml, /<script src="sidepanel\.js"><\/script>/);
  assert.match(sidepanelHtml, /<script src="request-calibrator\.js"><\/script>/);
  assert.match(sidepanelSource, /EXPECTED_CARRIER_BUILD\s*=\s*"0\.1\.3-dev7"/);
  assert.match(sidepanelSource, /startButton\.addEventListener/);
});

test("all manifest script files exist", () => {
  const files = [manifest.background.service_worker, manifest.side_panel.default_path, ...manifest.content_scripts.flatMap((script) => script.js)];
  for (const file of files) assert.equal(fs.existsSync(path.join(extensionRoot, file)), true, file);
});