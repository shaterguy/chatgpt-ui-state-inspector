import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../extension/sidepanel.html", import.meta.url), "utf8");
const sidepanel = fs.readFileSync(new URL("../extension/sidepanel.js", import.meta.url), "utf8");
const manifest = JSON.parse(fs.readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));

test("dev9 sidepanel uses bounded message handshake without executeScript", () => {
  assert.equal(manifest.version, "0.1.5");
  assert.match(manifest.version_name, /dev9-message-handshake/);
  assert.equal(manifest.side_panel.default_path, "sidepanel.html");
  assert.match(html, /<script src="sidepanel\.js"><\/script>/);
  assert.match(sidepanel, /EXPECTED_CARRIER_BUILD = "0\.1\.3-dev7"/);
  assert.match(sidepanel, /CARRIER_WAIT_MS = 8000/);
  assert.match(sidepanel, /SCRIPT_CALL_TIMEOUT_MS = 1200/);
  assert.match(sidepanel, /GET_INSPECTOR_HANDSHAKE/);
  assert.match(sidepanel, /chrome\.tabs\.reload/);
  assert.match(sidepanel, /waitForCarrier/);
  assert.match(sidepanel, /preparationActive/);
  assert.doesNotMatch(sidepanel, /chrome\.scripting\.executeScript/);
  assert.doesNotMatch(sidepanel, /활성 탭이 https:\/\/chatgpt\.com인지 확인해 주세요/);
});
