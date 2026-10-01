// Generate the topic decks: one presentation template per file in
// scripts/topics/, each a look from scripts/lib/deck-kit.mjs (a base look
// plus the deck's own overrides) over a chosen sequence of layouts with the
// topic's own copy, and any raw slides the deck builds itself.
//
//   node scripts/gen-topic-decks.mjs                 # write every topic spec
//   node scripts/gen-topic-decks.mjs --only <id>     # write one deck's spec
//   node scripts/build-templates.mjs                 # then compile the seed
//
// A topic deck is what a user picks when they know what they are presenting
// (a sales review, a kickoff, a case study) and want a deck that already
// says the right kind of things in the right order, in a look chosen for
// that subject. Replace the words, keep the shape.

import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LOOKS, buildSpec, specNodes } from "./lib/deck-kit.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOPICS = join(ROOT, "scripts", "topics");
const OUT = join(ROOT, "scripts", "templates");

const onlyAt = process.argv.indexOf("--only");
const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : null;

const files = readdirSync(TOPICS).filter((f) => f.endsWith(".mjs")).sort();
let n = 0;
for (const f of files) {
  const plan = (await import(pathToFileURL(join(TOPICS, f)).href)).default;
  if (only && plan.id !== only) continue;
  const base = LOOKS[plan.base];
  if (!base) throw new Error(`${plan.id}: unknown base look ${plan.base}`);
  const spec = buildSpec(base, {
    id: plan.id,
    title: plan.title,
    categories: plan.categories ?? ["presentations", "business"],
    tags: plan.tags,
    styleTags: plan.styleTags ?? base.styleTags,
    meta: plan.meta,
    look: plan.look,
    slides: plan.slides,
    version: plan.version ?? 3,
    created: "2026-08-28T00:00:00.000Z",
    updated: plan.updated ?? "2026-09-30T00:00:00.000Z",
    rank: plan.rank,
  });
  writeFileSync(join(OUT, `${plan.id}.json`), JSON.stringify(spec, null, 1) + "\n");
  console.log(`${plan.id}: ${spec.pages.length} slides, ${specNodes(spec)} nodes`);
  n++;
}
if (only && n === 0) throw new Error(`no topic deck with id ${only}`);
console.log(`${n} topic deck${n === 1 ? "" : "s"}`);
