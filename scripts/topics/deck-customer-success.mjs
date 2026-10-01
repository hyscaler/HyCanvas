// Customer Success Review: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: teal ink on sand for reading, a deep teal gradient for the
// impact pages, tangerine for the accent and mint for the second, a
// humanist sans throughout and a hand face for the notes. The signature
// slide is the health grid: the whole book of business as one tile per
// account, coloured by health, with the counts and the movement since last
// quarter beside it.

import { text, rect, ellipse, chrome, card, type, note, M } from "../lib/deck-kit.mjs";

/** The three health tiers, as tile colours on the sand ground. */
const TIER = { green: "#2B8F62", yellow: "#D99A2B", red: "#C8412D" };

/** A small arrow built from thin rects: a shaft and two arms meeting at the
 *  apex. A node rotates about its own top-left corner, so each arm's origin
 *  is the apex moved back half the thickness along the arm's local x axis. */
function arrow(cx, top, dir, color, o = {}) {
  const T = o.thickness ?? 4, L = o.arm ?? 11, S = o.shaft ?? 20;
  const k = Math.SQRT1_2, r = (v) => Math.round(v * 100) / 100;
  if (dir === "up") {
    return [
      rect(cx - T / 2, top + 2, T, S, color, { radius: 2 }),
      rect(r(cx - T * k / 2), r(top - T * k / 2), T, L, color, { rotation: 45 }),
      rect(r(cx - T * k / 2), r(top + T * k / 2), T, L, color, { rotation: -45 }),
    ];
  }
  const bot = top + S + 2;
  return [
    rect(cx - T / 2, top, T, S, color, { radius: 2 }),
    rect(r(cx + T * k / 2), r(bot - T * k / 2), T, L, color, { rotation: 135 }),
    rect(r(cx + T * k / 2), r(bot + T * k / 2), T, L, color, { rotation: 225 }),
  ];
}

/** A deterministic shuffle, so the grid reads the same on every build. */
function shuffled(items, seed) {
  let s = seed * 9301 + 49297;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const out = [...items];
  for (let k = out.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [out[k], out[j]] = [out[j], out[k]]; }
  return out;
}

/** The health grid: every one of the 312 accounts as a tile, green, yellow
 *  or red, in 24 columns of 13; a dot on the tiles that changed tier this
 *  quarter. Beside it, the count of each tier and the movement since June,
 *  and the two lines that sum the quarter. */
function healthGrid(K, i) {
  const g = K.paper;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, "Health grid", "Every account, one tile");
  const counts = { green: 252, yellow: 44, red: 16 };
  const cols = 24, rows = 13, size = 40, gap = 6, pitch = size + gap;
  const gx = M, gy = bodyTop + 8;
  // The book: tiers shuffled across the grid, then the movers marked. Up
  // movers now sit in green or yellow; down movers in yellow or red.
  const tiles = shuffled([
    ...Array(counts.green).fill("green"), ...Array(counts.yellow).fill("yellow"), ...Array(counts.red).fill("red"),
  ], 7);
  const up = new Set(), down = new Set();
  const pick = (tier, n, set, seed) => {
    const idx = shuffled(tiles.map((c, k) => (c === tier && !up.has(k) && !down.has(k) ? k : -1)).filter((k) => k >= 0), seed);
    idx.slice(0, n).forEach((k) => set.add(k));
  };
  pick("green", 16, up, 11); pick("yellow", 6, up, 13); pick("yellow", 5, down, 17); pick("red", 4, down, 19);
  tiles.forEach((tier, k) => {
    const x = gx + (k % cols) * pitch, y = gy + Math.floor(k / cols) * pitch;
    nodes.push(rect(x, y, size, size, TIER[tier], { radius: 6 }));
    if (up.has(k)) nodes.push(ellipse(x + 16, y + 16, 8, 8, g.bg));
    if (down.has(k)) nodes.push(ellipse(x + 16, y + 16, 8, 8, g.ink, { opacity: 0.8 }));
  });
  const gridW = cols * pitch - gap, gridH = rows * pitch - gap;
  nodes.push(text(gx, gy + gridH + 16, gridW, 26, "One tile per account, largest first. Light dot: moved up a tier this quarter. Dark dot: moved down.", t.meta()));

  // The counts beside the grid, on a card.
  const cx = gx + gridW + 40, cy = gy, cw = M + 1728 - cx, ch = gridH;
  nodes.push(card(K, g, cx, cy, cw, ch));
  nodes.push(text(cx + 36, cy + 30, cw - 72, 26, "30 September, against 30 June", t.eyebrow({ size: 17, letterSpacing: 3 })));
  const tiers = [
    ["green", "Green", "Health score 70 and above", "252", "up", "36 more than in June"],
    ["yellow", "Yellow", "Score 40 to 69, or a renewal inside 90 days", "44", "down", "12 fewer than in June"],
    ["red", "Red", "Score under 40, or a champion gone", "16", "down", "6 fewer than in June"],
  ];
  tiers.forEach(([tier, label, sub, n, dir, move], k) => {
    const y = cy + 76 + k * 144;
    nodes.push(rect(cx + 36, y + 6, 26, 26, TIER[tier], { radius: 6 }));
    nodes.push(text(cx + 78, y, 240, 34, label, t.strong(26)));
    nodes.push(text(cx + 78, y + 36, cw - 114 - 130, 52, sub, t.meta({ size: 17 })));
    nodes.push(text(cx + cw - 36 - 130, y - 8, 130, 70, n, t.display(60, { align: "right" })));
    nodes.push(...arrow(cx + 90, y + 88, dir, dir === "up" ? g.accent2 : g.accent));
    nodes.push(text(cx + 112, y + 84, cw - 148, 30, move, t.strong(19, { color: dir === "up" ? g.accent2 : g.accentInk ?? g.accent })));
    nodes.push(rect(cx + 36, y + 122, cw - 72, 1, g.line));
  });
  nodes.push(text(cx + 36, cy + ch - 92, cw - 72, 60, "22 accounts moved up a tier and 9 moved down. 26 new logos, 8 churned, all eight under fifty seats.", t.body(19)));
  nodes.push(...note(K, g, "the five biggest reds are on page six"));
  return { page: { name: "Health grid", bg: g.bg, nodes }, fill: [] };
}

const signature = { healthGrid };

export default {
  id: "deck-customer-success",
  title: "Customer Success Review",
  base: "terra",
  rank: 70,
  tags: [
    "customer success",
    "review",
    "retention",
    "accounts"
  ],
  styleTags: ["calm", "warm", "friendly"],
  meta: {
    company: "Fernwood",
    deck: "Customer success review, Q3",
    kicker: "The book of business",
    farewell: "Thanks, team",
    art: {
      cover: "la-conversation-illustration",
      section: "il-day64-followers",
      picture: "la-woman-working-1",
      closing: "la-small-character-illustrations"
    }
  },
  look: {
    display: "Signika", dw: 700, body: "Mulish", bw: 400, mono: null,
    accentFace: "Kalam", accentWeight: 700, accentSize: 40,
    paper: { bg: "#F3EDDF", ink: "#0F3A3D", muted: "#4A6A6B", line: "#D5CBB5", panel: "#EAE2CF", panel2: "#DFD5BE", accent: "#D9631A", accent2: "#136F70", accentInk: "#AE4B0E" },
    deep: { bg: "#0F4C50", bg2: "#083134", ink: "#F3EDDF", muted: "#B2CCC9", line: "#215E62", panel: "#165A5E", panel2: "#1D666A", accent: "#F28C3C", accent2: "#7FD3C6", accentInk: "#F8B577" },
    radius: 10,
    ornament: "dots",
    peeps: ["op-peep-16", "op-peep-94", "op-peep-68", "op-peep-77", "op-peep-31"],
    scale: { cover: 114, title: 62, section: 236, statement: 80, numeral: 100, quote: 52 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "Accounts, health,\nand momentum",
        subtitle: "Where the book stands, the saves and the wins, what is at risk, and the expansion plays that are landing.",
        presenter: "Dana Whitfield, Head of Customer Success  ·  6 October 2026",
        note: "a name next to every red account"
      }
    ],
    [
      "figures",
      {
        eyebrow: "Health overview",
        title: "The book at a glance",
        stats: [
          [
            "312",
            "Accounts",
            "+18 this quarter",
            "Twenty-six new, eight churned, all eight under fifty seats."
          ],
          [
            "81%",
            "Green accounts",
            "+6 pts",
            "Health score above 70; usage and support both trending up."
          ],
          [
            "14%",
            "Yellow accounts",
            "−4 pts",
            "Mostly renewals inside ninety days with a champion change."
          ],
          [
            "5%",
            "Red accounts",
            "−2 pts",
            "Sixteen accounts, $1.1M in annual revenue, each with a named plan."
          ]
        ],
        note: "same scorecard as June"
      }
    ],
    [
      "raw",
      { build: signature.healthGrid }
    ],
    [
      "threeCards",
      {
        eyebrow: "Saves and wins",
        title: "Accounts we turned around",
        cards: [
          [
            "heart",
            "Brightline Logistics",
            "Red in July after a champion left. New champion onboarded in two weeks; renewed for three years in September."
          ],
          [
            "shield",
            "Meridian Health",
            "Blocked on a security review for four months. A named engineer cleared it in nine days."
          ],
          [
            "sparkles",
            "Cobalt Retail",
            "Usage had halved. A workflow rebuild with their team doubled it back and added two departments."
          ]
        ],
        note: "the other nineteen are in the appendix"
      }
    ],
    [
      "quote",
      {
        text: "The week our champion left, Fernwood called us before we had worked out who to call.",
        name: "Rowan Achebe",
        role: "Chief Financial Officer, Brightline Logistics",
        note: "renewed for three years in September"
      }
    ],
    [
      "table",
      {
        eyebrow: "At risk",
        title: "Where we need help, and by when",
        cols: [
          "",
          "Revenue",
          "Renewal",
          "Ask"
        ],
        rows: [
          [
            "Harbor & Vale",
            "$240K",
            "November",
            "Exec sponsor call"
          ],
          [
            "Summit Freight",
            "$180K",
            "December",
            "Integration fix"
          ],
          [
            "Atlas Insurance",
            "$160K",
            "January",
            "Pricing exception"
          ],
          [
            "Pinecrest Schools",
            "$120K",
            "November",
            "Training day"
          ],
          [
            "Northwind Systems",
            "$95K",
            "December",
            "Roadmap commitment"
          ]
        ],
        note: "the sponsor call cannot slip"
      }
    ],
    [
      "process",
      {
        eyebrow: "Expansion plays",
        title: "The four motions that are landing",
        steps: [
          [
            "Department to department",
            "A live customer walks a neighbouring team through their setup. Closed nine expansions this way."
          ],
          [
            "Usage threshold",
            "At 80% of seats, the account manager books the review before the customer asks."
          ],
          [
            "Executive business review",
            "Twice a year for every account over $100K. Every expansion this quarter followed one."
          ],
          [
            "Partner referral",
            "Partners introduce their other customers. Four expansions, all in the first meeting."
          ]
        ],
        note: "all thirteen followed a business review"
      }
    ],
    [
      "closing",
      {
        title: "Next quarter",
        subtitle: "Coverage moves to pods of three, the sixteen red accounts each get a named owner, and the focus list is on the wall.",
        rows: [
          [
            "mail",
            "dana@fernwood.example"
          ],
          [
            "world",
            "success.fernwood.example"
          ],
          [
            "calendar",
            "Next review: 12 January"
          ]
        ],
        cta: "See the focus accounts",
        note: "the list is on the wall by room four"
      }
    ]
  ]
};
