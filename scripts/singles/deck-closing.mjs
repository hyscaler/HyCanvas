// Closing Slide: one single-slide template, the thank-you that still asks
// for one thing. See scripts/gen-single-slides.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: cobalt, coral and one lime. The deep page is a cobalt that falls
// to ink-blue at the bottom right, with coral for the wedge in the corner,
// the icons and the button, and a peach for every accent that has to be read
// (the kicker, the eyebrows, the hand notes); the paper is a warm peach-white
// with cobalt ink and a dark coral for accent text. Lime appears in exactly
// one place, the tear-off stub. A black-weight sans carries the titles and
// the figure, a plain sans reads the body, a mono sets the labels, and a
// loose bold hand is the voice in the kicker and the notes. The ornament is
// the corner: one coral triangle, bold and brief, the way a closing should
// be. The signature slide is the ticket: the thank-you at top, and under it
// a card with a perforation and a lime stub, so the one ask reads as the
// part of the ticket you tear off and keep.

import { text, rect, button, icon, art, halo, sparkles, note, mark, type, deepGround, ornamentDeep, inkOn, fitSize, M, CW } from "../lib/deck-kit.mjs";

const PAPER = { bg: "#FFF4EE", ink: "#0F1E66", muted: "#525A85", line: "#F0D8CC", panel: "#FFE9DF", panel2: "#FCDCCE", accent: "#F0553A", accentInk: "#B8361F", accent2: "#1735B2", lime: "#B9E32A" };
const DEEP = { bg: "#1735B2", bg2: "#0A175C", ink: "#F8F6F2", muted: "#C5CCF6", line: "#3450D0", panel: "#2244C6", panel2: "#2D50D4", accent: "#FF6B4F", accentInk: "#FFBFAE", accent2: "#A9C2FF", lime: "#DDF24A" };

// --- the signature slide -------------------------------------------------------

/** The ticket: the thank-you block on the cover's baselines at left, the
 *  drawing lit in its halo against the coral wedge at right, and under the
 *  thank-you a ticket. Its body carries the one ask; a dashed perforation
 *  separates the lime stub, which holds the figure (how long the ask takes)
 *  and the button, in cobalt ink on the lime. The contact details run
 *  along the footer line, the way a ticket prints its small print. */
function ticket(K, i, c) {
  const g = K.deep;
  const t = type(K, g);
  const cw = K.charWidth ?? 0.56;
  const fill = [];
  const illustrations = [];

  // The corner wedge, and sparkle only behind the drawing, where no text sits.
  const nodes = ornamentDeep(K, g).filter((n) => n.kind !== "ellipse");
  nodes.push(...sparkles(g.ink, 23, 7, { x: 1130, y: 470, w: 720, h: 300 }));

  nodes.push(...mark(K, g));
  fill.push({ node: nodes.length - 1, label: "Company", hint: "Your company or team name" });

  // The thank-you, on the closing's baselines.
  nodes.push(text(M, 236, 1000, Math.round(K.accentSize * 1.3), K.farewell, t.kicker()));
  const size = fitSize(c.title, K.scale.cover, 1000, 0.6, cw);
  const lines = c.title.split("\n").length;
  const titleH = Math.round(size * 1.1 * lines) + 10;
  nodes.push(text(M, 296, 1000, titleH, c.title, t.display(size, { lineHeight: 1.04 })));
  fill.push({ node: nodes.length - 1, label: "Title", hint: "Two words, one line" });
  nodes.push(text(M, 296 + titleH + 26, 900, 80, c.subtitle, t.body(28)));
  fill.push({ node: nodes.length - 1, label: "Subtitle", hint: "One sentence on where the conversation goes next" });

  // The ticket: a card, a lime stub, a perforation between them.
  const tx = M, ty = 604, tw = 1000, th = 284, stubW = 300;
  const px = tx + tw - stubW;
  nodes.push(rect(tx, ty, tw, th, g.panel, { radius: K.radius, stroke: g.line, strokeWidth: 1.5 }));
  nodes.push(rect(px, ty, stubW, th, g.lime, { radius: K.radius }));
  // The perforation: a column of short cobalt dashes just inside the stub's
  // edge, where they read on the lime; drawn as rects so every renderer
  // shows the same tear line. No notches: the ground is a gradient and a
  // disc in one flat colour never matches it.
  for (let y = ty + 16; y < ty + th - 16; y += 14) nodes.push(rect(px + 3, y, 2, 8, g.bg2, { opacity: 0.8 }));

  // The body: the one ask.
  const bx = tx + 44, bw = tw - stubW - 88;
  nodes.push(text(bx, ty + 36, bw, 26, c.askEyebrow, t.eyebrow({ size: 18, letterSpacing: 3 })));
  nodes.push(text(bx, ty + 74, bw, 96, c.ask, t.display(38, { lineHeight: 1.12 })));
  fill.push({ node: nodes.length - 1, label: "The ask", hint: "The one thing you want from the room" });
  nodes.push(text(bx, ty + 182, bw, 60, c.askBody, t.body(20)));
  fill.push({ node: nodes.length - 1, label: "The ask, detail", hint: "What it involves, and what it does not" });

  // The stub: the figure and the button, in cobalt ink on lime.
  const sx = px + 32, sw = stubW - 64;
  const stubInk = K.paper.ink;
  nodes.push(text(sx, ty + 36, sw, 24, c.stubEyebrow, t.eyebrow({ size: 16, letterSpacing: 3, color: stubInk })));
  nodes.push(text(sx, ty + 68, sw, 104, c.figure, t.numeral(96, { color: stubInk, lineHeight: 1 })));
  fill.push({ node: nodes.length - 1, label: "Figure", hint: "How long the ask takes" });
  nodes.push(text(sx, ty + 176, sw, 24, c.figureLabel, { family: K.mono ?? K.body, size: 15, weight: 500, color: stubInk, lineHeight: 1.2 }));
  nodes.push(button(sx, ty + 212, sw, 52, c.cta, { fill: g.accent, color: inkOn(K, g.accent), family: K.body, size: 18, weight: 700, radius: K.radius ? Math.min(K.radius, 26) : 0 }));
  fill.push({ node: `${nodes.length - 1}-label`, label: "Button", hint: "The action, two or three words" });

  // The small print: contact details along the footer line.
  nodes.push(rect(M, 960, CW, 1, g.line));
  const labels = ["Email", "Website", "Phone"];
  const cols = [[M, 330], [500, 280], [840, 220]];
  c.rows.forEach(([ic, v], k) => {
    const [x, w] = cols[k] ?? [M + k * 340, 300];
    nodes.push(icon(ic, x, 984, 24, g.accent));
    nodes.push(text(x + 36, 982, w, 30, v, t.strong(22, { weight: 500 })));
    fill.push({ node: nodes.length - 1, label: labels[k] ?? "Contact", hint: "Contact detail" });
  });

  // The hero: the drawing in its halo, over the wedge's lower edge.
  nodes.push(...halo(1500, 500, 620, g.accent));
  illustrations.push(art(c.art ?? K.art.closing, 1240, 240, 520, 520));
  nodes.push(...note(K, g, c.note, true, { x: 1150, y: 800, w: 700, align: "center" }));
  return { page: { name: "Closing", bg: deepGround(g), nodes, illustrations }, fill };
}

const signature = { ticket };

export default {
  id: "deck-closing",
  title: "Closing Slide",
  base: "pulse",
  rank: 20,
  tags: [
    "slide",
    "closing",
    "thanks"
  ],
  styleTags: [
    "bold",
    "modern"
  ],
  meta: {
    company: "Northwind Labs",
    deck: "Q3 business review",
    kicker: "before you go",
    farewell: "That's it from us"
  },
  look: {
    display: "Epilogue", dw: 900,
    body: "Instrument Sans", bw: 400,
    mono: "DM Mono",
    accentFace: "Shantell Sans", accentWeight: 700, accentSize: 40,
    // Epilogue at 900 runs a little wide; the estimate stays conservative.
    charWidth: 0.6,
    // Peach paper types in cobalt (13.9:1) with a dark coral for accent text
    // (5.4:1); the cobalt page types in warm white (8.9:1), its body in a pale
    // cobalt (6.1:1), and every accent that is read in peach (6.1:1, 4.9:1 on
    // the ticket). The coral itself stays on rules, icons and fills.
    paper: PAPER,
    deep: DEEP,
    radius: 6,
    ornament: "corner",
    art: { cover: "il-day35-firework", section: "la-hero-image-2", picture: "la-waitng-illustration", closing: "il-day17-walkie-talkie" },
    peeps: ["op-peep-31", "op-peep-44", "op-peep-69", "op-peep-90", "op-peep-15"],
    scale: { cover: 128, title: 62, section: 236, statement: 80, numeral: 108, quote: 54 },
  },
  signature,
  slides: [
    [
      "raw",
      {
        build: signature.ticket,
        title: "Thank you",
        subtitle: "Let's keep the conversation going.\nQuestions now, or any time this week.",
        askEyebrow: "One thing before you go",
        ask: "Give us one call\nthis week.",
        askBody: "Your questions, the numbers you asked for,\nand nothing to prepare.",
        stubEyebrow: "Takes",
        figure: "20",
        figureLabel: "minutes, any day you like",
        cta: "Book a follow-up",
        rows: [
          ["mail", "hello@northwindlabs.example"],
          ["world", "northwindlabs.example"],
          ["phone", "+1 415 555 0142"]
        ],
        art: "il-day17-walkie-talkie",
        note: "one call. we'll bring the numbers."
      }
    ]
  ]
};
