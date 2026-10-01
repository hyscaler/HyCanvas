// Customer Case Study: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: royal blue and warm gold on white, a confident book serif with a
// humanist sans for the reading and a fountain-pen hand for the notes.
// Hairlines as the ornament, for the feel of a proof document: a rule top
// and bottom like a letterhead, a gold disc in the corner like a seal.
// Blue is what is true now, gold is the change, muted ink is what was.

import { text, rect, button, type, chrome, note, mixHex, M, CW } from "../lib/deck-kit.mjs";

// --- the signature slide -------------------------------------------------------

/** The width of a short figure in the display face: digits, capitals and
 *  currency signs are wide, spaces and points narrow, letters between. The
 *  strike through the old figure is drawn to this width. */
const figureWidth = (s, size) => s.split("").reduce((w, ch) => w + (/[0-9A-Z$]/.test(ch) ? 0.6 : /[ .,]/.test(ch) ? 0.28 : ch === "%" ? 0.85 : 0.52) * size, 0);

/** The before-and-after strip: four metrics as four pairs of figures, the
 *  before struck through in muted ink above the after set large in the
 *  accent, the change as a gold chip on the rail between them, and under
 *  the strip the source line a proof document carries beneath its numbers. */
const signature = {
  beforeAfter(K, i, c) {
    const g = K.paper;
    const t = type(K, g);
    const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
    const fill = [];
    const n = c.pairs.length;
    const gap = 24;
    const cw = (CW - (n - 1) * gap) / n;
    const y0 = bodyTop + 8;
    const goldInk = g.accent2Ink ?? g.accent2;
    c.pairs.forEach(([label, before, after, change, why], k) => {
      const x = M + k * (cw + gap);
      if (k) nodes.push(rect(x - gap / 2, y0, 1, 480, g.line));
      nodes.push(text(x, y0, cw, 34, label, t.strong(24)));
      // Before: the old figure in muted ink, a rule struck through it.
      nodes.push(text(x, y0 + 58, cw, 22, "Before", t.eyebrow({ size: 14, letterSpacing: 3, color: g.muted })));
      nodes.push(text(x, y0 + 86, cw, 66, before, t.numeral(60, { color: g.muted })));
      fill.push({ node: nodes.length - 1, label: `${label}, before`, hint: "The figure before" });
      nodes.push(rect(x - 6, y0 + 126, Math.round(figureWidth(before, 60)) + 12, 4, g.muted, { radius: 2 }));
      // The rail from the old figure toward the new one, and the change as
      // a gold chip sitting on it.
      nodes.push(rect(x + 79, y0 + 156, 2, 68, g.line));
      nodes.push(button(x, y0 + 166, 160, 40, change, { fill: mixHex(g.panel, g.accent2, 0.3), color: goldInk, family: K.body, size: 18, weight: 700 }));
      // After: the figure now, large, in the accent.
      nodes.push(text(x, y0 + 228, cw, 22, "After", t.eyebrow({ size: 14, letterSpacing: 3 })));
      nodes.push(text(x, y0 + 256, cw, 108, after, t.numeral(100)));
      fill.push({ node: nodes.length - 1, label: `${label}, after`, hint: "The figure now" });
      nodes.push(text(x, y0 + 380, cw - 16, 116, why, t.body(20)));
    });
    // The source line every proof carries, under a gold tick.
    const sy = y0 + 520;
    nodes.push(rect(M, sy, CW, 1, g.line));
    nodes.push(rect(M, sy, 56, 3, g.accent2));
    nodes.push(text(M, sy + 20, 1100, 26, c.source, t.meta()));
    nodes.push(...note(K, g, c.note));
    return { page: { name: "Before and after", bg: g.bg, nodes }, fill };
  },
};

export default {
  id: "deck-case-study",
  title: "Customer Case Study",
  base: "atlas",
  rank: 42,
  tags: [
    "case study",
    "customer",
    "proof",
    "sales"
  ],
  meta: {
    company: "Northwind Systems",
    deck: "Case study: Brightline Logistics",
    kicker: "One customer, in their own numbers",
    farewell: "The pattern repeats",
    art: {
      cover: "il-day14-forklift",
      section: "il-day37-calculator",
      picture: "la-guy-with-glasses",
      closing: "il-day17-walkie-talkie"
    }
  },
  look: {
    display: "Literata", dw: 700,
    body: "Fira Sans", bw: 400,
    mono: null,
    accentFace: "Homemade Apple", accentWeight: 400, accentSize: 36,
    charWidth: 0.57,
    paper: { bg: "#FFFFFF", ink: "#0E1B45", muted: "#4A5674", line: "#DCE1EE", panel: "#F3F5FB", panel2: "#E7ECF7", accent: "#1F3FBF", accent2: "#C99A22", accent2Ink: "#8A6512", sun: "#E9B949" },
    deep: { bg: "#1D3FA8", bg2: "#0D1F5E", ink: "#FFFFFF", muted: "#C5D0F2", line: "#3B5BC2", panel: "#2847AD", panel2: "#3558C4", accent: "#F2C65C", accent2: "#A9C1F5", sun: "#F2C65C" },
    radius: 4,
    ornament: "hairlines",
    peeps: ["op-peep-2", "op-peep-11", "op-peep-16", "op-peep-33", "op-peep-50"],
    scale: { cover: 104, title: 60, section: 236, statement: 80, numeral: 100, quote: 52 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "Brightline Logistics:\nfrom four days to one",
        subtitle: "A four-day payroll run brought down to one, and the eight weeks behind it.",
        presenterName: "Elena Sato, Customer Success",
        when: "October 2026",
        where: "Brightline HQ, Rotterdam"
      }
    ],
    [
      "facts",
      {
        eyebrow: "The customer",
        title: "Who Brightline are",
        intro: "Regional freight across Europe, with a growing last-mile fleet. Third generation, family owned, run from Rotterdam.",
        items: [
          ["truck", "4,200 vehicles in twelve countries", "Regional freight and last mile"],
          ["user", "3,800 drivers, paid every two weeks", "Hourly, salaried and contractor, in nine currencies"],
          ["coin", "$1.2B in annual revenue", "Family owned, third generation"],
          ["briefcase", "A finance team of six", "Payroll across all of it, before"]
        ],
        art: "il-day65-city-road",
        note: "six people. remember that number."
      }
    ],
    [
      "twoColumns",
      {
        eyebrow: "The challenge",
        title: "The situation before, and what it cost",
        left: {
          eyebrow: "Before",
          head: "Five systems and a spreadsheet",
          lines: [
            "Timesheets from three telematics vendors",
            "Every country a separate export",
            "Errors found by drivers, after payday"
          ],
          icon: "alert-triangle"
        },
        right: {
          eyebrow: "The cost",
          head: "Four days a fortnight, and trust",
          lines: [
            "$380K a year in finance time",
            "Two payroll disputes a week",
            "A union complaint in March"
          ],
          icon: "coin"
        },
        note: "the union letter reached the CFO's desk"
      }
    ],
    [
      "section",
      {
        n: "",
        title: "What we did",
        blurb: "Connect the feeds read-only, run two payrolls in the shadows, then go live a country at a time.",
        kicker: "Eight weeks, start to finish",
        art: "il-day37-calculator",
        note: "we ran beside the old process, twice"
      }
    ],
    [
      "timeline",
      {
        eyebrow: "The solution",
        title: "What we deployed, and how fast",
        done: 4,
        steps: [
          [
            "Week 1",
            "Connected",
            "Three telematics feeds and the HR system, read-only, mirrored against the old process."
          ],
          [
            "Weeks 2 to 3",
            "Shadow runs",
            "Two full payroll cycles run in parallel. Every difference explained before go-live."
          ],
          [
            "Week 4",
            "Two countries live",
            "The Netherlands and Germany, with the finance team watching every line."
          ],
          [
            "Week 8",
            "Live everywhere",
            "All twelve countries, nine currencies, one run."
          ]
        ],
        note: "week four was the one everyone watched"
      }
    ],
    [
      "raw",
      {
        build: signature.beforeAfter,
        eyebrow: "The results",
        title: "Before and after",
        pairs: [
          ["Payroll run", "4 days", "1 day", "−3 days", "The finance team closes payroll on a Tuesday afternoon."],
          ["Error rate", "3.1%", "0.2%", "−94%", "Errors caught before the run, not after payday."],
          ["Disputes a week", "2", "0", "−100%", "Drivers see their hours before they are paid."],
          ["Finance time a year", "$380K", "$70K", "−$310K", "Before counting the disputes that no longer happen."]
        ],
        source: "Brightline finance: the six payroll cycles after go-live, against the twelve months before.",
        note: "zero is the number Rowan quotes first"
      }
    ],
    [
      "quote",
      {
        text: "We did not buy software. We bought back four days a fortnight, and the drivers' trust that their pay would be right.",
        name: "Rowan Achebe",
        role: "Chief Financial Officer, Brightline Logistics"
      }
    ],
    [
      "textPicture",
      {
        eyebrow: "Why it worked",
        title: "The pattern that repeats",
        points: [
          ["Read-only first", "Every feed connected before anything changed. Nobody had to trust us on day one."],
          ["Two shadow cycles", "The old run and ours, side by side, until every difference had a name."],
          ["A country at a time", "Two live in week four, twelve by week eight, the same finance team of six."]
        ],
        art: "la-guy-with-glasses",
        note: "same three steps, every fleet so far"
      }
    ],
    [
      "closing",
      {
        title: "What this means for you",
        subtitle: "Every fleet operator we have deployed follows the same pattern: connect, shadow, go live. Eight weeks, start to finish.",
        rows: [
          ["mail", "elena@northwind.example"],
          ["world", "northwind.example/brightline"],
          ["calendar", "Book a thirty-minute walkthrough"]
        ],
        cta: "Talk to us",
        art: "il-day17-walkie-talkie",
        note: "bring your payroll calendar"
      }
    ]
  ]
};
