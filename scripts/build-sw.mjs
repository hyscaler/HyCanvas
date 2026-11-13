// Stamps the exported service worker (frontend/out/sw.js) with this build's id
// and its precache list. Runs after every production frontend build
// (postbuild / postbuild:dist in frontend/package.json), so it covers both
// scripts/build-dist.js and the Docker image, which builds the frontend itself.
//
// The build id is what versions the worker's caches, and it is also what makes
// the worker's bytes differ between two binaries: the browser only installs an
// updated worker when sw.js changes, so an unstamped or identical file would
// leave a self-hoster's users on the previous build's shell after an upgrade.
//
// The precache list is the offline page, the icons, and every hashed
// /_next/static file the main pages reference in their HTML. Lazily loaded
// chunks are cached at runtime the first time they are requested.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(here, "../frontend");
const OUT = join(FRONTEND, "out");
const SW = join(OUT, "sw.js");
const MARKER = "/*__HC_BUILD__*/ null";

// Pages whose chunks make up the shell a returning user needs first.
const SHELL_PAGES = ["index.html", "login/index.html", "dashboard/index.html", "editor/index.html", "404.html"];
// Static files precached as is (only the ones present in the export).
const STATIC_FILES = [
  "/offline.html",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/favicon-32.png",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-192.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
  "/badge-72.png",
];

function fail(message) {
  console.error(`[build-sw] ${message}`);
  process.exit(1);
}

if (!existsSync(SW)) fail(`${SW} not found; run the static export first`);
const source = readFileSync(SW, "utf8");
if (!source.includes(MARKER)) fail(`build marker ${MARKER} missing from ${SW} (already stamped?)`);

const assets = new Set();
for (const page of SHELL_PAGES) {
  const file = join(OUT, page);
  if (!existsSync(file)) continue;
  const html = readFileSync(file, "utf8");
  for (const m of html.matchAll(/(?:src|href)="(\/_next\/static\/[^"?#]+)"/g)) assets.add(m[1]);
}
for (const url of assets) {
  if (!existsSync(join(OUT, url))) fail(`page references ${url}, which is not in the export`);
}
const precache = [...STATIC_FILES.filter((url) => existsSync(join(OUT, url))), ...[...assets].sort()];

// Next's build id is unique per build. Hash it together with the precache list
// so the id also changes if the same build id ever ships different assets.
const nextBuildId = existsSync(join(FRONTEND, ".next", "BUILD_ID"))
  ? readFileSync(join(FRONTEND, ".next", "BUILD_ID"), "utf8").trim()
  : String(Date.now());
const id = createHash("sha256").update(nextBuildId).update(JSON.stringify(precache)).digest("hex").slice(0, 16);

writeFileSync(SW, source.replace(MARKER, JSON.stringify({ id, precache })));
console.log(`[build-sw] stamped sw.js with build ${id} (${precache.length} precached files)`);
