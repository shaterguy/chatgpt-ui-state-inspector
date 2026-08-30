import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../extension/sidepanel.html", import.meta.url), "utf8");
const bootstrap = fs.readFileSync(new URL("../extension/sidepanel-bootstrap.js", import.meta.url), "utf8");
const manifest = JSON.parse(fs.readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));

test("dev6 sidepanel gates startup on the current MAIN-world parser build", () => {
  assert.equal(manifest.version, "0.1.2");
  assert.match(manifest.version_name, /dev6-runtime-upgrade-gate/);
  assert.match(html, /sidepanel-bootstrap\.js/);
  assert.doesNotMatch(html, /<script src="sidepanel\.js"><\/script>/);
  assert.match(bootstrap, /EXPECTED_PARSER_BUILD_ID = "0\.1\.1-dev5"/);
  assert.match(bootstrap, /world:\s*"MAIN"/);
  assert.match(bootstrap, /UiStateInspectorProtocol/);
  assert.match(bootstrap, /chrome\.tabs\.reload/);
  assert.match(bootstrap, /finally\(loadSidepanel\)/);
});
