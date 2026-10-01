// Generate the single-slide templates: one layout each from
// scripts/lib/deck-kit.mjs, in a look chosen for the slide (a base look plus
// the slide's own overrides), from the files in scripts/singles/. A user
// inserts one of these into a deck of their own; a single slide carries no
// page number.
//
//   node scripts/gen-single-slides.mjs                # write every single slide
//   node scripts/gen-single-slides.mjs --only <id>    # write one
//   node scripts/build-templates.mjs

import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LOOKS, buildSpec, specNodes } from "./lib/deck-kit.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SINGLES = join(ROOT, "scripts", "singles");
const OUT = join(ROOT, "scripts", "templates");

const onlyAt = process.argv.indexOf("--only");
const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : null;

let n = 0;
for (const f of readdirSync(SINGLES).filter((x) => x.endsWith(".mjs")).sort()) {
  const plan = (await import(pathToFileURL(join(SINGLES, f)).href)).default;
  if (only && plan.id !== only) continue;
  const base = LOOKS[plan.base];
  if (!base) throw new Error(`${plan.id}: unknown base look ${plan.base}`);
  const spec = buildSpec(base, {
    id: plan.id, title: plan.title, tags: plan.tags, styleTags: plan.styleTags ?? base.styleTags,
    meta: plan.meta, look: plan.look, slides: plan.slides,
    version: plan.version ?? 3, created: "2026-07-04T00:00:00.000Z", updated: plan.updated ?? "2026-09-30T00:00:00.000Z", rank: plan.rank,
  });
  writeFileSync(join(OUT, `${plan.id}.json`), JSON.stringify(spec, null, 1) + "\n");
  console.log(`${plan.id}: ${spec.pages.length} slide, ${specNodes(spec)} nodes`);
  n++;
}
if (only && n === 0) throw new Error(`no single slide with id ${only}`);
