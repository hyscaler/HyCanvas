// Budget Review: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: ink blue and mint on an off-white ground, a serif for titles, a
// mono for every figure and label, a hand face for the notes. Ledger-like
// and tidy, built for a room that has to decide something. The signature
// slide is the ledger itself: plan, actual and variance as three aligned
// columns of mono figures, a tinted band on every over-plan row and a sum
// line at the bottom.

import { text, rect, button, chrome, note, type, mixHex, M, CW } from "../lib/deck-kit.mjs";

// --- the ledger ------------------------------------------------------------

const LEDGER = {
  eyebrow: "Variances",
  title: "Line by line against plan",
  cols: ["Cost line", "Plan", "Actual", "Variance", "Why"],
  units: "All figures in $K",
  rows: [
    ["Headcount", "12,400", "11,200", "−1,200", "14 roles open; hiring ran two months behind"],
    ["Cloud and infrastructure", "2,900", "3,540", "+640", "Usage grew 22%; reserved capacity bought late"],
    ["Travel and events", "1,000", "1,310", "+310", "Two conferences and the Lisbon office opening"],
    ["Software and tooling", "900", "800", "−100", "Two renewals negotiated down at term"],
    ["Marketing programs", "1,400", "1,450", "+50", "The Q2 campaign pulled forward a month"],
    ["Facilities and other", "600", "300", "−300", "The Lisbon fit-out slipped into H2"],
  ],
  total: ["Total, first half", "19,200", "18,600", "−600", "97% of plan"],
  legend: ["over plan", "under plan"],
  note: "the unders are timing, the overs are real",
};

/** The ledger: a reading page whose body is one table of mono figures.
 *  Every row carries a colour at its left edge, mint for over plan and blue
 *  for under, and the over rows sit on a mint band. The sum line closes it. */
function ledger(K, i) {
  const g = K.paper;
  const t = type(K, g);
  const c = LEDGER;
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
  const fill = [{ node: nodes.findIndex((n) => n.text === c.title), label: "Title", hint: "One short line" }];
  const mono = K.mono ?? K.body;
  const fig = (size, o = {}) => ({ family: mono, size, weight: 500, color: g.ink, align: "right", lineHeight: 1.1, ...o });
  const colX = [M, 580, 800, 1020, 1290];
  const colW = [464, 200, 200, 220, 534];
  const rowH = 76;
  const headY = bodyTop;
  c.cols.forEach((h, k) => {
    const right = k >= 1 && k <= 3;
    nodes.push(text(colX[k], headY, colW[k], 28, h, t.eyebrow({ size: 17, letterSpacing: 3, align: right ? "right" : "left" })));
  });
  nodes.push(text(colX[4], headY + 2, colW[4], 26, c.units, t.meta({ size: 16, align: "right" })));
  nodes.push(rect(M, headY + 40, CW, 2, g.ink));
  const y0 = headY + 50;
  c.rows.forEach(([label, plan, actual, variance, why], k) => {
    const y = y0 + k * rowH;
    const over = variance.startsWith("+");
    if (over) nodes.push(rect(M, y, CW, rowH, mixHex(g.panel, g.accent2, 0.12)));
    nodes.push(rect(M, y + 8, 4, rowH - 16, over ? g.accent2 : g.accent, { radius: 2 }));
    nodes.push(text(colX[0] + 24, y + 22, colW[0] - 24, 34, label, t.strong(24)));
    nodes.push(text(colX[1], y + 22, colW[1], 34, plan, fig(28, { color: g.muted })));
    nodes.push(text(colX[2], y + 22, colW[2], 34, actual, fig(28)));
    nodes.push(text(colX[3], y + 22, colW[3], 34, variance, fig(28, { weight: 600, color: over ? g.accent2 : g.accent })));
    nodes.push(text(colX[4], y + 24, colW[4], 30, why, t.body(20)));
    nodes.push(rect(M, y + rowH - 1, CW, 1, g.line));
  });
  // The sum line: a heavier rule, the totals a size up, the plan ratio as a pill.
  const ty = y0 + c.rows.length * rowH + 12;
  nodes.push(rect(M, ty, CW, 3, g.accent));
  const sy = ty + 18;
  const [tl, tp, ta, tv, tr] = c.total;
  nodes.push(text(colX[0], sy + 2, colW[0], 40, tl, t.display(28)));
  nodes.push(text(colX[1], sy, colW[1], 40, tp, fig(32, { weight: 600, color: g.muted })));
  nodes.push(text(colX[2], sy, colW[2], 40, ta, fig(32, { weight: 600 })));
  nodes.push(text(colX[3], sy, colW[3], 40, tv, fig(32, { weight: 600, color: g.accent })));
  nodes.push(button(colX[4], sy, 196, 40, tr, { fill: mixHex(g.panel, g.accent, 0.16), color: g.accent, family: K.body, size: 17, weight: 700 }));
  // The legend, under the sum, in the two row colours.
  const ly = sy + 84;
  nodes.push(rect(M, ly + 6, 14, 14, g.accent2, { radius: 2 }));
  nodes.push(text(M + 26, ly, 240, 28, c.legend[0], t.meta()));
  nodes.push(rect(M + 200, ly + 6, 14, 14, g.accent, { radius: 2 }));
  nodes.push(text(M + 226, ly, 240, 28, c.legend[1], t.meta()));
  nodes.push(...note(K, g, c.note));
  return { page: { name: "Ledger", bg: g.bg, nodes }, fill };
}

const signature = { ledger };

export default {
  id: "deck-budget-review",
  title: "Budget Review",
  base: "atlas",
  rank: 88,
  tags: [
    "budget",
    "finance",
    "review",
    "planning"
  ],
  meta: {
    company: "Cobalt Health",
    deck: "Budget review, H1 2026",
    kicker: "Spend against plan",
    farewell: "Decision today",
    art: {
      cover: "il-day36-abacus",
      section: "il-day6-open-vault",
      picture: "il-day37-calculator",
      closing: "il-day5-vault"
    }
  },
  look: {
    display: "Newsreader", dw: 600,
    body: "Public Sans", bw: 400,
    mono: "DM Mono",
    accentFace: "Architects Daughter", accentWeight: 400, accentSize: 34,
    paper: { bg: "#F6F7F3", ink: "#12284A", muted: "#4B5B72", line: "#D4DBD6", panel: "#ECF1EC", panel2: "#DFE8E1", accent: "#1E4C8F", accent2: "#1E7860" },
    deep: { bg: "#10305A", bg2: "#081B36", ink: "#F3F6F1", muted: "#AEBCCB", line: "#27456E", panel: "#183B69", panel2: "#1F4676", accent: "#7FDDC0", accent2: "#9CC6F2", accentInk: "#93E6CC" },
    radius: 4,
    ornament: "dots",
    peeps: ["op-peep-31", "op-peep-44", "op-peep-67", "op-peep-77", "op-peep-94"],
    scale: { cover: 112, title: 62, section: 236, statement: 80, numeral: 104, quote: 54 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "Where the\nmoney went",
        subtitle: "Actuals against plan for the first half, the variances that matter, and one reallocation to approve.",
        presenter: "Dana Whitfield, Finance Director  ·  15 July 2026",
        note: "one ledger, one decision, no surprises"
      }
    ],
    [
      "figures",
      {
        eyebrow: "The picture",
        title: "First half against plan",
        stats: [
          [
            "$18.6M",
            "Total spend",
            "97% of plan",
            "Under plan in headcount, over in cloud and travel."
          ],
          [
            "$640K",
            "Cloud overspend",
            "+22% vs plan",
            "Usage grew faster than forecast; reserved capacity was bought late."
          ],
          [
            "$1.2M",
            "Headcount underspend",
            "14 roles open",
            "Hiring ran two months behind; the gap closes by October."
          ],
          [
            "$310K",
            "Travel overspend",
            "+31% vs plan",
            "Two conferences and the Lisbon office opening."
          ]
        ],
        note: "97% of plan, but not evenly"
      }
    ],
    [
      "chart",
      {
        eyebrow: "Where the money went",
        title: "Actuals by department",
        takeaway: "Engineering and sales are under plan on people; platform is over on infrastructure.",
        chartType: "barGrouped",
        categories: [
          "Eng",
          "Sales",
          "Platform",
          "Marketing",
          "G&A"
        ],
        series: [
          {
            name: "Plan",
            values: [
              6.2,
              4.8,
              3.1,
              2.9,
              2.2
            ]
          },
          {
            name: "Actual",
            values: [
              5.6,
              4.4,
              3.7,
              3,
              1.9
            ]
          }
        ],
        calls: [
          [
            "−$1.0M",
            "Under plan across engineering and sales"
          ],
          [
            "+$600K",
            "Over plan in platform, all cloud"
          ],
          [
            "$18.6M",
            "Total, 97% of plan"
          ]
        ],
        note: "platform's bar is the one to watch"
      }
    ],
    [
      "raw",
      {
        build: signature.ledger
      }
    ],
    [
      "section",
      {
        n: "$1.2M",
        kicker: "The reallocation",
        title: "What we move",
        blurb: "Real money sitting idle until the hires land. Three moves put it to work, all inside the line.",
        art: "il-day6-open-vault",
        note: "nothing new asked for, only moved"
      }
    ],
    [
      "threeCards",
      {
        eyebrow: "Reallocation proposal",
        title: "What we move, and what it buys",
        cards: [
          [
            "database",
            "Reserve cloud capacity now",
            "Move $400K of the headcount underspend to reserved instances. Saves $180K in H2 against on-demand pricing."
          ],
          [
            "user",
            "Fund two of the open roles as contractors",
            "Bridge the platform gap for six months while the hires land. $260K, fully within the underspend."
          ],
          [
            "plane",
            "Cap travel for H2",
            "Conference attendance by approval only. Brings the line back to plan by December."
          ]
        ],
        note: "all three fit inside the $1.2M"
      }
    ],
    [
      "timeline",
      {
        eyebrow: "The path back",
        title: "When the lines come back to plan",
        done: 1,
        steps: [
          [
            "July",
            "Reserve the cloud",
            "Reserved instances bought the week this is approved. The saving starts in August."
          ],
          [
            "August",
            "Contractors start",
            "Two platform contractors on six-month terms, funded from the underspend."
          ],
          [
            "October",
            "Hires land",
            "The fourteen open roles close and the headcount line returns to plan."
          ],
          [
            "December",
            "Travel on plan",
            "Approval-only conferences bring the travel line back by year end."
          ]
        ],
        note: "every date here has an owner in the workbook"
      }
    ],
    [
      "closing",
      {
        title: "The decision",
        subtitle: "Approve the reallocation as proposed, adjust the amounts, or defer to the September review.",
        rows: [
          [
            "mail",
            "dana@cobalthealth.example"
          ],
          [
            "file-text",
            "Full variance workbook attached"
          ],
          [
            "calendar",
            "Next review: 16 September"
          ]
        ],
        cta: "Approve the proposal",
        art: "il-day5-vault",
        note: "the cloud saving starts the week we sign"
      }
    ]
  ]
};
