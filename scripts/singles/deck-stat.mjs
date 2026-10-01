// Big Stat Slide: one single-slide template, one number under a spotlight. See scripts/gen-single-slides.mjs.
// scripts/gen-single-slides.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: one number, lit like a stage. The deep pages are forest green
// with lime for every accent, the reading pages a pale lime-white with the
// forest as the accent, so each ground is the other's colour. A heavy
// condensed display face carries the titles and every figure; a plain sans
// reads the body; a mono sets the eyebrows and labels; a tall marker hand is
// the presenter's voice in the kicker and the asides. The ornament is
// stripes: three diagonal bands of lime on the deep pages, light beams
// across a dark house. The signature slide is the stage itself: a spotlight
// cone from above, the figure standing in the pool of light with its shadow
// on the floor, a row of footlights, and the before and after in the wings.

import { text, rect, ellipse, button, path, halo, note, footer, ornamentDeep, type, deepGround, fitSize, mixHex, W, M, CW } from "../lib/deck-kit.mjs";

const PAPER = { bg: "#F3F7E8", ink: "#0E2418", muted: "#4A6152", line: "#D2DDC4", panel: "#E8EFD9", panel2: "#DDE7CA", accent: "#1B6A3D", accent2: "#7E9E0C", accent2Ink: "#4F6A00" };
const DEEP = { bg: "#113626", bg2: "#061810", ink: "#F3F7E8", muted: "#A6BFAD", line: "#24523B", panel: "#193F2E", panel2: "#205238", accent: "#C9F236", accent2: "#93DDAA", lime: "#C9F236" };

// --- the signature slide -------------------------------------------------------

/** The stage: the one figure under a spotlight. A cone of light falls from
 *  above the page to a floor rule; the number stands in the pool it makes,
 *  casting a shadow; footlights run along the edge; the before and after
 *  run-rates wait in the wings, the before struck through. The caption and
 *  the comparison pill sit in front of the stage, where the audience is. */
function stage(K, i, c) {
  const g = K.deep;
  const t = type(K, g);
  const fill = [];
  const lime = g.accentInk ?? g.accent;
  const cw = K.charWidth ?? 0.56;
  const floorY = 744;

  const nodes = [...ornamentDeep(K, g)];

  // The spotlight: two cones from above the page to the floor, then the
  // pool of light where they land.
  nodes.push(path([[800, -60], [1120, -60], [1600, floorY], [320, floorY]], { fill: g.accent, opacity: 0.06, closed: true, bleed: true }));
  nodes.push(path([[880, -60], [1040, -60], [1350, floorY], [570, floorY]], { fill: g.accent, opacity: 0.08, closed: true, bleed: true }));
  nodes.push(ellipse(W / 2 - 640, floorY - 34, 1280, 68, g.accent, { opacity: 0.1 }));
  nodes.push(...halo(W / 2, 520, 720, g.accent));

  // The eyebrow, centered, on the deep grid's kicker line.
  nodes.push(text(M, 236, CW, 28, c.eyebrow, t.eyebrow({ align: "center" })));
  fill.push({ node: nodes.length - 1, label: "Eyebrow", hint: "What the figure measures" });

  // The figure, as large as the width allows, standing on the floor.
  // The box ends 20 px above the floor so the baseline, and the dollar
  // sign's descender under it, clear the rule in any face: a fallback sans
  // sets the baseline near the box's bottom, the display face higher. The
  // shadow below still sits under the glyphs.
  const size = fitSize(c.value, 380, 1360, 0.5, cw);
  const numY = floorY - size - 44;
  nodes.push(text(M, numY, CW, size + 24, c.value, t.numeral(size, { align: "center", lineHeight: 1 })));
  fill.push({ node: nodes.length - 1, label: "Figure", hint: "The one number" });

  // The wings: the run-rate before, struck through, and after.
  const wingY = 560;
  const wingW = 380;
  const [beforeLabel, beforeValue] = c.before;
  const [afterLabel, afterValue] = c.after;
  nodes.push(text(M, wingY, wingW, 24, beforeLabel, t.eyebrow({ size: 15, letterSpacing: 3 })));
  fill.push({ node: nodes.length - 1, label: "Before, label", hint: "What the earlier figure was" });
  nodes.push(text(M, wingY + 34, wingW, 72, beforeValue, t.numeral(64, { color: g.muted, strike: true })));
  fill.push({ node: nodes.length - 1, label: "Before, figure", hint: "The earlier figure" });
  nodes.push(text(W - M - wingW, wingY, wingW, 24, afterLabel, t.eyebrow({ size: 15, letterSpacing: 3, align: "right" })));
  fill.push({ node: nodes.length - 1, label: "After, label", hint: "What the figure is now" });
  nodes.push(text(W - M - wingW, wingY + 34, wingW, 72, afterValue, t.numeral(64, { color: g.ink, align: "right" })));
  fill.push({ node: nodes.length - 1, label: "After, figure", hint: "The figure now" });

  // The floor: the number's shadow, the edge of the stage, the footlights.
  nodes.push(ellipse(W / 2 - 300, floorY - 16, 600, 24, g.bg2, { opacity: 0.55 }));
  nodes.push(rect(M, floorY, CW, 2, g.line));
  // Footlights along the front edge, in front of the stage, never behind
  // the figure.
  for (let k = 0; k < 11; k++) {
    const x = M + 64 + k * 160;
    nodes.push(ellipse(x - 16, floorY + 2, 32, 32, g.accent, { opacity: 0.14 }));
    nodes.push(ellipse(x - 5, floorY + 13, 10, 10, g.accent, { opacity: 0.95 }));
  }

  // In front of the stage: the caption and the comparison.
  nodes.push(text(W / 2 - 600, 798, 1200, 82, c.caption, t.body(28, { align: "center", color: g.ink })));
  fill.push({ node: nodes.length - 1, label: "Caption", hint: "One sentence on what it means" });
  nodes.push(button(W / 2 - 140, 896, 280, 48, c.delta, { fill: mixHex(g.bg, g.accent, 0.22), color: lime, family: K.body, size: 19, weight: 700 }));
  fill.push({ node: `${nodes.length - 1}-label`, label: "Comparison", hint: "Against what" });

  nodes.push(...footer(K, g, i));
  nodes.push(...note(K, g, c.note, true, { x: W - M - 560, y: 900, w: 560, align: "right" }));
  return { page: { name: "The stage", bg: deepGround(g), nodes }, fill };
}

const signature = { stage };

export default {
  id: "deck-stat",
  title: "Big Stat Slide",
  base: "terra",
  rank: 100,
  tags: [
    "slide",
    "stat",
    "data"
  ],
  styleTags: [
    "bold",
    "modern"
  ],
  meta: {
    company: "Northwind Labs",
    deck: "Q3 business review",
    kicker: "one number, no rounding up",
    farewell: "thanks, and one ask",
    art: {
      cover: "la-sale",
      section: "il-day70-designer-fav-tool-wacom",
      picture: "il-day78-wallet",
      closing: "il-day71-designer-tool-essential"
    }
  },
  look: {
    display: "Big Shoulders Display", dw: 900,
    body: "Onest", bw: 400,
    mono: "Red Hat Mono",
    accentFace: "Just Another Hand", accentWeight: 400, accentSize: 44,
    // Big Shoulders Display at 900 runs near 0.42 em per character; the
    // estimate stays a little conservative so a heavy line never overruns.
    charWidth: 0.46,
    // Pale lime paper types in forest black (15.0:1) with the forest green as
    // the accent (6.1:1) and a dark olive for accent text (5.7:1); forest
    // pages type in lime-white (12.2:1) and lime (10.3:1). Only the paper's
    // olive vibrates as text, so only it gets an ink.
    paper: PAPER,
    deep: DEEP,
    radius: 6,
    ornament: "stripes",
    peeps: ["op-peep-1", "op-peep-57", "op-peep-67", "op-peep-83", "op-peep-95"],
    scale: { cover: 116, title: 62, section: 236, statement: 80, numeral: 112, quote: 54 },
  },
  signature,
  slides: [
[
      "raw",
      {
        build: signature.stage,
        eyebrow: "Revenue impact",
        value: "$1.2M",
        caption: "Added in net-new annual revenue from the redesigned checkout.",
        delta: "+38% on Q1",
        before: ["Q1 run-rate", "$3.2M"],
        after: ["Q3 run-rate", "$4.4M"],
        note: "finance checked it twice"
      }
    ],
  ]
};
