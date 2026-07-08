// Theme generator: turns the single source (frontend/src/theme.config.mjs) into
// every generated color artifact, so colors are changed in ONE place:
//   1. frontend/src/styles/globals.css   (Tailwind @theme + :root token regions)
//   2. frontend/src/lib/theme.generated.ts (typed constants for canvas overlays)
//   3. backend/internal/realtime/presence_palette_gen.go (Go presence palette)
//
// Run via `npm run gen:theme`; the frontend `prebuild`/`prebuild:dist` hooks run
// it before `next build`. Pass --check to verify the on-disk files already match
// (no write); exits 1 if any is stale, so CI can ensure generated output is
// committed and in sync. Paths resolve relative to THIS file, so cwd is moot.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { theme } from "../frontend/src/theme.config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const GLOBALS = resolve(here, "../frontend/src/styles/globals.css");
const TS_OUT = resolve(here, "../frontend/src/lib/theme.generated.ts");
const GO_OUT = resolve(here, "../backend/internal/realtime/presence_palette_gen.go");
const GO_BRAND_OUT = resolve(here, "../backend/internal/platform/brand/brand_gen.go");

const check = process.argv.includes("--check");

// --- globals.css: replace only the text between marker pairs ----------------

const COLORS_START = "/* THEME:colors:start (generated from src/theme.config.mjs - do not edit by hand) */";
const COLORS_END = "/* THEME:colors:end */";
const ROOT_START = "/* THEME:root:start (generated from src/theme.config.mjs - do not edit by hand) */";
const ROOT_END = "/* THEME:root:end */";
const DARK_START = "/* THEME:dark:start (generated from src/theme.config.mjs - do not edit by hand) */";
const DARK_END = "/* THEME:dark:end */";

function scaleVars(prefix, scale, indent = "  ") {
  return Object.keys(scale)
    .map((step) => `${indent}--color-${prefix}-${step}: ${scale[step]};`)
    .join("\n");
}

function colorsRegion() {
  return [
    COLORS_START,
    scaleVars("brand", theme.brand),
    "",
    scaleVars("accent", theme.accent),
    "",
    "  /* Semantic chrome surfaces (dark mode swaps these; see THEME:dark). */",
    "  --color-page: #ffffff;",
    "  --color-surface: #ffffff;",
    `  --color-brand-ink: ${theme.brand[700]};`,
    `  ${COLORS_END}`,
  ].join("\n");
}

function darkRegion() {
  const d = theme.dark;
  const lightBrandTints = Object.fromEntries(Object.keys(d.brand).map((k) => [k, theme.brand[k]]));
  return [
    DARK_START,
    ".dark {",
    `  --color-page: ${d.page};`,
    `  --color-surface: ${d.surface};`,
    `  --color-brand-ink: ${d.brandInk};`,
    "",
    scaleVars("neutral", d.neutral),
    "",
    scaleVars("brand", d.brand),
    "}",
    "",
    "/* Escape hatch: subtrees that must stay light even under a dark app chrome",
    "   (document surfaces such as sheets, docs, and the present stage render the",
    "   user's content, which the app theme must never restyle). */",
    ".light {",
    "  color-scheme: light;",
    "  --color-page: #ffffff;",
    "  --color-surface: #ffffff;",
    `  --color-brand-ink: ${theme.brand[700]};`,
    "",
    scaleVars("neutral", theme.neutral),
    "",
    scaleVars("brand", lightBrandTints),
    "}",
    DARK_END,
  ].join("\n");
}

function rootRegion() {
  const g = theme.gradient;
  const o = theme.overlay;
  return [
    ROOT_START,
    `  --oc-brand-start: ${g.start};`,
    `  --oc-brand-mid: ${g.mid};`,
    `  --oc-brand-end: ${g.end};`,
    `  --oc-gradient: linear-gradient(${g.angle}, var(--oc-brand-start) 0%, var(--oc-brand-mid) 45%, var(--oc-brand-end) 100%);`,
    "",
    `  --color-selection: ${o.selection};`,
    `  --color-guide-subtle: ${o.guideSubtle};`,
    `  --color-guide-active: ${o.guideActive};`,
    `  --color-guide-conflict: ${o.guideConflict};`,
    `  --color-pen-preview: ${o.penPreview};`,
    `  --color-ruler: ${o.ruler};`,
    `  ${ROOT_END}`,
  ].join("\n");
}

function replaceRegion(src, startMarker, endMarker, replacement, label) {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`gen-theme: ${label} markers not found in globals.css. Expected ${startMarker} ... ${endMarker}`);
  }
  return src.slice(0, start) + replacement.trimStart() + src.slice(end + endMarker.length);
}

function nextGlobals(current) {
  let out = replaceRegion(current, COLORS_START, COLORS_END, colorsRegion(), "colors");
  out = replaceRegion(out, ROOT_START, ROOT_END, rootRegion(), "root");
  out = replaceRegion(out, DARK_START, DARK_END, darkRegion(), "dark");
  return out;
}

// --- theme.generated.ts: typed constants for the canvas overlays ------------

function tsModule() {
  const obj = (scale) => Object.entries(scale).map(([k, v]) => `  "${k}": "${v}",`).join("\n");
  const arr = (a) => a.map((c) => `  "${c}",`).join("\n");
  const o = theme.overlay;
  return [
    "// AUTO-GENERATED by scripts/gen-theme.mjs from src/theme.config.mjs. Do not edit by hand.",
    "// Edit colors in src/theme.config.mjs, then run `npm run gen:theme`.",
    "",
    "export const brand = {",
    obj(theme.brand),
    "} as const;",
    "",
    "export const accent = {",
    obj(theme.accent),
    "} as const;",
    "",
    "/** Editor canvas overlay colors (React-rendered SVG/CSS overlays; the engine",
    " *  cannot read CSS, so these are imported as data). `selection` is a",
    " *  deliberate cool hue kept distinct from the brand so selections stay",
    " *  legible against brand-colored content. */",
    "export const overlay = {",
    `  selection: "${o.selection}",`,
    `  guideSubtle: "${o.guideSubtle}",`,
    `  guideActive: "${o.guideActive}",`,
    `  guideConflict: "${o.guideConflict}",`,
    `  penPreview: "${o.penPreview}",`,
    `  ruler: "${o.ruler}",`,
    "} as const;",
    "",
    "/** Collaborator presence palette (assigned by a stable hash; shared with the",
    " *  Go backend via presence_palette_gen.go). */",
    "export const presencePalette = [",
    arr(theme.presence.palette),
    "] as const;",
    `export const presenceFallback = "${theme.presence.fallback}";`,
    "",
    "/** Avatar swatches (a distinct rainbow for telling collaborators apart). */",
    "export const avatarColors = [",
    arr(theme.avatars),
    "] as const;",
    "",
  ].join("\n");
}

// --- presence_palette_gen.go: the Go presence palette -----------------------

function goModule() {
  const rows = theme.presence.palette.map((c) => `\t"${c}",`).join("\n");
  return [
    "// Code generated by scripts/gen-theme.mjs from frontend/src/theme.config.mjs; DO NOT EDIT.",
    "",
    "package realtime",
    "",
    "// presencePalette is the stable per-user color palette, single-sourced with",
    "// the frontend via theme.config.mjs. Order is meaningful: changing it",
    "// reassigns existing users' colors, so append rather than reorder.",
    "var presencePalette = []string{",
    rows,
    "}",
    "",
  ].join("\n");
}

// --- brand_gen.go: product name + accent colors for server-rendered surfaces
// (e.g. transactional email) that have no access to CSS ----------------------

function goBrandModule() {
  const g = theme.gradient;
  // gradient.mid references the brand scale (var(--color-brand-600)); resolve it.
  const mid = typeof g.mid === "string" && g.mid.startsWith("var(") ? theme.brand[600] : g.mid;
  const entries = [
    ["Name", JSON.stringify(theme.name)],
    ["Primary", JSON.stringify(theme.brand[600])],
    ["PrimaryDark", JSON.stringify(theme.brand[700])],
    ["GradientStart", JSON.stringify(g.start)],
    ["GradientMid", JSON.stringify(mid)],
    ["GradientEnd", JSON.stringify(g.end)],
  ];
  const w = Math.max(...entries.map(([k]) => k.length));
  const rows = entries.map(([k, v]) => `\t${k.padEnd(w)} = ${v}`).join("\n");
  return [
    "// Code generated by scripts/gen-theme.mjs from frontend/src/theme.config.mjs; DO NOT EDIT.",
    "",
    "// Package brand holds the product/app brand identity (name + accent colors),",
    "// single-sourced with the frontend via theme.config.mjs. It is for",
    "// server-rendered surfaces that cannot read CSS, such as transactional email.",
    "// Primary is brand-600 (the main interactive color); the gradient stops drive",
    "// the brand sweep. To rebrand, edit theme.config.mjs and run `npm run gen:theme`.",
    "package brand",
    "",
    "const (",
    rows,
    ")",
    "",
  ].join("\n");
}

// --- drive ------------------------------------------------------------------

const currentGlobals = await readFile(GLOBALS, "utf8");
const wantGlobals = nextGlobals(currentGlobals);
const wantTs = tsModule();
const wantGo = goModule();
const wantGoBrand = goBrandModule();

async function read(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

const haveTs = await read(TS_OUT);
const haveGo = await read(GO_OUT);
const haveGoBrand = await read(GO_BRAND_OUT);

const stale = [];
if (wantGlobals !== currentGlobals) stale.push("globals.css");
if (wantTs !== haveTs) stale.push("theme.generated.ts");
if (wantGo !== haveGo) stale.push("presence_palette_gen.go");
if (wantGoBrand !== haveGoBrand) stale.push("brand_gen.go");

if (stale.length === 0) {
  console.log("gen-theme: all generated files already in sync.");
  process.exit(0);
}

if (check) {
  console.error(`gen-theme: OUT OF SYNC (${stale.join(", ")}). Run \`npm run gen:theme\` and commit.`);
  process.exit(1);
}

if (wantGlobals !== currentGlobals) await writeFile(GLOBALS, wantGlobals, "utf8");
if (wantTs !== haveTs) await writeFile(TS_OUT, wantTs, "utf8");
if (wantGo !== haveGo) await writeFile(GO_OUT, wantGo, "utf8");
if (wantGoBrand !== haveGoBrand) {
  await mkdir(dirname(GO_BRAND_OUT), { recursive: true });
  await writeFile(GO_BRAND_OUT, wantGoBrand, "utf8");
}
console.log(`gen-theme: wrote ${stale.join(", ")}.`);
