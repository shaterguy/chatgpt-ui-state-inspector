import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = path.join(repositoryRoot, "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "manifest.json"), "utf8"));

assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.content_scripts.flatMap((item) => item.matches), ["https://chatgpt.com/*"]);
assert.equal(manifest.host_permissions, undefined);

const required = [
  "manifest.json", "background.js", "content.js", "sidepanel.html",
  "sidepanel.css", "sidepanel.js", "lib/core.js"
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

const javascript = packagedFiles
  .filter((file) => file.endsWith(".js"))
  .map((file) => fs.readFileSync(file, "utf8"))
  .join("\n");
for (const pattern of [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bsendBeacon\b/,
  /\beval\s*\(/,
  /new\s+Function\s*\(/
]) {
  assert.equal(pattern.test(javascript), false, `Forbidden runtime capability: ${pattern}`);
}

console.log(`Validated ${packagedFiles.length} extension files with fixed chatgpt.com scope.`);
