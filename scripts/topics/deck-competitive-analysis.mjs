// Competitive Analysis: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: graphite and signal red on white, a condensed grotesk for every
// title and figure, a mono for the labels, a marker for the hand notes. The
// wall of a war room: radar rings off the corner, red for what matters, and
// nothing decorative that does not carry a reading.

import { text, rect, ellipse, type, chrome, note, M, CW } from "../lib/deck-kit.mjs";

// --- the signature slide -------------------------------------------------------

/** The matrix: us against two rivals on six criteria, each cell a filled,
 *  half or empty disc, the criterion's buyer weight as a small bar beside
 *  the row, and the weighted score under every column. Our column carries a
 *  panel band with a red rule so the eye finds it first. */
const signature = {
  matrix(K, i) {
    const g = K.paper;
    const t = type(K, g);
    const mono = K.mono ?? K.body;
    const accentInk = g.accentInk ?? g.accent;
    const TITLE = "Six criteria, three players";
    const { nodes, bodyTop } = chrome(K, g, i, "The matrix", TITLE);
    const fill = [];
    fill.push({ node: nodes.findIndex((n) => n.kind === "text" && n.text === TITLE), label: "Title", hint: "What the matrix compares" });

    const players = ["Us", "Northlight", "Vantage"];
    // [criterion, what it means, buyer weight in percent, score per player: 1 full, 0.5 half, 0 none]
    const rows = [
      ["Time to first value", "pilot start to first live board", 30, [1, 0.5, 0.5]],
      ["Enterprise security", "SSO, audit log, data residency", 20, [1, 1, 0]],
      ["Data ownership", "open file format, self-hosting", 20, [1, 0, 0.5]],
      ["Integrations", "what buyers count in the demo", 10, [0.5, 1, 0.5]],
      ["Price at scale", "five hundred seats, year two", 10, [0.5, 0.5, 1]],
      ["AI assistant", "grounded, adopted, measured", 10, [0, 1, 0.5]],
    ];
    const maxW = Math.max(...rows.map((r) => r[2]));
    const scores = players.map((_, c) => rows.reduce((s, r) => s + r[2] * r[3][c], 0));

    // Geometry: the label column, the weight column, three player columns.
    const y0 = bodyTop, headH = 52, rowH = 84;
    const labelW = 500, weightX = 632, barW = 176, pctX = 824;
    const px0 = 942, colW = 294;
    const rowsEnd = y0 + headH + rows.length * rowH;
    const totalY = rowsEnd + 12, bandEnd = totalY + 72;

    // A disc: full, half (a covering rect in the row's ground, then the ring), or empty.
    const disc = (cx, cy, d, v, cover) => {
      const r = d / 2, out = [];
      if (v >= 1) return [ellipse(cx - r, cy - r, d, d, g.accent)];
      if (v > 0) { out.push(ellipse(cx - r, cy - r, d, d, g.accent)); out.push(rect(cx, cy - r - 1, r + 2, d + 2, cover)); }
      out.push(ellipse(cx - r, cy - r, d, d, undefined, { stroke: g.accent, strokeWidth: 2.5 }));
      return out;
    };

    // The legend, in the title row at right.
    [["meets it", 1], ["partly", 0.5], ["does not", 0]].forEach(([l, v], k) => {
      const x = 1344 + k * 160;
      nodes.push(...disc(x + 10, 152, 20, v, g.bg));
      nodes.push(text(x + 30, 138, 126, 26, l, t.meta({ size: 16 })));
    });

    // Our column: a panel band with a red rule on top, from the header to the score.
    nodes.push(rect(px0, y0, colW, bandEnd - y0, g.panel));
    nodes.push(rect(px0, y0, colW, 4, g.accent));

    // The header row.
    nodes.push(text(M, y0 + 16, 400, 26, "Criterion", t.eyebrow({ size: 16, letterSpacing: 3 })));
    nodes.push(text(weightX, y0 + 16, 260, 26, "Buyer weight", t.eyebrow({ size: 16, letterSpacing: 3 })));
    players.forEach((p, c) => {
      nodes.push(text(px0 + c * colW, y0 + 10, colW, 36, p, t.display(28, { align: "center", color: c === 0 ? accentInk : g.ink })));
      fill.push({ node: nodes.length - 1, label: c === 0 ? "Us" : `Rival ${c}`, hint: "Who is compared" });
    });
    nodes.push(rect(M, y0 + headH - 2, CW, 2, g.ink));

    // The rows: label and meaning, the weight bar and figure, one disc per player.
    rows.forEach(([label, sub, w, vals], k) => {
      const y = y0 + headH + k * rowH;
      nodes.push(text(M, y + 14, labelW, 32, label, t.strong(24)));
      fill.push({ node: nodes.length - 1, label: `Criterion ${k + 1}`, hint: "What buyers weigh" });
      nodes.push(text(M, y + 46, labelW, 24, sub, t.body(17)));
      nodes.push(rect(weightX, y + 35, barW, 14, g.panel2));
      nodes.push(rect(weightX, y + 35, Math.round((barW * w) / maxW), 14, g.accent));
      nodes.push(text(pctX, y + 29, 72, 26, `${w}%`, { family: mono, size: 18, weight: 600, color: g.ink, lineHeight: 1.2 }));
      vals.forEach((v, c) => nodes.push(...disc(px0 + c * colW + colW / 2, y + 42, 40, v, c === 0 ? g.panel : g.bg)));
      nodes.push(rect(M, y + rowH - 1, CW, 1, g.line));
    });

    // The weighted score under every column.
    nodes.push(rect(M, totalY - 6, CW, 2, g.ink));
    nodes.push(text(M, totalY + 14, labelW, 32, "Weighted score", t.strong(24)));
    nodes.push(text(M, totalY + 46, labelW, 24, "out of 100, by buyer weight", t.body(17)));
    scores.forEach((s, c) => {
      nodes.push(text(px0 + c * colW, totalY + 8, colW, 56, String(s), t.numeral(48, { align: "center", color: c === 0 ? accentInk : g.ink })));
    });

    nodes.push(...note(K, g, "weights come from the last twenty win-loss calls"));
    return { page: { name: "Matrix", bg: g.bg, nodes }, fill };
  },
};

export default {
  id: "deck-competitive-analysis",
  title: "Competitive Analysis",
  base: "slate",
  rank: 56,
  tags: [
    "competitive",
    "analysis",
    "strategy",
    "market"
  ],
  meta: {
    company: "Form & Function",
    deck: "Competitive landscape, 2026",
    kicker: "the landscape, unsentimentally",
    farewell: "Decide, then move",
    art: {
      cover: "il-109-map-location",
      section: "il-day77-pocket-knief",
      picture: "il-day22-owl",
      closing: "la-scooter"
    }
  },
  look: {
    display: "Barlow Condensed", dw: 700,
    body: "Barlow", bw: 400,
    mono: "Chivo Mono",
    accentFace: "Permanent Marker", accentWeight: 400, accentSize: 30,
    paper: { bg: "#FFFFFF", ink: "#1B1D21", muted: "#565B63", line: "#D8DBDF", panel: "#F1F2F4", panel2: "#E2E4E8", accent: "#E11D2B", accent2: "#2B2F36", accentInk: "#C4121F" },
    deep: { bg: "#272B31", bg2: "#131518", ink: "#F5F5F3", muted: "#A9AEB6", line: "#3E434A", panel: "#31363D", panel2: "#3C4149", accent: "#FF4B50", accent2: "#D3D6DB", accentInk: "#FF6266" },
    radius: 0,
    ornament: "arcs",
    peeps: ["op-peep-19", "op-peep-33", "op-peep-44", "op-peep-57", "op-peep-69"],
    scale: { cover: 120, title: 64, section: 236, statement: 84, numeral: 108, quote: 54 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "Who plays, and\nwhere the lines are",
        subtitle: "Three players on six criteria, their momentum, our edge when buyers compare, the threat that would hurt most, and our response.",
        presenter: "Marcus Obi, Strategy  ·  20 October 2026",
        chips: [["3", "players"], ["6", "criteria"], ["$30", "the trigger"]],
        note: "read it like a scout, not a fan"
      }
    ],
    [
      "raw",
      {
        build: signature.matrix
      }
    ],
    [
      "timeline",
      {
        eyebrow: "Their momentum",
        title: "What they shipped this year",
        done: 3,
        steps: [
          [
            "Q1",
            "The marketplace",
            "Two hundred integrations in a quarter, most of them thin. Buyers count them anyway."
          ],
          [
            "Q2",
            "Usage-based pricing",
            "Cheaper to start, expensive at scale. Wins the pilot, loses the renewal."
          ],
          [
            "Q3",
            "The AI assistant",
            "Fast, shallow, and demoed everywhere. Sets the expectation we now have to meet."
          ],
          [
            "Q4",
            "Expected: enterprise bundle",
            "Their partner channel says SSO and audit logs ship by December."
          ]
        ],
        note: "four quarters, four moves, none of them slow"
      }
    ],
    [
      "threeCards",
      {
        eyebrow: "Our edge",
        title: "Where we win when buyers compare",
        cards: [
          [
            "bolt",
            "Three days to value, not three weeks",
            "Every won deal this year cited it. Lead with the pilot, measure it, put the number on the proposal."
          ],
          [
            "lock",
            "The customer owns the data",
            "Open format and self-hosting close regulated buyers before price is discussed."
          ],
          [
            "user",
            "One named engineer per account",
            "Their support is a queue. Ours has a face. Renewals mention it unprompted."
          ]
        ],
        note: "won deals say these three, unprompted"
      }
    ],
    [
      "statement",
      {
        text: "The move that hurts us most is not their next feature. It is a price cut we answer too late.",
        source: "Strategy review, October 2026",
        note: "the response is drafted; the trigger is not agreed"
      }
    ],
    [
      "section",
      {
        n: "Q4",
        title: "Our response",
        blurb: "Three moves in order, one trigger we watch weekly, and a date on each of them.",
        kicker: "what we do about it",
        art: "il-day77-pocket-knief",
        note: "dates, owners, a number each"
      }
    ],
    [
      "process",
      {
        eyebrow: "Response plan",
        title: "Three moves, sequenced",
        steps: [
          [
            "Now",
            "Publish the pilot outcomes page. Every proposal links to it by November."
          ],
          [
            "Q4",
            "Ship a real assistant, not a demo. Grounded in the customer's own files, measured on adoption."
          ],
          [
            "Q1",
            "Announce the enterprise bundle before theirs lands. Same features, our security story."
          ],
          [
            "Ongoing",
            "Watch pricing weekly. A cut below $30 per seat triggers the prepared response within a week."
          ]
        ],
        note: "a name on each move by Friday"
      }
    ],
    [
      "closing",
      {
        title: "Decide, then move",
        subtitle: "The full comparison, win-loss notes and the pricing response are in the strategy folder.",
        rows: [
          [
            "mail",
            "marcus@formfunction.example"
          ],
          [
            "world",
            "formfunction.example/strategy"
          ],
          [
            "calendar",
            "Next review: January"
          ]
        ],
        cta: "Open the win-loss notes",
        art: "la-scooter",
        note: "one decision today: the trigger price"
      }
    ]
  ]
};
