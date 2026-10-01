// Startup Pitch Deck: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look is a pitch poster. White paper with cobalt for everything set in
// the accent and a darker coral for the second tone; a cobalt gradient that
// runs to navy on the deep pages, where lime takes over as the accent. A
// heavy geometric display for titles and figures, a plain grotesk for
// reading, a mono for labels and the footer, and a marker pen for the
// kicker and the margin notes. The ornament is one corner triangle: lime on
// cobalt, cobalt on white. Loud in one place per slide, quiet everywhere
// else.

import { text, rect, footer, ornamentPaper, type, W, M, CW } from "../lib/deck-kit.mjs";

const PAPER = { bg: "#FFFFFF", ink: "#0B1340", muted: "#4A5480", line: "#DFE3F2", panel: "#F2F4FC", panel2: "#E6EAF8", accent: "#0B3BD6", accent2: "#FF5A3A", accent2Ink: "#C2381A", lime: "#C9F23D" };
const DEEP = { bg: "#0E3ED6", bg2: "#071C6E", ink: "#FFFFFF", muted: "#CCD5FF", line: "#3A62E6", panel: "#1B4AE0", panel2: "#2757EA", accent: "#CDF546", accent2: "#FF6B4A", accent2Ink: "#FFC2B3", lime: "#CDF546" };

/** The one-liner: the pitch as one sentence at poster size across the whole
 *  page, one line of it on a lime band that runs edge to edge, and the three
 *  proof figures as chips underneath. Nothing else. */
function oneLiner(K, i) {
  const g = K.paper;
  const t = type(K, g);
  const nodes = [...ornamentPaper(K, g), ...footer(K, g, i)];
  const fill = [];
  nodes.push(text(M, 88, 1200, 28, `${K.company}, in one sentence`, t.eyebrow()));
  fill.push({ node: nodes.length - 1, label: "Eyebrow", hint: "Whose sentence this is" });

  // Four phrases, each its own line, so the claim can sit on the band. The
  // block starts below the corner triangle's tip (y 294) so the band clears it.
  const lines = ["Mid-market payroll,", "closed in one afternoon,", "in every country,", "with no spreadsheets."];
  const size = 108;
  const lineH = Math.round(size * 1.1);
  const y0 = 220;
  const band = 1;
  nodes.push(rect(0, y0 + band * lineH - 6, W, lineH + 12, g.lime, { bleed: true }));
  lines.forEach((l, k) => {
    nodes.push(text(M, y0 + k * lineH, CW, lineH, l, t.display(size, { color: g.accent })));
    fill.push({ node: nodes.length - 1, label: `Line ${k + 1}`, hint: k === band ? "The claim; this line sits on the band" : "One phrase of the sentence" });
  });

  // The proof: three figures as chips, left to right.
  const chips = [["$312K", "monthly revenue"], ["121%", "net retention"], ["6.5x", "growth in a year"]];
  const cy = y0 + lines.length * lineH + 84;
  const gap = 24, ch = 96;
  const cw = (CW - 2 * gap) / 3;
  chips.forEach(([n, l], k) => {
    const x = M + k * (cw + gap);
    nodes.push(rect(x, cy, cw, ch, g.panel, { radius: 48, stroke: g.line, strokeWidth: 1.5 }));
    nodes.push(text(x + 44, cy + 22, 200, 52, n, t.numeral(40)));
    fill.push({ node: nodes.length - 1, label: `Figure ${k + 1}`, hint: "One number that proves the sentence" });
    nodes.push(text(x + 256, cy + 35, cw - 296, 30, l, t.meta({ size: 19 })));
    fill.push({ node: nodes.length - 1, label: `Label ${k + 1}`, hint: "What it measures" });
  });
  return { page: { name: "The one-liner", bg: g.bg, nodes }, fill };
}

const signature = { oneLiner };

export default {
  id: "deck-startup-pitch",
  title: "Startup Pitch Deck",
  base: "pulse",
  rank: 30,
  tags: [
    "pitch deck",
    "startup",
    "fundraising",
    "investors"
  ],
  meta: {
    company: "Loop",
    deck: "Seed round",
    kicker: "Seed round",
    farewell: "Let's build it",
    art: {
      cover: "il-day5-vault",
      section: "il-day37-calculator",
      picture: "il-day94-ui-ux",
      closing: "il-day6-open-vault"
    }
  },
  look: {
    display: "Gabarito", dw: 900,
    body: "Instrument Sans", bw: 400,
    mono: "Azeret Mono",
    accentFace: "Permanent Marker", accentWeight: 400, accentSize: 32,
    paper: PAPER,
    deep: DEEP,
    radius: 12,
    ornament: "corner",
    peeps: ["op-peep-10", "op-peep-28", "op-peep-43", "op-peep-54", "op-peep-70"],
    scale: { cover: 118, title: 62, section: 236, statement: 80, numeral: 104, quote: 50 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "Payroll that\ncloses itself",
        subtitle: "We make month-end payroll for mid-sized companies a one-click job, ten times faster than the tools built for a different era.",
        presenter: "Sam Whitfield and Priya Raman, founders  ·  October 2026",
        note: "our own payroll runs on Loop, since month two"
      }
    ],
    [
      "raw",
      { build: signature.oneLiner }
    ],
    [
      "quote",
      {
        pageName: "The problem",
        text: "Four days a month on a job a computer\nshould finish in an hour. We were the\nmost expensive spreadsheet in the building.",
        name: "Dana Kowalski",
        role: "Controller, Harbor Health Staffing, now customer number one",
        note: "one of forty-one interviews, spring 2026"
      }
    ],
    [
      "twoColumns",
      {
        eyebrow: "The problem and the solution",
        title: "What month-end looks like, before and after",
        left: {
          eyebrow: "Today",
          head: "Five tools, four days, one exhausted controller",
          lines: [
            "Timesheets exported by hand",
            "Corrections found after the run",
            "Every country a separate spreadsheet"
          ],
          icon: "alert-triangle"
        },
        right: {
          eyebrow: "With Loop",
          head: "One workflow, one afternoon",
          lines: [
            "Every source connected once",
            "Errors caught before the run, not after",
            "Set up in minutes, not months"
          ],
          icon: "circle-check"
        },
        note: "the left column is a real customer's October"
      }
    ],
    [
      "textPicture",
      {
        eyebrow: "The product",
        title: "One workflow, three steps",
        points: [
          [
            "Connect once",
            "Timesheets, HR and benefits plug in the first afternoon; every country lands in the same run."
          ],
          [
            "Catch it before the run",
            "Every line is checked against last month and flagged before any money moves."
          ],
          [
            "Close with one click",
            "Approve, pay and file in one step; the ledger entries post themselves."
          ]
        ],
        art: "il-day94-ui-ux",
        note: "step two is where the four days go"
      }
    ],
    [
      "figures",
      {
        eyebrow: "Market size",
        title: "A large market, counted bottom up",
        stats: [
          [
            "$14B",
            "Serviceable market",
            "Bottom-up",
            "Companies of 50 to 2,000 people, times realistic seat pricing."
          ],
          [
            "68K",
            "Target companies",
            "Three regions",
            "Mid-market payroll is underserved by both ends of the market."
          ],
          [
            "$18K",
            "Average contract",
            "Year one",
            "Grows with headcount; every hire is a seat."
          ],
          [
            "3",
            "Segments pulling us in",
            "Inbound",
            "Logistics, healthcare staffing and franchise retail found us first."
          ]
        ],
        note: "seats times price, not a top-down slice"
      }
    ],
    [
      "chart",
      {
        eyebrow: "Traction",
        title: "Revenue, twelve months",
        takeaway: "Consistent growth every month, retention above the category benchmark, and customers expanding on their own.",
        categories: [
          "Q4 25",
          "Q1 26",
          "Q2 26",
          "Q3 26"
        ],
        series: [
          {
            name: "MRR ($K)",
            color: PAPER.accent,
            values: [
              48,
              96,
              178,
              312
            ]
          }
        ],
        calls: [
          [
            "$312K",
            "Monthly revenue, up 6.5x in a year"
          ],
          [
            "121%",
            "Net revenue retention"
          ],
          [
            "11",
            "Customers expanded without a sales call"
          ]
        ],
        note: "cash collected, not bookings"
      }
    ],
    [
      "team",
      {
        eyebrow: "The team",
        title: "Founders who lived this problem",
        people: [
          [
            "Sam Whitfield",
            "Chief Executive",
            "Ran payroll for a 900-person company for six years. Built Loop to never do it again."
          ],
          [
            "Priya Raman",
            "Chief Technology Officer",
            "Led the payments platform at a category leader; scaled it past a million runs a month."
          ],
          [
            "Marcus Obi",
            "Head of Sales",
            "First sales hire at two mid-market SaaS companies, both to $20M."
          ],
          [
            "Elena Sato",
            "Head of Customers",
            "Onboarded four hundred finance teams. Knows every month-end horror story."
          ]
        ],
        note: "everyone here has fixed a payroll at 2am"
      }
    ],
    [
      "closing",
      {
        title: "The ask",
        subtitle: "Raising $6M to accelerate what already works: two more regions, the compliance team, and the partner channel.",
        rows: [
          [
            "mail",
            "sam@loop.example"
          ],
          [
            "world",
            "loop.example/investors"
          ],
          [
            "calendar",
            "Closing the round by December"
          ]
        ],
        cta: "Open the data room",
        note: "the lead is in; filling the rest by December"
      }
    ]
  ]
};
