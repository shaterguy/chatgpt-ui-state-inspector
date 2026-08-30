import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = path.join(repositoryRoot, "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "manifest.json"), "utf8"));

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.content_scripts.length, 2);
assert.deepEqual(
  [...new Set(manifest.content_scripts.flatMap((item) => item.matches))],
  ["https://chatgpt.com/*"]
);
assert.equal(manifest.host_permissions, undefined);
assert.deepEqual(
  manifest.content_scripts.map((item) => item.world),
  ["MAIN", "ISOLATED"]
);

const required = [
  "manifest.json", "background.js", "content.js", "page-probe.js",
  "sidepanel.html", "sidepanel.css", "sidepanel.js", "lib/core.js",
  "lib/protocol.js", "lib/turn-state.js"
];
for (const file of required) {
  assert.equal(fs.existsSync(path.join(extensionRoot, file)), true, `Missing ${file}`);
}

const forbiddenNames = new Set([
  ".env", ".git", "node_modules", "package-lock.json", "npm-debug.log",
  ".DS_Store", "Thumbs.db"
]);
function walk(directory) {
  return fs.readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    assert.equal(forbiddenNames.has(entry.name), false, `Forbidden package entry: ${entry.name}`);
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
const packagedFiles = walk(extensionRoot);
assert.ok(packagedFiles.length >= required.length);

const javascriptFiles = packagedFiles.filter((file) => file.endsWith(".js"));
const pageProbePath = path.join(extensionRoot, "page-probe.js");
const pageProbe = fs.readFileSync(pageProbePath, "utf8");
const nonProbeJavascript = javascriptFiles
  .filter((file) => file !== pageProbePath)
  .map((file) => fs.readFileSync(file, "utf8"))
  .join("\n");
const allJavascript = javascriptFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");

for (const pattern of [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bEventSource\b/,
  /\bsendBeacon\b/
]) {
  assert.equal(pattern.test(nonProbeJavascript), false, `Network capability outside passive page probe: ${pattern}`);
}
for (const pattern of [/\beval\s*\(/, /new\s+Function\s*\(/]) {
  assert.equal(pattern.test(allJavascript), false, `Forbidden runtime code generation: ${pattern}`);
}
for (const pattern of [
  /\bchrome\s*\./,
  /\bXMLHttpRequest\b/,
  /\bEventSource\b/,
  /\bsendBeacon\b/,
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bindexedDB\b/,
  /document\.cookie/,
  /response\.text\s*\(/,
  /response\.json\s*\(/,
  /request\.headers/,
  /authorization/i
]) {
  assert.equal(pattern.test(pageProbe), false, `Forbidden page-probe capability: ${pattern}`);
}
assert.match(pageProbe, /Reflect\.apply\(nativeFetch/);
assert.match(pageProbe, /new NativeWebSocket/);
assert.match(pageProbe, /response\.clone\(\)/);
assert.match(pageProbe, /__CHATGPT_UI_STATE_INSPECTOR_STATE__/);
assert.match(pageProbe, /chatgpt-ui-state-inspector:phasechange/);

const protocolSource = fs.readFileSync(path.join(extensionRoot, "lib/protocol.js"), "utf8");
assert.doesNotMatch(protocolSource, /parts\s*:\s*parts/);
assert.doesNotMatch(protocolSource, /raw(?:Data|Payload|Body)\s*:/);

console.log(`Validated ${packagedFiles.length} extension files with passive MAIN-world inspection and fixed chatgpt.com scope.`);
