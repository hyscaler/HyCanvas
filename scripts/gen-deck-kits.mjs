// Generate the presentation kits: six complete slide systems, twenty-one
// layouts each, written as template specs (scripts/templates/kit-*.json) for
// scripts/build-templates.mjs to compile into the embedded seed.
//
//   node scripts/gen-deck-kits.mjs            # write the six kit specs
//   node scripts/build-templates.mjs          # then compile the seed
//
// A kit is one look from scripts/lib/deck-kit.mjs over every layout the
// library has, with the library's sample content: cover, agenda, section,
// statement, text with a picture, two columns, three cards, a figure row, a
// chart, a timeline, a process, a comparison table, a team, a quote, pricing
// and a closing. The topic decks (scripts/gen-topic-decks.mjs) use the same
// looks and layouts with their own copy; the kits are the full catalog, for
// a user who wants to pick slides from one style.
//
// The specs are generated rather than hand-written because sixteen slides
// times six kits is a thousand-odd nodes, and one grid change must land on
// all of them at once. The generated JSON is committed: the compiler's
// contract that specs are the source of truth is unchanged, and a kit can
// still be edited by hand after the fact.

import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KITS, buildSpec, specNodes } from "./lib/deck-kit.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "scripts", "templates");

const SLIDES = [
  ["cover"], ["agenda"],
  ["section", { n: "01", title: "Where we stand", blurb: "The year in numbers, and what sits behind each of them." }],
  ["statement"], ["textPicture"], ["twoColumns"], ["threeCards"], ["fourCards"], ["figures"], ["chart"], ["timeline"], ["process"], ["schedule"], ["checklist"], ["facts"], ["split"], ["table"], ["team"], ["quote"], ["pricing"], ["closing"],
];

for (const K of KITS) {
  const spec = buildSpec(K, {
    id: K.id,
    title: K.title,
    tags: K.tags,
    styleTags: K.styleTags,
    slides: SLIDES,
    version: 2,
    created: "2026-09-29T00:00:00.000Z",
    updated: "2026-09-30T00:00:00.000Z",
    rank: K.rank,
  });
  writeFileSync(join(OUT, `${K.id}.json`), JSON.stringify(spec, null, 1) + "\n");
  console.log(`${K.id}: ${spec.pages.length} slides, ${specNodes(spec)} nodes`);
}
