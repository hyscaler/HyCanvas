// Translation coverage per locale (F38 FR-9, FR-11).
//
// With one JSON per language and per-key fallback to English, a catalog is
// never "broken", just incomplete. That is the right runtime behaviour and a
// poor reporting one: nothing tells you a language is 12% done, because the
// missing 88% renders as perfectly good English. This prints the number.
//
// It also fails on the two things that ARE errors rather than gaps: a key that
// no longer exists in the base catalog (a rename left the translation stranded)
// and a changed set of {placeholders} (which breaks substitution at runtime).
//
// Usage:
//   node scripts/i18n-coverage.mjs            report every locale
//   node scripts/i18n-coverage.mjs hi         report one, listing what is missing

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const BASE = join(ROOT, "frontend", "src", "locales", "en.json");
const DIR = join(ROOT, "frontend", "public", "locales");

const base = JSON.parse(readFileSync(BASE, "utf8"));
const baseKeys = Object.keys(base);
const only = process.argv[2];

/** Areas are how the work splits up, so coverage is reported per area too. */
const areaOf = (k) => k.split(".")[0];
const areas = [...new Set(baseKeys.map(areaOf))].sort();
const placeholders = (s) => (s.match(/\{(\w+)\}/g) ?? []).sort().join(",");

const files = existsSync(DIR)
  ? readdirSync(DIR).filter((f) => f.endsWith(".json") && f !== "index.json")
  : [];

if (!files.length) {
  console.log("No translation catalogs in frontend/public/locales.");
  console.log(`The base catalog has ${baseKeys.length} keys; every locale falls back to English.`);
  process.exit(0);
}

let failed = false;
console.log(`base: ${baseKeys.length} keys\n`);

for (const file of files.sort()) {
  const tag = file.replace(/\.json$/, "");
  if (only && tag !== only) continue;
  const cat = JSON.parse(readFileSync(join(DIR, file), "utf8"));
  const keys = Object.keys(cat);

  const stranded = keys.filter((k) => !(k in base));
  const brokenPlaceholders = keys.filter((k) => k in base && placeholders(base[k]) !== placeholders(cat[k]));
  const translated = keys.filter((k) => k in base).length;
  const pct = ((translated / baseKeys.length) * 100).toFixed(1);

  console.log(`${tag}: ${translated}/${baseKeys.length} (${pct}%)`);
  for (const a of areas) {
    const total = baseKeys.filter((k) => areaOf(k) === a).length;
    const done = keys.filter((k) => k in base && areaOf(k) === a).length;
    if (done) console.log(`    ${a.padEnd(14)} ${done}/${total}`);
  }
  if (stranded.length) {
    failed = true;
    console.log(`  STRANDED (no longer in the base catalog): ${stranded.join(", ")}`);
  }
  if (brokenPlaceholders.length) {
    failed = true;
    console.log(`  PLACEHOLDER MISMATCH (breaks substitution): ${brokenPlaceholders.join(", ")}`);
  }
  if (only) {
    const missing = baseKeys.filter((k) => !(k in cat));
    console.log(`\n  ${missing.length} keys still in English:`);
    for (const k of missing.slice(0, 40)) console.log(`    ${k}  =  ${JSON.stringify(base[k])}`);
    if (missing.length > 40) console.log(`    ... and ${missing.length - 40} more`);
  }
  console.log();
}

process.exit(failed ? 1 : 0);
