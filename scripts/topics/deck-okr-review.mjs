// OKR Review: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: a scoreboard in a stadium at night. Midnight blue under electric
// orange, a cool grey for everything that is not a score, a geometric sans
// for titles and a squared signage face for the kicker, the notes and the
// digits on the board. Floodlight stripes as the ornament.

import { text, rect, button, footer, ornamentDeep, type, deepGround, mixHex, inkOn, M, CW } from "../lib/deck-kit.mjs";

// A key result scores 0.0 to 1.0. At 0.7 and above it is a hit (the target
// was hard and we got there); 0.4 to 0.6 is close; below that a miss.
const band = (s) => (s >= 0.7 ? "hit" : s >= 0.4 ? "close" : "miss");

const signature = {
  /** The scoreboard: three objectives as three wide rows, each with its key
   *  results as scored chips coloured by band, and the objective score at
   *  the right as one big numeral in the signage face. */
  scoreboard(K, i) {
    const g = K.deep;
    const t = type(K, g);
    const nodes = [...ornamentDeep(K, g)];
    const fill = [];
    const orange = g.accentInk ?? g.accent;
    const tone = { hit: orange, close: g.accent2, miss: g.muted };
    const digits = (size, color, o = {}) => ({ family: K.accentFace, size, weight: 700, color, lineHeight: 1, ...o });

    nodes.push(text(M, 96, 1000, 28, "Q3 2026  ·  Final scores", t.eyebrow()));
    nodes.push(text(M, 132, 1100, 72, "Nine key results, average 0.71", t.display(54)));
    fill.push({ node: nodes.length - 1, label: "Title", hint: "The quarter in one line" });

    // The legend, at the title's height on the right.
    const legend = [["hit", "0.7 to 1.0, hit"], ["close", "0.4 to 0.6, close"], ["miss", "below 0.4, miss"]];
    legend.forEach(([b, label], k) => {
      const x = 1196 + k * 212;
      const sw = b === "hit" ? { fill: orange, stroke: orange } : b === "close" ? { fill: g.panel2, stroke: g.accent2 } : { fill: g.panel, stroke: g.line };
      nodes.push(rect(x, 152, 18, 18, sw.fill, { radius: 4, stroke: sw.stroke, strokeWidth: 2 }));
      nodes.push(text(x + 28, 148, 184, 26, label, t.meta({ size: 17 })));
    });

    const rows = [
      ["O1", "Make the platform boring to run", "Strong", 0.87, [["Uptime", "99.97% of 99.95%", 1.0], ["P95 latency", "cut 41% of 30%", 1.0], ["On-call pages", "14 a week of 10", 0.6]]],
      ["O2", "Win the self-serve upgrade", "Behind", 0.6, [["Conversion", "4.8% of 6%", 0.5], ["Self-serve MRR", "$92K of $120K", 0.6], ["Upgrades", "31 a week of 40", 0.7]]],
      ["O3", "Ship the enterprise bundle", "Mixed", 0.67, [["SSO and SCIM", "shipped on time", 1.0], ["Pilots", "3 of 5", 0.5], ["Residency", "EU of EU and APAC", 0.5]]],
    ];
    const rowH = 208, gap = 20, y0 = 232;
    rows.forEach(([n, title, verdict, score, krs], r) => {
      const y = y0 + r * (rowH + gap);
      const x = M;
      const objTone = tone[band(score)];
      nodes.push(rect(x, y, CW, rowH, g.panel, { radius: K.radius, stroke: g.line, strokeWidth: 1.5 }));
      nodes.push(rect(x, y + 24, 6, rowH - 48, objTone, { radius: 3 }));
      nodes.push(text(x + 36, y + 30, 120, 24, n, t.eyebrow({ size: 17, color: objTone })));
      nodes.push(text(x + 36, y + 60, 470, 74, title, t.display(30, { lineHeight: 1.1 })));
      fill.push({ node: nodes.length - 1, label: `Objective ${r + 1}`, hint: "The objective, in a few words" });
      nodes.push(button(x + 36, y + 146, 124, 34, verdict, { fill: mixHex(g.panel, objTone, 0.22), color: objTone, family: K.body, size: 15, weight: 700 }));

      // The key results as chips, coloured by band.
      krs.forEach(([label, actual, s], k) => {
        const b = band(s);
        const cx = x + 560 + k * 256, cy = y + 36, cw = 236, ch = 136;
        const chipFill = b === "hit" ? orange : b === "close" ? g.panel2 : mixHex(g.panel, g.bg, 0.5);
        const chipStroke = b === "hit" ? orange : b === "close" ? g.accent2 : g.line;
        const ink = b === "hit" ? inkOn(K, orange) : g.ink;
        const sub = b === "hit" ? mixHex(inkOn(K, orange), orange, 0.3) : g.muted;
        const digit = b === "hit" ? inkOn(K, orange) : tone[b];
        nodes.push(rect(cx, cy, cw, ch, chipFill, { radius: K.radius, stroke: chipStroke, strokeWidth: 1.5 }));
        nodes.push(text(cx + 18, cy + 16, cw - 36, 24, label, { family: K.body, size: 18, weight: 600, color: ink, lineHeight: 1.2 }));
        nodes.push(text(cx + 18, cy + 42, cw - 36, 22, actual, { family: K.body, size: 15, weight: 500, color: sub, lineHeight: 1.2 }));
        nodes.push(text(cx + 18, cy + 68, cw - 36, 44, s.toFixed(1), digits(40, digit)));
        nodes.push(rect(cx + 18, cy + 118, cw - 36, 4, b === "hit" ? mixHex(orange, inkOn(K, orange), 0.25) : g.line, { radius: 2 }));
        nodes.push(rect(cx + 18, cy + 118, Math.round((cw - 36) * s), 4, digit, { radius: 2 }));
      });

      // The objective score, big, at the right.
      nodes.push(text(x + 1380, y + 28, 312, 124, score.toFixed(2), digits(112, objTone, { align: "right" })));
      fill.push({ node: nodes.length - 1, label: `Objective ${r + 1} score`, hint: "0.0 to 1.0" });
      nodes.push(text(x + 1380, y + 156, 312, 24, "objective score", t.meta({ size: 16, align: "right" })));
    });

    nodes.push(...footer(K, g, i));
    return { page: { name: "Scoreboard", bg: deepGround(g), nodes }, fill };
  },
};

export default {
  id: "deck-okr-review",
  title: "OKR Review",
  base: "vanta",
  rank: 52,
  tags: [
    "okr",
    "goals",
    "review",
    "metrics"
  ],
  meta: {
    company: "Nova Systems",
    deck: "OKR review, Q3 2026",
    kicker: "Scored honestly",
    farewell: "Next quarter, same board",
    art: {
      cover: "il-103-gym-time",
      section: "il-day36-abacus",
      picture: "il-day76-watch-spectacle",
      closing: "il-day11-blackboard"
    }
  },
  look: {
    display: "Urbanist", dw: 800,
    body: "Albert Sans", bw: 400,
    mono: null,
    accentFace: "Chakra Petch", accentWeight: 600, accentSize: 32,
    paper: { bg: "#F3F5F9", ink: "#0C1636", muted: "#586380", line: "#D6DCE8", panel: "#E9EDF4", panel2: "#DDE3EE", accent: "#FF6A1A", accent2: "#2B4DB8", accentInk: "#B04000" },
    deep: { bg: "#10204F", bg2: "#070D25", ink: "#F3F5F9", muted: "#A9B3CC", line: "#27396E", panel: "#182C62", panel2: "#213874", accent: "#FF7A2E", accent2: "#7EAEFF", accentInk: "#FF9450" },
    radius: 10,
    ornament: "stripes",
    peeps: ["op-peep-2", "op-peep-16", "op-peep-31", "op-peep-44", "op-peep-68"],
    scale: { cover: 112, title: 60, section: 230, statement: 76, numeral: 100, quote: 52 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "Three objectives,\nscored",
        subtitle: "What we set out to do in Q3, how far we got, and which targets were wrong versus which execution was.",
        presenter: "Priya Raman, Head of Product  ·  2 October 2026",
        note: "nine results, no rounding up"
      }
    ],
    [
      "raw",
      { build: signature.scoreboard }
    ],
    [
      "statement",
      {
        text: "A 0.7 is a good quarter. A 1.0 every time means the targets were never hard.",
        source: "How we score, from the Nova OKR handbook",
        note: "we grade the target too, not just the team"
      }
    ],
    [
      "figures",
      {
        eyebrow: "Objective one",
        title: "Make the platform boring to run",
        stats: [
          [
            "99.97%",
            "Uptime",
            "Target 99.95%",
            "Scored 1.0. Two incidents, both under fifteen minutes."
          ],
          [
            "−41%",
            "P95 latency",
            "Target −30%",
            "Scored 1.0. The cache layer landed in August."
          ],
          [
            "14",
            "Pages on call per week",
            "Target 10",
            "Scored 0.6. Alert noise from the new region."
          ],
          [
            "0.87",
            "Objective score",
            "Strong",
            "Reliability is no longer the conversation in customer calls."
          ]
        ],
        note: "the pager is the one we still owe"
      }
    ],
    [
      "chart",
      {
        eyebrow: "Objective two  ·  scored 0.6, behind",
        title: "Win the self-serve upgrade",
        takeaway: "Week by week across Q3, conversion climbed from 3.1% to 4.8% against a 6% target, and bent upward in week ten, the week the checkout redesign finally shipped. The target was right; the date was not.",
        chartType: "line",
        categories: ["W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8", "W9", "W10", "W11", "W12", "W13"],
        series: [
          { name: "Free to paid conversion by week, %", color: "#FF6A1A", values: [3.1, 3.2, 3.2, 3.3, 3.4, 3.4, 3.5, 3.6, 3.7, 4.3, 4.6, 4.7, 4.8] }
        ],
        calls: [
          ["4.8%", "Conversion at quarter end, target 6%. Scored 0.5"],
          ["$92K", "Self-serve MRR, target $120K, growing 11% a month. Scored 0.6"],
          ["31", "Upgrades a week, target 40. Scored 0.7"]
        ],
        note: "late by two months, not wrong"
      }
    ],
    [
      "timeline",
      {
        eyebrow: "Objective three  ·  scored 0.67, mixed",
        title: "Ship the enterprise bundle",
        done: 3,
        steps: [
          [
            "July",
            "SSO and SCIM",
            "Shipped on time; four customers live in the first week. Scored 1.0."
          ],
          [
            "August",
            "EU data residency",
            "Live in Frankfurt. APAC shared the key result and moved to Q1. Scored 0.5."
          ],
          [
            "September",
            "Three pilots of five",
            "Two slipped on the customer side; both rebooked for October. Scored 0.5."
          ],
          [
            "Q1 2027",
            "APAC residency",
            "Deferred, now with a second owner. The bundle is not done until it ships."
          ]
        ],
        note: "shipped it; now we have to sell it"
      }
    ],
    [
      "twoColumns",
      {
        eyebrow: "Lessons",
        title: "Wrong targets, or wrong execution?",
        left: {
          eyebrow: "Targets we set wrong",
          head: "Conversion at 6% assumed the redesign in July",
          lines: [
            "It shipped in September",
            "The number was right, the date was not",
            "Q4 keeps the target, moves the date"
          ],
          icon: "alert-triangle"
        },
        right: {
          eyebrow: "Execution we got wrong",
          head: "APAC residency waited on one person",
          lines: [
            "No backup owner for the region work",
            "Two weeks lost to a vacation",
            "Every key result now has a second owner"
          ],
          icon: "circle-check"
        },
        note: "one vacation should not move a quarter"
      }
    ],
    [
      "threeCards",
      {
        eyebrow: "Next quarter",
        title: "Draft objectives for debate",
        cards: [
          [
            "gauge",
            "Cut on-call pages in half",
            "Alert tuning first, then the noisy region. Owner: platform."
          ],
          [
            "sparkles",
            "Self-serve at 6% conversion",
            "Same target, the redesign is now live. Owner: growth."
          ],
          [
            "world",
            "APAC residency live by December",
            "Two owners, one date, weekly check. Owner: enterprise."
          ]
        ],
        note: "drafts, not decisions, until the 10th"
      }
    ],
    [
      "closing",
      {
        title: "Questions",
        subtitle: "Scores and the evidence behind each are in the tracker. Push back on the drafts before Friday.",
        rows: [
          [
            "mail",
            "priya@novasystems.example"
          ],
          [
            "world",
            "okr.novasystems.example"
          ],
          [
            "calendar",
            "Q4 objectives lock: 10 October"
          ]
        ],
        cta: "Open the tracker",
        note: "push back before Friday, please"
      }
    ]
  ]
};
