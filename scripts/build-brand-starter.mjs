// Rasterize the starter brand kit's logo artwork (backend/internal/brand/starter).
//
// The SVG sources under starter/src are the masters: the visitor mark and the
// horizontal lockup are drawn in currentColor (the wordmark is outlined, so no
// font is needed), and the app tile carries its own gradient. This script
// renders the PNGs the kit ships: one ink version for light grounds and one
// paper version for dark grounds of each currentColor master, plus the colour
// lockup (the app's own header logo) for a light ground that wants the brand
// colour rather than ink, at a size that stays sharp on a full-bleed cover. The Go raster exporter decodes PNG and
// not SVG, which is why the kit stores rasters and not the masters.
//
//   node scripts/build-brand-starter.mjs
//
// Needs rsvg-convert (librsvg) on PATH: `brew install librsvg` or
// `apt install librsvg2-bin`. The outputs are committed; run this only when
// a master changes, then rebuild the backend so it re-embeds the files.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "backend", "internal", "brand", "starter");
const SRC = join(DIR, "src");

// The brand's ink (mark colour on paper) and paper (mark colour on the
// gradient and every dark ground). Part of the logo asset, not the app accent.
const INK = "#160A12";
const PAPER = "#FBF7FA";

const JOBS = [
  { src: "lockup.svg", out: "hycanvas-logo-ink.png", color: INK, width: 2048 },
  { src: "lockup.svg", out: "hycanvas-logo-paper.png", color: PAPER, width: 2048 },
  { src: "mark.svg", out: "hycanvas-mark-ink.png", color: INK, height: 1024 },
  { src: "mark.svg", out: "hycanvas-mark-paper.png", color: PAPER, height: 1024 },
  { src: "tile.svg", out: "hycanvas-tile.png", width: 1024 },
  { src: "lockup-color.svg", out: "hycanvas-logo-color.png", width: 2048 },
];

try {
  execFileSync("rsvg-convert", ["--version"], { stdio: "ignore" });
} catch {
  console.error("rsvg-convert not found on PATH (brew install librsvg / apt install librsvg2-bin)");
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "brand-starter-"));
try {
  for (const job of JOBS) {
    const args = ["--format", "png", "--keep-aspect-ratio"];
    if (job.width) args.push("--width", String(job.width));
    if (job.height) args.push("--height", String(job.height));
    if (job.color) {
      // currentColor resolves to the inherited `color`, so one stylesheet line
      // recolours the whole master.
      const css = join(tmp, job.out.replace(/\.png$/, ".css"));
      writeFileSync(css, `svg { color: ${job.color}; }\n`);
      args.push("--stylesheet", css);
    }
    const out = join(DIR, job.out);
    args.push("--output", out, join(SRC, job.src));
    execFileSync("rsvg-convert", args, { stdio: "inherit" });
    console.log(`${job.out} ${Math.round(statSync(out).size / 1024)} KB`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
