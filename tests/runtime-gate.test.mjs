import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../extension/sidepanel.html", import.meta.url), "utf8");
const sidepanel = fs.readFileSync(new URL("../extension/sidepanel.js", import.meta.url), "utf8");
const calibrator = fs.readFileSync(new URL("../extension/request-calibrator.js", import.meta.url), "utf8");
const calibratorCss = fs.readFileSync(new URL("../extension/request-calibrator.css", import.meta.url), "utf8");
const snapshotCore = fs.readFileSync(new URL("../extension/lib/request-snapshot-core.js", import.meta.url), "utf8");
const snapshotProbe = fs.readFileSync(new URL("../extension/request-snapshot-probe.js", import.meta.url), "utf8");
const snapshotContent = fs.readFileSync(new URL("../extension/request-snapshot-content.js", import.meta.url), "utf8");
const background = fs.readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const handshake = fs.readFileSync(new URL("../extension/handshake.js", import.meta.url), "utf8");
const manifest = JSON.parse(fs.readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));

test("dev5 keeps persistent capture while adding readable profile labels and theme-safe request cards", () => {
  assert.equal(manifest.version, "0.2.0");
  assert.match(manifest.version_name, /0\.2\.0-dev5-readable-profile-labels/);
  assert.equal(manifest.side_panel.default_path, "sidepanel.html");
  assert.match(html, /API 요청 프로필 캡처/);
  assert.match(html, /id="start-request-capture"/);
  assert.match(html, /id="stop-request-capture"/);
  assert.doesNotMatch(html, /id="generate-scenarios"|id="arm-next"|id="scenario-list"|id="chat-models"|id="work-models"/);
  assert.match(html, /대화 상태 연속 기록/);
  assert.match(sidepanel, /EXPECTED_CARRIER_BUILD = "0\.1\.3-dev7"/);
  assert.match(sidepanel, /CARRIER_WAIT_MS = 8000/);
  assert.match(sidepanel, /GET_INSPECTOR_HANDSHAKE/);
  assert.doesNotMatch(sidepanel, /chrome\.scripting\.executeScript/);

  assert.match(calibrator, /GET_REQUEST_PROFILE_STATE/);
  assert.match(calibrator, /SET_REQUEST_PROFILE_CAPTURE_ENABLED/);
  assert.match(calibrator, /RESET_REQUEST_PROFILES/);
  assert.match(calibrator, /chatgpt-request-profile-capture-v2/);
  assert.match(calibrator, /displayName: core\.userVisibleProfileName/);
  assert.match(calibrator, /internalCombination: core\.internalProfileLabel/);
  assert.match(calibrator, /내부 조합:/);
  assert.doesNotMatch(calibrator, /buildScenarioPlan|RS_ARM_SCENARIO|armScenario|nextMissingScenario/);
  assert.match(snapshotCore, /userVisibleProfileName/);
  assert.match(snapshotCore, /internalProfileLabel/);
  assert.match(snapshotCore, /매우 높음/);
  assert.match(calibratorCss, /background:var\(--card\)/);
  assert.match(calibratorCss, /color:var\(--text\)/);
  assert.doesNotMatch(calibratorCss, /background:#0d1719|background:#091113/);

  assert.match(snapshotProbe, /captureEnabled/);
  assert.match(snapshotProbe, /RS_SET_CAPTURE_ENABLED/);
  assert.match(snapshotProbe, /RS_CAPTURED/);
  assert.doesNotMatch(snapshotProbe, /armedScenarioId|RS_ARM_SCENARIO|RS_DISARM/);
  assert.doesNotMatch(snapshotProbe, /thinking_effort\s*=|model\s*=/);
  assert.doesNotMatch(snapshotProbe, /SET_CHAT_WORK_SWITCH|DISABLE_CHAT_WORK_SWITCH|prepareSwitchArgs/);

  assert.match(snapshotContent, /chatGptRequestProfileCaptureEnabledV2/);
  assert.match(snapshotContent, /SAVE_REQUEST_PROFILE_CAPTURE/);
  assert.match(snapshotContent, /chrome\.storage\.onChanged/);
  assert.doesNotMatch(snapshotContent, /slice\(-250\)|MAX_PER_SCENARIO|RS_DISARM/);

  assert.match(background, /chatGptRequestProfilesV2/);
  assert.match(background, /migrateLegacyRequestProfiles/);
  assert.match(background, /SAVE_REQUEST_PROFILE_CAPTURE/);
  assert.match(background, /queueWrite/);
  assert.match(background, /profiles\.some\(\(item\) => item\?\.profileKey === profileKey\)/);
  assert.doesNotMatch(background, /slice\(-250\)|MAX_PER_SCENARIO/);
  assert.match(handshake, /EXPECTED_DECODER_BUILD = "0\.1\.8-dev12"/);
  assert.match(background, /setOptions\(\{path: "sidepanel\.html", enabled: true\}\)/);
  assert.match(background, /setPanelBehavior\(\{openPanelOnActionClick: true\}\)/);
});