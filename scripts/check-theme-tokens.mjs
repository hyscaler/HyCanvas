// Theme drift / enforcement check (advisory + one hard rule). Run via
// `npm run lint:theme`.
//
// 1. HARD: the engine asset-state colors are mirrored (not imported) in
//    packages/engine/src/render2d.ts to keep the engine dependency-free. This
//    verifies render2d.ts still matches the canonical values in theme.config.mjs,
//    so the two cannot silently drift.
// 2. ADVISORY: report raw blue/indigo/sky/cyan accent utility classes left in
//    frontend components (they should usually be brand/accent tokens). This does
//    NOT fail the build; it is a nudge, with a curated allowlist of files where
//    such colors are legitimately categorical/semantic.

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, relative } from "node:path";
import { theme } from "../frontend/src/theme.config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const RENDER2D = resolve(ROOT, "packages/engine/src/render2d.ts");
const SRC = resolve(ROOT, "frontend/src");

// Files where raw categorical/semantic palette colors are expected (not brand).
const ALLOW = [
  "components/editor/VideoSurface.tsx", // per-track KIND_COLOR map
  "components/editor/ColorField.tsx", // rainbow hue slider
  "lib/theme.generated.ts", // generated
  "components/editor/PublishDialog.tsx", // STATUS_COLOR: one hue per post state
  "components/dashboard/DashboardApp.tsx", // one hue per task state
  // The remaining hit is the selection-range fill in the grid. theme.config.mjs
  // keeps selection a cool hue DISTINCT from the accent on purpose, so that one
  // must not become a brand token; the chips and focus rings here already did.
  "components/editor/SheetSurface.tsx",
];

let hardFail = false;

// 1. Engine mirror check (hard).
const render2d = await readFile(RENDER2D, "utf8");
const missing = Object.entries(theme.engine).filter(([, v]) => !render2d.includes(v));
if (missing.length) {
  hardFail = true;
  console.error("check-theme-tokens: render2d.ts has drifted from theme.config.mjs `engine`:");
  for (const [k, v] of missing) console.error(`  missing ${k}: ${v}`);
  console.error("  Update packages/engine/src/render2d.ts to match, or update theme.config.mjs.");
} else {
  console.log("check-theme-tokens: engine asset-state colors match theme.config.mjs.");
}

// 2. Stray accent classes (advisory).
const ACCENT = /\b(?:bg|text|border|ring|from|to|via|fill|stroke|decoration|outline|shadow)-(?:blue|indigo|sky|cyan)-\d{2,3}\b/g;

async function walk(dir) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(p)));
    else if (/\.(tsx|ts)$/.test(ent.name)) out.push(p);
  }
  return out;
}

const files = await walk(SRC);
let strayTotal = 0;
const offenders = [];
for (const f of files) {
  const rel = relative(SRC, f);
  if (ALLOW.some((a) => rel === a)) continue;
  const text = await readFile(f, "utf8");
  const hits = text.match(ACCENT);
  if (hits && hits.length) {
    strayTotal += hits.length;
    offenders.push(`  ${rel}: ${hits.length} (${[...new Set(hits)].slice(0, 4).join(", ")})`);
  }
}
if (strayTotal) {
  console.warn(`check-theme-tokens: ${strayTotal} raw blue/indigo/sky/cyan accent class(es) found (advisory, prefer brand/accent tokens):`);
  for (const o of offenders) console.warn(o);
} else {
  console.log("check-theme-tokens: no stray raw accent classes.");
}

process.exit(hardFail ? 1 : 0);
