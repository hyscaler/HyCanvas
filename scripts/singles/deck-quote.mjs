// Quote Slide: one single-slide template, a pull quote from a magazine. See
// scripts/gen-single-slides.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: cream and ink, with one oxblood mark. The reading pages are an
// ivory book stock typed in a warm near-black, oxblood for the rules, the
// icons and the numerals, and an inky slate for every second card. The deep
// pages are the ink itself, a plum-black, with a rosewood for the accent (a
// paler rose for accent text, where the rosewood alone would vibrate) and a
// pale sage for the second tone. A book serif carries the titles and the
// quote itself; a plain humanist sans reads the body and the small caps; a
// thin cursive hand is the editor's pencil in the kicker and the notes. The
// ornament is a watermark, one enormous closing quotation mark in a tint of
// the paper, bottom right: the whole page is one quotation, opened in oxblood
// at the head of the column and closed faintly at the foot. The signature is
// the pull quote as a magazine sets it: the opening mark hanging at the head
// of the column, the line in two balanced lines of the book serif, a
// hairline, then the byline row (a portrait, a short oxblood dash, the name
// in tracked capitals, the role) beside a caption column on where it was
// said.

import { text, rect, photo, art, note, footer, ornamentPaper, type, fitSize, linesFor, mixHex, M } from "../lib/deck-kit.mjs";

// Ivory stock types in warm black (15.5:1) with oxblood for the accent
// (9.2:1) and slate for the second (7.6:1); the muted ink holds 6.0:1. The
// plum-black pages type in ivory (13.9:1); the rosewood accent reads for
// rules and marks (4.5:1) and hands its text to the paler rose (7.0:1); the
// sage second tone holds 8.0:1.
const PAPER = { bg: "#F9F3E6", ink: "#1F1A1B", muted: "#655A5B", line: "#DCD1C1", panel: "#F1E9D9", panel2: "#E7DDC9", accent: "#7B1E2B", accent2: "#33506A" };
const DEEP = { bg: "#2A1F22", bg2: "#150F11", ink: "#F6EFE1", muted: "#BDB0AC", line: "#453739", panel: "#34282B", panel2: "#3F3135", accent: "#D8646F", accentInk: "#E8969C", accent2: "#9BBFB7" };

// --- the signature slide -------------------------------------------------------

/** The pull quote. A running head on the eyebrow line; the opening mark in
 *  oxblood hanging at the head of the column, its top on the cap line of the
 *  first line; the quote as large as the column allows, in the book serif;
 *  a hairline; then the byline row, a portrait slot with a drawn peep, a
 *  short oxblood dash, the name in tracked capitals and the role, and past
 *  a rule the caption column on where the line was said. The editor's note
 *  sits bottom right above the folio. */
function pullQuote(K, i, c) {
  const g = K.paper;
  const t = type(K, g);
  const cw = K.charWidth ?? 0.56;
  const fill = [];
  const nodes = [...ornamentPaper(K, g), ...footer(K, g, i)];
  const illustrations = [];

  // The running head, on the reading grid's eyebrow line.
  nodes.push(text(M, 88, 1000, 28, c.eyebrow ?? "Pull quote", t.eyebrow()));
  fill.push({ node: nodes.length - 1, label: "Running head", hint: "Where in the deck this sits" });

  // The column: the quote is 1300 wide and centred on the page, with the
  // mark hanging in the 224 to its left.
  const qx = M + 224, qw = 1300, qy = 316;
  const markSize = 260;
  nodes.push(text(M, qy - 26, 220, markSize, "“", t.display(markSize, { color: g.accent, lineHeight: 1 })));

  // The quote, stepping down until its longest line fits the column, in up
  // to three lines.
  const quote = c.text ?? "";
  const size = fitSize(quote, 112, qw, 0.6, cw);
  const lines = Math.max(1, Math.min(3, linesFor(quote, size, qw, cw)));
  const qh = Math.round(size * 1.14 * lines) + 12;
  nodes.push(text(qx, qy, qw, qh, quote, t.display(size, { lineHeight: 1.12 })));
  fill.push({ node: nodes.length - 1, label: "Quote", hint: "One or two sentences, as said; break the lines yourself" });

  // The byline row under a hairline: portrait, dash, name, role.
  const ay = qy + qh + 56;
  nodes.push(rect(qx, ay - 24, qw, 1, g.line));
  nodes.push(photo(qx, ay, 104, 104, mixHex(g.panel, g.accent, 0.18), { shape: "ellipse" }));
  illustrations.push(art(K.peeps[0], qx + 15, ay + 10, 74, 86));
  nodes.push(rect(qx + 132, ay + 50, 36, 3, g.accent));
  nodes.push(text(qx + 184, ay + 30, 620, 36, c.name ?? "", t.display(26, { upper: true, letterSpacing: 4 })));
  fill.push({ node: nodes.length - 1, label: "Name", hint: "Who said it" });
  nodes.push(text(qx + 184, ay + 68, 620, 30, c.role ?? "", t.body(20)));
  fill.push({ node: nodes.length - 1, label: "Role", hint: "Title and company" });

  // The caption column: where it was said, past a rule, the way a magazine
  // sets the dek beside the byline.
  nodes.push(rect(qx + 836, ay, 1, 104, g.line));
  nodes.push(text(qx + 876, ay + 6, qw - 876, 96, c.context ?? "", t.body(19)));
  fill.push({ node: nodes.length - 1, label: "Context", hint: "Where and when it was said, in two short sentences" });

  nodes.push(...note(K, g, c.note));
  return { page: { name: "Pull quote", bg: g.bg, nodes, illustrations }, fill };
}

const signature = { pullQuote };

export default {
  id: "deck-quote",
  title: "Quote Slide",
  base: "folio",
  rank: 100,
  tags: [
    "slide",
    "quote"
  ],
  styleTags: [
    "editorial",
    "elegant"
  ],
  meta: {
    company: "Northwind Labs",
    deck: "Q3 business review",
    kicker: "in their own words",
    farewell: "the last word"
  },
  look: {
    display: "Crimson Pro", dw: 500,
    body: "Commissioner", bw: 400,
    mono: null,
    accentFace: "Cedarville Cursive", accentWeight: 400, accentSize: 42,
    // Crimson Pro at 500 runs near 0.46 em per character; the estimate stays
    // a little conservative so a long line of the quote never overruns.
    charWidth: 0.5,
    paper: PAPER,
    deep: DEEP,
    radius: 0,
    ornament: "watermark",
    watermark: "”",
    art: { cover: "il-day57-reading-room", section: "il-day76-watch-spectacle", picture: "od-reading-side", closing: "il-day80-tea" },
    peeps: ["op-peep-34", "op-peep-77", "op-peep-89", "op-peep-54", "op-peep-10"],
    scale: { cover: 116, title: 62, section: 236, statement: 80, numeral: 104, quote: 56 },
  },
  signature,
  slides: [
    [
      "raw",
      {
        build: signature.pullQuote,
        eyebrow: "Pull quote  ·  Product",
        text: "We don’t ship features.\nWe ship outcomes.",
        name: "Priya Nair",
        role: "VP Product, Northwind Labs",
        context: "Said at the September all-hands and again to the board. The roadmap went from forty items to nine the same month.",
        note: "she said it twice, so we wrote it down"
      }
    ]
  ]
};
