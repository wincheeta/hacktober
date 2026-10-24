// Builds a Firefox-only copy of the extension in dist/firefox. Optional:
// manifest.json already loads in Firefox through `background.scripts`. This
// copy drops the `service_worker` key Firefox doesn't use, e.g. for packaging.
//
// Usage: node build-firefox.js, then load dist/firefox/manifest.json in Firefox.
"use strict";
const fs = require("fs");
const path = require("path");

const root = __dirname;
const out = path.join(root, "dist", "firefox");
const SKIP = new Set([".git", "dist", "build-firefox.js", "PLAN.md", "README.md"]);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const name of fs.readdirSync(root)) {
  if (!SKIP.has(name)) fs.cpSync(path.join(root, name), path.join(out, name), { recursive: true });
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
// Same files, in the same order, as background.js's importScripts.
manifest.background = { scripts: ["spooks.js", "modules/prompts.js", "background.js"] };
fs.writeFileSync(path.join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Firefox build written to ${path.relative(root, out)}`);
