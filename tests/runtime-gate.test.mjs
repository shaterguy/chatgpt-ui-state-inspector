import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../extension/sidepanel.html", import.meta.url), "utf8");
const sidepanel = fs.readFileSync(new URL("../extension/sidepanel.js", import.meta.url), "utf8");
const sidepanelSwitch = fs.readFileSync(new URL("../extension/sidepanel-switch.js", import.meta.url), "utf8");
const handshake = fs.readFileSync(new URL("../extension/handshake.js", import.meta.url), "utf8");
const manifest = JSON.parse(fs.readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));

test("integrated sidepanel retains the bounded recorder handshake and adds switch messaging without executeScript", () => {
  assert.equal(manifest.version, "0.2.0");
  assert.match(manifest.version_name, /0\.2\.0-dev2-sidepanel-self-heal/);
  assert.equal(manifest.side_panel.default_path, "sidepanel.html");
  assert.match(html, /<script src="sidepanel\.js"><\/script>/);
  assert.match(html, /<script src="sidepanel-switch\.js"><\/script>/);
  assert.match(sidepanel, /EXPECTED_CARRIER_BUILD = "0\.1\.3-dev7"/);
  assert.match(sidepanel, /CARRIER_WAIT_MS = 8000/);
  assert.match(sidepanel, /SCRIPT_CALL_TIMEOUT_MS = 1200/);
  assert.match(sidepanel, /GET_INSPECTOR_HANDSHAKE/);
  assert.match(sidepanel, /chrome\.tabs\.reload/);
  assert.match(sidepanel, /waitForCarrier/);
  assert.match(sidepanel, /preparationActive/);
  assert.doesNotMatch(sidepanel, /chrome\.scripting\.executeScript/);
  assert.match(sidepanelSwitch, /SET_CHAT_WORK_SWITCH/);
  assert.match(sidepanelSwitch, /DISABLE_CHAT_WORK_SWITCH/);
  assert.doesNotMatch(sidepanelSwitch, /chrome\.scripting\.executeScript/);
  assert.match(handshake, /EXPECTED_DECODER_BUILD = "0\.1\.8-dev12"/);
  assert.match(handshake, /data-ui-state-inspector-decoder/);
  assert.match(handshake, /decoderBuild === EXPECTED_DECODER_BUILD/);
});
