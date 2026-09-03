import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../extension/sidepanel.html", import.meta.url), "utf8");
const sidepanel = fs.readFileSync(new URL("../extension/sidepanel.js", import.meta.url), "utf8");
const calibrator = fs.readFileSync(new URL("../extension/request-calibrator.js", import.meta.url), "utf8");
const snapshotProbe = fs.readFileSync(new URL("../extension/request-snapshot-probe.js", import.meta.url), "utf8");
const handshake = fs.readFileSync(new URL("../extension/handshake.js", import.meta.url), "utf8");
const background = fs.readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const manifest = JSON.parse(fs.readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));

test("dev3 sidepanel keeps state recorder and request snapshot calibrator without switching requests", () => {
  assert.equal(manifest.version, "0.2.0");
  assert.match(manifest.version_name, /0\.2\.0-dev3-request-snapshot-plus-turn-state/);
  assert.equal(manifest.side_panel.default_path, "sidepanel.html");
  assert.match(html, /API 요청 프로필 캡처/);
  assert.match(html, /대화 상태 연속 기록/);
  assert.match(sidepanel, /EXPECTED_CARRIER_BUILD = "0\.1\.3-dev7"/);
  assert.match(sidepanel, /CARRIER_WAIT_MS = 8000/);
  assert.match(sidepanel, /GET_INSPECTOR_HANDSHAKE/);
  assert.doesNotMatch(sidepanel, /chrome\.scripting\.executeScript/);
  assert.match(calibrator, /buildScenarioPlan/);
  assert.match(calibrator, /buildAnalysis/);
  assert.match(snapshotProbe, /armedScenarioId/);
  assert.match(snapshotProbe, /RS_CAPTURED/);
  assert.doesNotMatch(snapshotProbe, /thinking_effort\s*=|model\s*=/);
  assert.doesNotMatch(snapshotProbe, /SET_CHAT_WORK_SWITCH|DISABLE_CHAT_WORK_SWITCH|prepareSwitchArgs/);
  assert.match(handshake, /EXPECTED_DECODER_BUILD = "0\.1\.8-dev12"/);
  assert.match(background, /setOptions\(\{path: "sidepanel\.html", enabled: true\}\)/);
  assert.match(background, /setPanelBehavior\(\{openPanelOnActionClick: true\}\)/);
});