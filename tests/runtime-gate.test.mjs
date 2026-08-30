import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../extension/sidepanel-dev7.html", import.meta.url), "utf8");
const bootstrap = fs.readFileSync(new URL("../extension/sidepanel-dev7-bootstrap.js", import.meta.url), "utf8");
const manifest = JSON.parse(fs.readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));

test("dev7 sidepanel gates startup on the current structure carrier build", () => {
  assert.equal(manifest.version, "0.1.3");
  assert.match(manifest.version_name, /dev7-structure-carrier/);
  assert.equal(manifest.side_panel.default_path, "sidepanel-dev7.html");
  assert.match(html, /sidepanel-dev7-bootstrap\.js/);
  assert.doesNotMatch(html, /<script src="sidepanel\.js"><\/script>/);
  assert.match(bootstrap, /EXPECTED_CARRIER_BUILD = "0\.1\.3-dev7"/);
  assert.match(bootstrap, /world:\s*"MAIN"/);
  assert.match(bootstrap, /__CHATGPT_UI_STATE_INSPECTOR_STRUCTURE_CARRIER__/);
  assert.match(bootstrap, /chrome\.tabs\.reload/);
  assert.match(bootstrap, /finally\(loadSidepanel\)/);
});
