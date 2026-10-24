// Builds a Firefox-only copy of the extension in dist/firefox. Optional:
// manifest.json already loads in Firefox through `background.scripts`. This
// copy drops what Firefox doesn't use (the `service_worker` key and the
// `offscreen` permission and page, which only warn there), e.g. for packaging.
//
// Usage: node build-firefox.js, then load dist/firefox/manifest.json in Firefox.
"use strict";
const fs = require("fs");
const path = require("path");

const root = __dirname;
const out = path.join(root, "dist", "firefox");
const SKIP = new Set([
  ".git", ".claude", ".gitignore", "dist", "build-firefox.js", "PLAN.md", "README.md",
  "setup.sh", "setup.ps1", "setup.bat", "offscreen.html", "offscreen.js",
]);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const name of fs.readdirSync(root)) {
  if (!SKIP.has(name)) fs.cpSync(path.join(root, name), path.join(out, name), { recursive: true });
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
// Same files, in the same order, as background.js's importScripts.
manifest.background = { scripts: ["spooks.js", "modules/prompts.js", "background.js"] };
// Chrome plays the jump-scare sound from an offscreen page; Firefox plays it in the background page.
manifest.permissions = manifest.permissions.filter((p) => p !== "offscreen");
fs.writeFileSync(path.join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Firefox build written to ${path.relative(root, out)}`);
