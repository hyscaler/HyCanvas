// Section Divider: one single-slide template, a curtain between acts. See scripts/gen-single-slides.mjs.
// divider has a deck around it. See scripts/gen-single-slides.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: deep plum and gold, the colours of a theatre before the house
// lights go down. The reading pages sit on a warm parchment; the deep pages
// on a plum gradient. Yeseva One, a display serif with a playbill's
// swagger, sets every title and the act numerals; Raleway reads; Cinzel
// carries the eyebrows and the footer in tracked capitals like a programme;
// Great Vibes is the script for the kicker and the hand notes. The
// ornament is a ghosted section sign, the monogram of a deck that is all
// about its dividers. Gold on cream is too light for type, so a bronze
// carries every accent word on paper.
//
// The signature slide is the divider itself as a stage: a velvet curtain
// drawn back on both sides with gold tie-backs, a scalloped pelmet along
// the top, and the act's numeral, title and blurb standing in the open
// while a dancer waits in a spotlight on the stage floor.

import { text, rect, ellipse, path, photo, art, halo, note, footer, type, deepGround, ornamentDeep, mixHex, fitSize, linesFor, W, H, M } from "../lib/deck-kit.mjs";

// --- the curtain ---------------------------------------------------------------

const ACT = {
  n: "II",
  kicker: "Act two",
  title: "Our approach",
  blurb: "How we get from idea to impact.",
  art: "od-ballet",
  note: "lights down, act two",
};

/** One curtain panel as a filled curve: straight along the page edge, an
 *  inner edge that pulls in to a waist where the tie-back holds it, then
 *  flares to the hem. `side` is 1 for the left panel, -1 for the right;
 *  every x is mirrored across the page for the right one. */
function panel(side, fillC) {
  const mx = (x) => (side > 0 ? x : W - x);
  return path([
    [mx(0), -10],
    { x: mx(430), y: -10, cOut: { x: mx(430), y: 300 } },
    { x: mx(290), y: 600, cIn: { x: mx(320), y: 420 }, cOut: { x: mx(260), y: 780 } },
    { x: mx(470), y: 940, cIn: { x: mx(330), y: 900 } },
    [mx(0), 940],
  ], { fill: fillC, closed: true, bleed: true });
}

/** A fold down a panel: a stroked curve that converges toward the waist
 *  the way the inner edge does. `k` is where it starts along the top. */
function fold(side, k, color, width, opacity) {
  const mx = (x) => (side > 0 ? x : W - x);
  const kw = k * (290 / 430), kf = k * (470 / 430);
  return path([
    { x: mx(k), y: -10, cOut: { x: mx(k), y: 300 } },
    { x: mx(kw), y: 600, cIn: { x: mx(kw * 1.08), y: 420 }, cOut: { x: mx(kw * 0.92), y: 780 } },
    { x: mx(kf), y: 940, cIn: { x: mx(kf * 0.75), y: 900 } },
  ], { stroke: color, strokeWidth: width, opacity, cap: "round", bleed: true });
}

/** The scalloped pelmet along the top of the stage: one closed path whose
 *  lower edge is a row of half discs, stroked in gold for the fringe. */
function pelmet(fillC, fringe) {
  const n = 16, w = 1940 / n, y = 72, depth = 84;
  const pts = [[-10, -10], [1930, -10]];
  for (let k = 0; k <= n; k++) {
    const x = 1930 - k * w;
    const p = { x, y };
    if (k > 0) p.cIn = { x, y: y + depth };
    if (k < n) p.cOut = { x, y: y + depth };
    pts.push(p);
  }
  return path(pts, { fill: fillC, stroke: fringe, strokeWidth: 3, closed: true, bleed: true });
}

/** The divider as a stage: curtains drawn back, the act in the open, a
 *  dancer in a spotlight at right. The library's section layout keeps the
 *  numeral, rule, title and blurb on the same baselines; here they stand
 *  between the curtains, and the picture slot is the lit disc on the floor. */
function curtain(K, i, c) {
  const g = K.deep;
  const t = type(K, g);
  const cw = K.charWidth ?? 0.56;
  const gold = g.accent;
  const velvet = "#5A1C57";
  const shade = mixHex(velvet, g.bg2, 0.6);
  const sheen = mixHex(velvet, gold, 0.16);
  const spot = "#F7E2A8";
  const floor = mixHex(g.bg2, "#000000", 0.3);
  const nodes = [...ornamentDeep(K, g)];
  const fill = [];

  // The beam from the pelmet to the spot, then the lit disc with its halo:
  // a picture slot on the floor, so a line figure reads on a deep page.
  nodes.push(path([[1240, 90], [1460, 90], [1600, 600], [1100, 600]], { fill: spot, opacity: 0.07, closed: true }));
  nodes.push(...halo(1350, 600, 640, gold));
  nodes.push(photo(1115, 365, 470, 470, { angle: 160, stops: [[spot, 0], [mixHex(spot, gold, 0.55), 1]] }, { shape: "ellipse" }));
  const illustrations = [art(c.art ?? K.art.section, 1180, 450, 340, 300)];

  // The stage floor and its footlights, under the curtains' hems.
  nodes.push(rect(0, 940, W, 140, floor));
  nodes.push(rect(0, 940, W, 2, gold, { opacity: 0.7 }));
  for (let k = 0; k < 8; k++) {
    const x = 560 + k * 114;
    nodes.push(ellipse(x - 18, 910, 36, 36, gold, { opacity: 0.14 }));
    nodes.push(ellipse(x - 6, 922, 12, 12, gold, { opacity: 0.95 }));
  }

  // The curtains: two panels, each with its folds, tie-back and tassel.
  for (const side of [1, -1]) {
    const mx = (x) => (side > 0 ? x : W - x);
    nodes.push(panel(side, velvet));
    for (const k of [70, 150, 230, 310, 390]) nodes.push(fold(side, k, shade, 18, 0.55));
    for (const k of [110, 190, 270, 350]) nodes.push(fold(side, k, sheen, 7, 0.6));
    const bx = side > 0 ? 0 : W - 304;
    nodes.push(rect(bx, 584, 304, 30, gold, { radius: 4 }));
    nodes.push(ellipse(mx(282) - 22, 577, 44, 44, gold));
    nodes.push(rect(mx(288) - 4, 616, 8, 62, gold, { opacity: 0.9 }));
    nodes.push(ellipse(mx(288) - 14, 674, 28, 46, gold));
  }
  nodes.push(pelmet(velvet, gold));

  // The act, standing in the open between the curtains.
  const x0 = 520, tw = 580;
  nodes.push(text(x0, 176, tw, 56, c.kicker ?? K.kicker, t.kicker()));
  fill.push({ node: nodes.length - 1, label: "Act", hint: "Which act this is" });
  nodes.push(text(x0, 236, tw, 190, c.n, t.numeral(170)));
  fill.push({ node: nodes.length - 1, label: "Numeral", hint: "The section number" });
  nodes.push(rect(x0, 446, 120, 4, gold));
  let size = fitSize(c.title, 84, tw, 0.8, cw);
  let lines = 1;
  if (linesFor(c.title, size, tw, cw) > 1) { size = 76; lines = 2; }
  const th = Math.round(size * 1.1 * lines) + 8;
  nodes.push(text(x0, 474, tw, th, c.title, t.display(size, { lineHeight: 1.04 })));
  fill.push({ node: nodes.length - 1, label: "Title", hint: "Two or three words" });
  nodes.push(text(x0, 474 + th + 18, tw, 112, c.blurb, t.body(26)));
  fill.push({ node: nodes.length - 1, label: "Blurb", hint: "One sentence on what the act covers" });
  nodes.push(...note(K, g, c.note, true, { x: 1070, y: 846, w: 560, align: "center" }));
  nodes.push(...footer(K, g, i));
  return { page: { name: "Curtain", bg: deepGround(g), nodes, illustrations }, fill };
}

const signature = { curtain };

export default {
  id: "deck-section-divider",
  title: "Section Divider",
  base: "vanta",
  rank: 100,
  tags: [
    "slide",
    "section",
    "divider"
  ],
  styleTags: [
    "elegant",
    "dark",
    "classic"
  ],
  meta: {
    company: "Northwind Labs",
    deck: "Q3 business review",
    kicker: "A quarter in three acts",
    farewell: "The house lights come up",
    art: {
      cover: "il-day21-lantern",
      section: "il-109-map-location",
      picture: "od-jumping",
      closing: "il-day35-firework"
    }
  },
  look: {
    display: "Yeseva One", dw: 400,
    body: "Raleway", bw: 500,
    mono: "Cinzel",
    accentFace: "Great Vibes", accentWeight: 400, accentSize: 46,
    charWidth: 0.6,
    strongWeight: 700,
    paper: { bg: "#F7EFE3", ink: "#2B1230", muted: "#6B5570", line: "#E0D2C6", panel: "#F0E5D6", panel2: "#E8DAC7", accent: "#B98A2C", accent2: "#7A2E80", accentInk: "#7C5813" },
    deep: { bg: "#3B1740", bg2: "#1E0B24", ink: "#F6EAD6", muted: "#CDB6CC", line: "#54305A", panel: "#48214F", panel2: "#54295D", accent: "#E4B858", accent2: "#D4A5E0" },
    radius: 6,
    ornament: "watermark",
    watermark: "§",
    peeps: ["op-peep-15", "op-peep-33", "op-peep-68", "op-peep-94", "op-peep-3"],
    scale: { cover: 112, title: 60, section: 236, statement: 78, numeral: 96, quote: 54 },
  },
  signature,
  slides: [
[
      "raw",
      {
        build: signature.curtain,
        ...ACT
      }
    ],
  ]
};
