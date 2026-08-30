// Generate packages/text/src/font-catalog.generated.ts from Bunny's keyless font
// list (https://fonts.bunny.net/list): the full open-source library (the Google
// Fonts families) that Bunny mirrors and serves via its CSS2 endpoint. We bundle
// the METADATA (family name, category, weights, italic/variable flags) so the
// picker can search the whole library offline with no API key; the actual font
// files still load on demand from Bunny when a family is chosen/previewed.
//
// Refresh manually: node scripts/gen-fonts.mjs
//
// The families are all OFL/Apache open-source; only names + weights are bundled,
// no font files, so there is no redistribution concern.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const LIST_URL = "https://fonts.bunny.net/list";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "text", "src", "font-catalog.generated.ts");
const CATEGORIES = new Set(["sans-serif", "serif", "display", "handwriting", "monospace"]);

const res = await fetch(LIST_URL);
if (!res.ok) throw new Error(`bunny font list responded ${res.status}`);
const data = await res.json();

const entries = Object.values(data)
  .map((v) => {
    const weights = Array.isArray(v.weights) && v.weights.length
      ? [...new Set(v.weights.map(Number).filter(Number.isFinite))].sort((a, b) => a - b)
      : [400];
    return {
      family: String(v.familyName || "").trim(),
      category: CATEGORIES.has(v.category) ? v.category : "sans-serif",
      weights,
      italics: Array.isArray(v.styles) && v.styles.includes("italic"),
      variable: !!v.isVariable,
    };
  })
  .filter((e) => e.family)
  .sort((a, b) => a.family.localeCompare(b.family));

const lines = entries.map((e) => {
  const parts = [
    `family: ${JSON.stringify(e.family)}`,
    `category: ${JSON.stringify(e.category)}`,
    `weights: [${e.weights.join(", ")}]`,
  ];
  if (e.italics) parts.push("italics: true");
  if (e.variable) parts.push("variable: true");
  return `  { ${parts.join(", ")} },`;
});

const out = `// GENERATED FILE - do not edit by hand.
// Source: ${LIST_URL} (Bunny Fonts, a keyless GDPR-safe mirror of the Google Fonts
// open-source library). Refresh with: node scripts/gen-fonts.mjs
// ${entries.length} families. Metadata only; font files load on demand from Bunny.
import type { FontCatalogEntry } from "./fonts";

export const generatedFonts: FontCatalogEntry[] = [
${lines.join("\n")}
];
`;

writeFileSync(OUT, out);
console.log(`Wrote ${entries.length} families to ${OUT}`);
