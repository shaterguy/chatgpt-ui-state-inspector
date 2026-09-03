import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = path.join(repositoryRoot, "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "manifest.json"), "utf8"));
const expectedIcons = {
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
  "128": "icons/icon-128.png"
};

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, "0.2.0");
assert.match(manifest.version_name, /0\.2\.0-dev3-request-snapshot-plus-turn-state/);
assert.equal(manifest.content_scripts.length, 2);
assert.deepEqual([...new Set(manifest.content_scripts.flatMap((item) => item.matches))], ["https://chatgpt.com/*"]);
assert.equal(manifest.host_permissions, undefined);
assert.deepEqual(manifest.content_scripts.map((item) => item.world), ["MAIN", "ISOLATED"]);
assert.deepEqual([...manifest.permissions].sort(), ["activeTab", "scripting", "sidePanel", "storage", "unlimitedStorage"].sort());
assert.deepEqual(manifest.icons, expectedIcons);
assert.deepEqual(manifest.action.default_icon, expectedIcons);

const required = [
  "manifest.json", "background.js", "content.js", "handshake.js", "page-probe.js",
  "request-snapshot-probe.js", "request-snapshot-content.js", "request-calibrator.js", "request-calibrator.css",
  "sidepanel.html", "sidepanel.css", "sidepanel.js", "lib/core.js", "lib/protocol.js", "lib/turn-state.js",
  "lib/protocol-structure-carrier.js", "lib/work-native-state.js", "lib/request-snapshot-core.js",
  ...Object.values(expectedIcons)
];
for (const file of required) assert.equal(fs.existsSync(path.join(extensionRoot, file)), true, `Missing ${file}`);
for (const forbidden of ["switch-controller.js", "sidepanel-switch.js", "lib/chat-work-switch-core.js"]) {
  assert.equal(fs.existsSync(path.join(extensionRoot, forbidden)), false, `Unexpected request-switching file: ${forbidden}`);
}
for (const [sizeText, file] of Object.entries(expectedIcons)) {
  const size = Number(sizeText);
  const icon = fs.readFileSync(path.join(extensionRoot, file));
  assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `Invalid PNG signature: ${file}`);
  assert.equal(icon.readUInt32BE(16), size, `Unexpected icon width: ${file}`);
  assert.equal(icon.readUInt32BE(20), size, `Unexpected icon height: ${file}`);
}

const forbiddenNames = new Set([".env", ".git", "node_modules", "package-lock.json", "npm-debug.log", ".DS_Store", "Thumbs.db"]);
function walk(directory) {
  return fs.readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    assert.equal(forbiddenNames.has(entry.name), false, `Forbidden package entry: ${entry.name}`);
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
const packagedFiles = walk(extensionRoot);

const javascriptFiles = packagedFiles.filter((file) => file.endsWith(".js"));
const pageProbePath = path.join(extensionRoot, "page-probe.js");
const snapshotProbePath = path.join(extensionRoot, "request-snapshot-probe.js");
const pageProbe = fs.readFileSync(pageProbePath, "utf8");
const snapshotProbe = fs.readFileSync(snapshotProbePath, "utf8");
const snapshotCore = fs.readFileSync(path.join(extensionRoot, "lib/request-snapshot-core.js"), "utf8");
const nonProbeJavascript = javascriptFiles
  .filter((file) => file !== pageProbePath && file !== snapshotProbePath)
  .map((file) => fs.readFileSync(file, "utf8"))
  .join("\n");
const allJavascript = javascriptFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");

for (const pattern of [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bEventSource\b/, /\bsendBeacon\b/]) {
  assert.equal(pattern.test(nonProbeJavascript), false, `Network capability outside approved passive MAIN-world probes: ${pattern}`);
}
for (const pattern of [/\beval\s*\(/, /new\s+Function\s*\(/]) {
  assert.equal(pattern.test(allJavascript), false, `Forbidden runtime code generation: ${pattern}`);
}
for (const pattern of [/\bchrome\s*\./, /\bXMLHttpRequest\b/, /\bEventSource\b/, /\bsendBeacon\b/, /\blocalStorage\b/, /\bsessionStorage\b/, /\bindexedDB\b/, /document\.cookie/, /response\.text\s*\(/, /response\.json\s*\(/, /request\.headers/, /authorization/i]) {
  assert.equal(pattern.test(pageProbe), false, `Forbidden turn-state page-probe capability: ${pattern}`);
}
for (const pattern of [/\bchrome\s*\./, /\bWebSocket\b/, /\bEventSource\b/, /\bsendBeacon\b/, /\blocalStorage\b/, /\bsessionStorage\b/, /\bindexedDB\b/, /document\.cookie/, /request\.headers/, /authorization/i]) {
  assert.equal(pattern.test(snapshotProbe), false, `Forbidden request-snapshot probe capability: ${pattern}`);
}
assert.match(pageProbe, /Reflect\.apply\(nativeFetch/);
assert.match(pageProbe, /new NativeWebSocket/);
assert.match(pageProbe, /response\.clone\(\)/);
assert.match(snapshotProbe, /Reflect\.apply\(originalFetch/);
assert.match(snapshotProbe, /Reflect\.apply\(originalSend/);
assert.match(snapshotProbe, /buildSnapshot/);
assert.match(snapshotProbe, /armedScenarioId = null/);
assert.doesNotMatch(snapshotProbe, /SET_CHAT_WORK_SWITCH|prepareSwitchArgs|thinking_effort\s*=|body\.model\s*=/);
assert.match(snapshotCore, /BLOCKED_KEYS/);
assert.match(snapshotCore, /collectLeaves/);
assert.match(snapshotCore, /buildScenarioPlan/);
assert.match(snapshotCore, /diffSnapshots/);

const protocolSource = fs.readFileSync(path.join(extensionRoot, "lib/protocol.js"), "utf8");
assert.doesNotMatch(protocolSource, /parts\s*:\s*parts/);
assert.doesNotMatch(protocolSource, /raw(?:Data|Payload|Body)\s*:/);

console.log(`Validated ${packagedFiles.length} extension files with passive request snapshots, turn-state recording, no request switching, packaged icons, and fixed chatgpt.com scope.`);