#!/usr/bin/env node
// Vendors the fonts the stock templates use into the Go binary, so the
// exports the SERVER renders (video, the tagged PDF, API exports) draw a
// stock template's text in its own fonts instead of the built-in fallback
// (#85). The browser keeps loading fonts from Google Fonts as before.
//
//   node scripts/fetch-stock-fonts.mjs
//
// Reads every fontFamily/weight from backend/internal/templates/seed.json,
// downloads the static TrueType instance of each from Google Fonts, gzips it
// into backend/internal/render/stockfonts/<Family>-<weight>.ttf.gz, and saves
// each family's license from the google/fonts repository next to it. Every
// family must be under the SIL Open Font License, Apache 2.0 or the Ubuntu
// Font License, all of which allow redistribution; anything else stops the
// script. manifest.json records each file's source and sha256.
//
// Rerun after adding templates that use new fonts; unchanged files are kept.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SEED = path.join(ROOT, "backend/internal/templates/seed.json");
const OUT = path.join(ROOT, "backend/internal/render/stockfonts");
// An old user agent makes the Google Fonts CSS API answer with static
// TrueType files (one per weight) rather than variable WOFF2.
const UA = "Mozilla/4.0";

// Family names some templates carry with the weight baked in.
const ALIAS = { "Jost-ExtraBold": ["Jost", 800], "Jost-Medium": ["Jost", 500] };

function collect() {
  const fams = new Map();
  const add = (family, weight) => {
    if (!family || typeof family !== "string") return;
    let w = Number(weight) || 400;
    if (ALIAS[family]) [family, w] = ALIAS[family];
    if (!fams.has(family)) fams.set(family, new Set());
    fams.get(family).add(w);
  };
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    const st = n.style;
    if (st && typeof st === "object" && st.fontFamily) add(st.fontFamily, st.axes?.wght ?? st.fontWeight);
    if (typeof n.fontFamily === "string") add(n.fontFamily, n.axes?.wght ?? n.fontWeight);
    Object.values(n).forEach(walk);
  };
  for (const e of JSON.parse(fs.readFileSync(SEED, "utf8"))) walk(e.file);
  return fams;
}

async function get(url, asText) {
  for (let i = 0; i < 3; i++) {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (res.ok) return asText ? res.text() : Buffer.from(await res.arrayBuffer());
    if (res.status === 400 || res.status === 404) return null;
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  throw new Error(`fetch failed: ${url}`);
}

const fileBase = (family) => family.replace(/\s+/g, "");
const repoDir = (family) => family.toLowerCase().replace(/[^a-z0-9]/g, "");

async function license(family) {
  for (const dir of ["ofl", "apache", "ufl"]) {
    for (const name of ["OFL.txt", "LICENSE.txt", "UFL.txt"]) {
      const text = await get(`https://raw.githubusercontent.com/google/fonts/main/${dir}/${repoDir(family)}/${name}`, true);
      if (text) return { dir, text };
    }
  }
  return null;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const manifestPath = path.join(OUT, "manifest.json");
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : { files: {} };
  const fams = collect();
  const missing = [];
  for (const [family, weights] of [...fams].sort(([a], [b]) => a.localeCompare(b))) {
    const lic = await license(family);
    if (!lic) throw new Error(`no redistributable license found for ${family}`);
    fs.writeFileSync(path.join(OUT, `${fileBase(family)}.LICENSE.txt`), lic.text);
    for (const w of [...weights].sort((a, b) => a - b)) {
      const name = `${fileBase(family)}-${w}.ttf.gz`;
      if (manifest.files[name] && fs.existsSync(path.join(OUT, name))) continue;
      const css = await get(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${w}`, true);
      const url = css && css.match(/url\((https:[^)]+\.ttf)\)/)?.[1];
      if (!url) {
        // The family has no such weight (the editor falls back to the nearest);
        // the server does the same from the weights that exist.
        missing.push(`${family} ${w}`);
        continue;
      }
      const ttf = await get(url);
      fs.writeFileSync(path.join(OUT, name), zlib.gzipSync(ttf, { level: 9 }));
      manifest.files[name] = { family, weight: w, license: lic.dir, source: url, sha256: crypto.createHash("sha256").update(ttf).digest("hex") };
      process.stdout.write(".");
    }
  }
  manifest.files = Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const bytes = fs.readdirSync(OUT).filter((f) => f.endsWith(".gz")).reduce((a, f) => a + fs.statSync(path.join(OUT, f)).size, 0);
  console.log(`\n${Object.keys(manifest.files).length} faces from ${fams.size} families, ${(bytes / 1048576).toFixed(1)} MB gzipped`);
  if (missing.length) console.log(`weights not published (nearest is used): ${missing.join(", ")}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
