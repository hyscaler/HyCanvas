// Roadmap Review: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: a control room after hours. A cool slate ground under citrus
// yellow and slate blue, a semi-condensed sans for the panel labels, a mono
// for every figure and status, and a terminal mono for the kicker and the
// notes, so they read like an operator's log. Radar arcs as the ornament.

import { text, rect, ellipse, type, chrome, note, inkOn, M, CW } from "../lib/deck-kit.mjs";

// The four states an initiative can be in. The two that need the room's
// attention light up in the deck's own colours, shipped takes the slate
// blue, and on track stays quiet, the way a nominal reading does on a
// control-room board: only the exceptions glow. Coral is the one colour
// reserved for a blocker.
const BLOCKED = "#F2705C";
const STATES = {
  shipped: { label: "shipped", fill: (g) => g.accent2, solid: true },
  "on track": { label: "on track", fill: (g) => g.panel2, solid: false },
  "at risk": { label: "at risk", fill: (g) => g.accent, solid: true },
  blocked: { label: "blocked", fill: () => BLOCKED, solid: true },
};
const RANK = ["shipped", "on track", "at risk", "blocked"];

/** A status pill: a lamp dot and a mono label, solid for the states that
 *  need attention, outlined for the quiet one. */
function pill(K, g, x, y, w, state, label) {
  const s = STATES[state];
  const fill = s.fill(g);
  const ink = s.solid ? inkOn(K, fill) : g.ink;
  return [
    rect(x, y, w, 28, fill, { radius: 14, ...(s.solid ? {} : { stroke: g.line, strokeWidth: 1.5 }) }),
    ellipse(x + 12, y + 10, 8, 8, s.solid ? ink : g.muted),
    text(x + 28, y, w - 34, 28, label ?? s.label, { family: K.mono, size: 13, weight: 600, color: ink, letterSpacing: 2, upper: true, vAlign: "middle", lineHeight: 1 }),
  ];
}

const THEMES = [
  ["Theme 01", "Incident response", [
    ["Unified timeline", "Tomas", "shipped", "August"],
    ["Incident narrative, beta", "Tomas", "on track", "November"],
    ["Mobile alerts", "Mei", "on track", "November"],
    ["On-call handoff notes", "Mei", "on track", "December"],
  ]],
  ["Theme 02", "Enterprise", [
    ["SSO and SCIM", "Aisha", "shipped", "September"],
    ["Audit log export", "Aisha", "shipped", "September"],
    ["APAC data residency", "Aisha", "blocked", "December", "vendor contract"],
    ["Usage-based billing", "Jonah", "at risk", "January", "scope"],
  ]],
  ["Theme 03", "Platform", [
    ["Query cache", "Jonah", "shipped", "August"],
    ["Public API v2", "Priya", "on track", "December"],
    ["Webhook retries", "Priya", "on track", "November"],
    ["Self-serve data export", "Jonah", "blocked", "January", "legal review"],
  ]],
];

const signature = {
  /** The board: every initiative of the quarter as a row under its theme,
   *  with a status pill coloured by state, the owner and the date. Each
   *  theme's panel carries a bar in its worst state, so the room reads the
   *  three panels before it reads a single row. A legend of counts and a
   *  timestamp sit under the panels. */
  board(K, i) {
    const g = K.paper;
    const t = type(K, g);
    const title = "Twelve initiatives, four states";
    const { nodes, bodyTop } = chrome(K, g, i, "The board", title);
    const fill = [];
    fill.push({ node: nodes.findIndex((n) => n.text === title), label: "Title", hint: "The quarter in one line" });

    const n = THEMES.length;
    const cw = (CW - (n - 1) * 24) / n;
    const y = bodyTop;
    const h = 540;
    const worstOf = (items) => items.reduce((w, r) => (RANK.indexOf(r[2]) > RANK.indexOf(w) ? r[2] : w), "shipped");
    THEMES.forEach(([eyebrow, head, items], k) => {
      const x = M + k * (cw + 24);
      const x0 = x + 28, iw = cw - 56;
      const worst = worstOf(items);
      const bar = worst === "on track" ? g.accent2 : STATES[worst].fill(g);
      nodes.push(rect(x, y, cw, h, g.panel, { radius: K.radius, stroke: g.line, strokeWidth: 1.5 }));
      nodes.push(rect(x, y, cw, 6, bar, { radius: 0 }));
      nodes.push(text(x0, y + 30, iw, 22, eyebrow, t.eyebrow({ size: 14, letterSpacing: 3 })));
      nodes.push(text(x0, y + 56, iw, 36, head, t.display(28)));
      fill.push({ node: nodes.length - 1, label: `Theme ${k + 1}`, hint: "The theme, in two or three words" });
      nodes.push(rect(x0, y + 106, iw, 1, g.line));
      items.forEach(([name, owner, state, date, reason], j) => {
        const ry = y + 124 + j * 104;
        nodes.push(text(x0, ry, iw - 136, 30, name, t.strong(21)));
        nodes.push(...pill(K, g, x0 + iw - 120, ry + 1, 120, state));
        nodes.push(text(x0, ry + 38, iw, 24, [owner, date, reason].filter(Boolean).join("  ·  "), t.meta({ size: 15 })));
        if (j < items.length - 1) nodes.push(rect(x0, ry + 82, iw, 1, g.line));
      });
    });

    // The legend: one pill per state with its count, and the board's
    // timestamp, the way a wall display stamps every refresh.
    const counts = RANK.map((s) => [s, THEMES.reduce((c, th) => c + th[2].filter((r) => r[2] === s).length, 0)]);
    const ly = y + h + 30;
    counts.forEach(([s, c], k) => nodes.push(...pill(K, g, M + k * 168, ly, 152, s, `${c} ${STATES[s].label}`)));
    nodes.push(text(M + 4 * 168 + 8, ly + 2, 420, 24, "board as of 9 October, 09:00", t.meta({ size: 15 })));

    nodes.push(...note(K, g, "quiet rows are the good news"));
    return { page: { name: "The board", bg: g.bg, nodes }, fill };
  },
};

export default {
  id: "deck-roadmap-review",
  title: "Roadmap Review",
  base: "vanta",
  rank: 50,
  tags: [
    "roadmap",
    "product",
    "planning",
    "review"
  ],
  meta: {
    company: "Nova Systems",
    deck: "Roadmap review, Q4 2026",
    kicker: "// where we are",
    farewell: "// decision recorded",
    art: {
      cover: "il-109-map-location",
      section: "il-day65-city-road",
      picture: "il-day41-desktop",
      closing: "il-day18-floppy"
    }
  },
  look: {
    display: "Barlow Semi Condensed", dw: 700,
    body: "Barlow", bw: 400,
    mono: "JetBrains Mono",
    numeralFace: "JetBrains Mono", numeralWeight: 700,
    accentFace: "Share Tech Mono", accentWeight: 400, accentSize: 30,
    paper: { bg: "#222D40", ink: "#EEF2F8", muted: "#A6B1C5", line: "#344259", panel: "#2A3649", panel2: "#33415A", accent: "#F5D33F", accent2: "#94ADE2" },
    deep: { bg: "#1A2333", bg2: "#0B1019", ink: "#EEF2F8", muted: "#9DA9BF", line: "#2B3649", panel: "#212C3E", panel2: "#293650", accent: "#F5D33F", accent2: "#8EA8DE" },
    radius: 6,
    ornament: "arcs",
    peeps: ["op-peep-11", "op-peep-28", "op-peep-50", "op-peep-70", "op-peep-97"],
    scale: { cover: 112, title: 60, section: 220, statement: 74, numeral: 100, quote: 52 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "The quarter's themes\nat a glance",
        subtitle: "What shipped and the early signals, what is moving and what is blocked, and the one trade-off we cannot fund both sides of.",
        presenter: "Priya Raman, Head of Product  ·  9 October 2026",
        chips: [
          [
            "4",
            "shipped"
          ],
          [
            "6",
            "in flight"
          ],
          [
            "2",
            "blocked"
          ]
        ],
        note: "twelve initiatives, one call to make"
      }
    ],
    [
      "threeCards",
      {
        eyebrow: "Shipped",
        title: "What landed, and the early signals",
        cards: [
          [
            "circle-check",
            "The unified timeline",
            "Live for every customer since August. Half of incident reviews now start from it."
          ],
          [
            "bolt",
            "Query cache",
            "P95 latency down 41%. The most-cited improvement in September customer calls."
          ],
          [
            "lock",
            "SSO and SCIM",
            "Four enterprise customers live in week one. The bundle is now a sales asset."
          ]
        ],
        note: "the cache is what customers bring up first"
      }
    ],
    [
      "section",
      {
        n: "06",
        title: "In flight",
        blurb: "Six initiatives moving, two more stuck behind a contract and a legal review. The board first, then the one call to make.",
        kicker: "// status check",
        art: "il-day65-city-road",
        note: "six moving, two stuck"
      }
    ],
    [
      "raw",
      { build: signature.board }
    ],
    [
      "twoColumns",
      {
        eyebrow: "The trade-off",
        title: "Two bets we cannot both fund",
        left: {
          eyebrow: "Bet A",
          head: "Incident narrative, generally available",
          lines: [
            "Four engineers for a quarter",
            "Every customer benefits on day one",
            "The differentiator in every competitive deal"
          ],
          icon: "sparkles"
        },
        right: {
          eyebrow: "Bet B",
          head: "APAC region and residency",
          lines: [
            "Three engineers and a vendor contract",
            "Unblocks two enterprise deals worth $600K",
            "A door that stays shut until it is built"
          ],
          icon: "world"
        },
        note: "four engineers, one quarter, pick one"
      }
    ],
    [
      "statement",
      {
        text: "Fund the narrative. Hold APAC to a date in Q1 and tell the two customers the truth about when.",
        source: "The recommendation",
        note: "a date they can plan around beats a maybe"
      }
    ],
    [
      "timeline",
      {
        eyebrow: "If we say yes today",
        title: "The next hundred days",
        done: 1,
        steps: [
          [
            "9 October",
            "The decision",
            "Narrative funded to general availability; APAC held to 28 February. Both customers hear it this week."
          ],
          [
            "November",
            "Beta widens",
            "Narrative beta opens to every customer on the incident plan. Mobile alerts ship."
          ],
          [
            "December",
            "Contract signed",
            "The residency vendor closes. Two engineers start the region build with a date to hit."
          ],
          [
            "15 January",
            "Revisit",
            "Deal status, narrative adoption, and whether the February date still holds."
          ]
        ],
        note: "15 January is a checkpoint, not a courtesy"
      }
    ],
    [
      "closing",
      {
        title: "The decision",
        subtitle: "Narrative to general availability in Q4; APAC residency committed for 28 February. Revisit on 15 January with the deal status.",
        rows: [
          [
            "mail",
            "priya@novasystems.example"
          ],
          [
            "world",
            "roadmap.novasystems.example"
          ],
          [
            "calendar",
            "Revisit: 15 January"
          ]
        ],
        cta: "Open the roadmap",
        note: "minutes out tonight, board updated by Friday"
      }
    ]
  ]
};
