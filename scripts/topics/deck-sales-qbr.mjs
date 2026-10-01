// Sales QBR: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: deep navy and copper on a warm off-white, a Didone display with
// a mono for every figure, a marker hand for the notes. The confidence of a
// trading floor: the dot grid of a ticker board, figures set in mono, copper
// for what we booked and teal for the plan we booked it against.

import { text, rect, type, deepGround, ornamentDeep, footer, inkOn, M } from "../lib/deck-kit.mjs";

// --- the signature slide -------------------------------------------------------

/** The scoreboard: the quarter's bookings against plan as one wide bar per
 *  month on a board, the plan marked as a tick on every bar, the quarter's
 *  win rate and coverage set large beside it. On the deep ground, the way
 *  a floor board is dark with the figures lit. */
const signature = {
  scoreboard(K, i) {
    const g = K.deep;
    const t = type(K, g);
    const mono = K.mono ?? K.body;
    // The ornament's sparkle is texture for where no text sits; here the
    // figures fill the left column and the board the right, so keep the
    // dot grid and drop the sparkle that would land among the figures.
    const nodes = ornamentDeep(K, g).filter((n) => !(n.kind === "ellipse" && n.x < 1320));
    const fill = [];

    // The reading grid's eyebrow and title baselines, kept on the deep ground.
    nodes.push(text(M, 88, 1100, 28, "Headline numbers", t.eyebrow()));
    nodes.push(text(M, 124, 1100, 72, "Bookings against plan", t.display(56)));
    fill.push({ node: nodes.length - 1, label: "Title", hint: "What the board measures" });

    // Left: the two figures that frame the board, in the mono at display size.
    const figs = [
      ["31%", "Win rate", "+4 pts on Q2. Up in mid-market, flat in enterprise."],
      ["3.4x", "Pipeline coverage", "+0.6x entering Q4, before the October push."],
    ];
    figs.forEach(([n, l, d], k) => {
      const y = 268 + k * 300;
      nodes.push(text(M, y, 520, 150, n, t.numeral(136, { family: mono })));
      fill.push({ node: nodes.length - 1, label: l, hint: "The figure" });
      nodes.push(text(M, y + 162, 520, 26, l, t.eyebrow()));
      nodes.push(text(M, y + 196, 520, 60, d, t.body(20)));
      if (k === 0) nodes.push(rect(M, y + 276, 520, 1, g.line));
    });
    nodes.push(text(M, 852, 560, 48, "September carried the quarter", t.kicker({ size: 30 })));

    // Right: the board. A panel with a copper bar along its top, a legend,
    // three rows of bar against track, the plan tick on each, the total.
    const bx = 700, by = 236, bw = 1124, bh = 636;
    nodes.push(rect(bx, by, bw, bh, g.panel, { radius: K.radius, stroke: g.line, strokeWidth: 1.5 }));
    nodes.push(rect(bx, by, bw, 6, g.accent, { radius: 0 }));
    nodes.push(text(bx + 40, by + 34, 500, 26, "Bookings, $M", t.eyebrow()));
    nodes.push(rect(1504, by + 40, 28, 14, g.accent, { radius: 2 }));
    nodes.push(text(1544, by + 34, 90, 26, "Actual", t.meta()));
    nodes.push(rect(1660, by + 34, 4, 26, g.accent2, { radius: 2 }));
    nodes.push(text(1676, by + 34, 100, 26, "Plan", t.meta()));

    const rows = [["Jul", 3.1, 3.6], ["Aug", 3.8, 4.0], ["Sep", 5.5, 4.4]];
    const trackX = bx + 150, trackW = 890, px = 138, barH = 60, rowH = 156;
    rows.forEach(([m, actual, plan], k) => {
      const y = by + 104 + k * rowH;
      const barW = Math.round(actual * px), planW = Math.round(plan * px);
      const pct = Math.round((actual / plan) * 100);
      nodes.push(text(bx + 40, y + 6, 110, 30, m, { family: mono, size: 22, weight: 600, color: g.ink, upper: true, letterSpacing: 2, lineHeight: 1.2 }));
      nodes.push(text(bx + 40, y + 38, 110, 22, `${pct}% of plan`, t.meta({ size: 15 })));
      nodes.push(rect(trackX, y, trackW, barH, g.panel2, { radius: 2 }));
      nodes.push(rect(trackX, y, barW, barH, g.accent, { radius: 2 }));
      nodes.push(text(trackX + barW - 140, y + 15, 124, 30, `$${actual.toFixed(1)}M`, { family: mono, size: 24, weight: 700, color: inkOn(K, g.accent), align: "right", lineHeight: 1.2 }));
      nodes.push(rect(trackX + planW - 2, y - 10, 4, barH + 20, g.accent2, { radius: 2 }));
      nodes.push(text(trackX + planW - 60, y - 40, 120, 24, `plan ${plan.toFixed(1)}`, { family: mono, size: 16, weight: 500, color: g.accent2, align: "center", lineHeight: 1.2 }));
      if (k < rows.length - 1) nodes.push(rect(bx + 40, y + 86, bw - 80, 1, g.line));
    });
    nodes.push(rect(bx + 40, by + 536, bw - 80, 1, g.line));
    nodes.push(text(bx + 40, by + 562, bw - 80, 34, "", {
      family: mono, size: 24, weight: 500, color: g.muted, lineHeight: 1.3,
      spans: [
        { text: "Q3 total   " },
        { text: "$12.4M", color: g.ink, weight: 700 },
        { text: "   against a $12.0M plan   " },
        { text: "103%", color: g.accent, weight: 700 },
      ],
    }));

    nodes.push(...footer(K, g, i));
    return { page: { name: "Scoreboard", bg: deepGround(g), nodes }, fill };
  },
};

export default {
  id: "deck-sales-qbr",
  title: "Sales QBR",
  base: "atlas",
  rank: 32,
  tags: [
    "qbr",
    "sales",
    "review",
    "quarterly"
  ],
  meta: {
    company: "Northwind Systems",
    deck: "Sales QBR, Q3 2026",
    kicker: "The quarter, on the board",
    farewell: "On to Q4",
    art: {
      cover: "la-sale",
      section: "il-109-map-location",
      picture: "la-monitor",
      closing: "la-hero-image-2"
    }
  },
  look: {
    display: "Bodoni Moda", dw: 700,
    body: "Libre Franklin", bw: 400,
    mono: "JetBrains Mono",
    accentFace: "Kalam", accentWeight: 700, accentSize: 36,
    paper: { bg: "#F5EFE6", ink: "#0B1A33", muted: "#4E5A70", line: "#D8CFC0", panel: "#ECE4D7", panel2: "#E2D8C8", accent: "#B4602F", accent2: "#23707C", accentInk: "#964B22" },
    deep: { bg: "#0D1F3C", bg2: "#060F22", ink: "#F5EFE6", muted: "#A9B4C8", line: "#26395C", panel: "#16294A", panel2: "#1F3560", accent: "#D98B55", accent2: "#62B5C0" },
    radius: 4,
    ornament: "dots",
    peeps: ["op-peep-46", "op-peep-94", "op-peep-31", "op-peep-34", "op-peep-78"],
    scale: { cover: 116, title: 60, section: 236, statement: 80, numeral: 100, quote: 52 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "Pipeline, wins,\nand what changed",
        subtitle: "Bookings against plan, the plays that closed, and the three bets that carry us into Q4.",
        presenter: "Marcus Obi, VP Sales  ·  8 October 2026",
        note: "read the board before the story"
      }
    ],
    [
      "agenda",
      {
        title: "Sixty minutes, five questions",
        items: [
          [
            "Headline numbers",
            "Bookings, coverage and win rate against plan",
            "10 min"
          ],
          [
            "What worked",
            "The plays and segments that outperformed",
            "10 min"
          ],
          [
            "What did not",
            "Stalled deals and the losses we should have won",
            "15 min"
          ],
          [
            "Competitive picture",
            "Who we met and how we positioned",
            "10 min"
          ],
          [
            "The Q4 plan",
            "Three bets, owners and dates",
            "15 min"
          ]
        ],
        card: {
          eyebrow: "This session",
          big: "Q3",
          meta: [
            [
              "When",
              "8 October, 14:00"
            ],
            [
              "Room",
              "Summit, level 6"
            ],
            [
              "Host",
              "Marcus Obi"
            ],
            [
              "Deck",
              "Shared after the call"
            ]
          ]
        },
        note: "fifteen minutes on the losses, on purpose"
      }
    ],
    [
      "figures",
      {
        eyebrow: "Headline numbers",
        title: "The quarter against plan",
        stats: [
          [
            "$12.4M",
            "Bookings",
            "103% of plan",
            "Closed-won ACV; enterprise carried the last two weeks."
          ],
          [
            "3.4x",
            "Pipeline coverage",
            "+0.6x entering Q4",
            "Qualified pipeline against the Q4 number, before marketing's October push."
          ],
          [
            "31%",
            "Win rate",
            "+4 pts",
            "Up in mid-market, flat in enterprise; the security review is the swing factor."
          ],
          [
            "41 days",
            "Sales cycle",
            "9 days faster",
            "Faster where the pilot offer was used; slower everywhere else."
          ]
        ],
        note: "plan was $12.0M, cleared in week twelve"
      }
    ],
    [
      "raw",
      {
        build: signature.scoreboard
      }
    ],
    [
      "twoColumns",
      {
        eyebrow: "What worked, what did not",
        title: "The honest split",
        left: {
          eyebrow: "Worked",
          head: "The pilot offer and the mid-market play",
          lines: [
            "Two-week pilots closed at 2x the rate",
            "Mid-market reps hit 118% of quota",
            "Partner-sourced deals churned least"
          ],
          icon: "circle-check"
        },
        right: {
          eyebrow: "Did not",
          head: "Enterprise security reviews",
          lines: [
            "Six deals stalled at the review stage",
            "Three losses to the incumbent on price",
            "Discounting crept back above policy"
          ],
          icon: "alert-triangle"
        },
        note: "$2.1M is sitting in security review"
      }
    ],
    [
      "quote",
      {
        text: "We did not buy the demo. We bought the two weeks where our own data ran through it and nothing broke.",
        name: "Lena Ortiz",
        role: "CFO, Corvid Freight. Closed in September, $410K, after a pilot",
        note: "three of the seven big deals said this"
      }
    ],
    [
      "table",
      {
        eyebrow: "Competitive picture",
        title: "Who we met, and how it went",
        cols: [
          "",
          "Us",
          "Incumbent",
          "Upstart"
        ],
        rows: [
          [
            "Competitive deals this quarter",
            "55",
            "38",
            "17"
          ],
          [
            "Won when we led with pilots",
            "yes",
            "no",
            "no"
          ],
          [
            "Security certification",
            "yes",
            "yes",
            "no"
          ],
          [
            "Sub-30-day implementation",
            "yes",
            "no",
            "yes"
          ],
          [
            "Price under $40 per seat",
            "no",
            "no",
            "yes"
          ]
        ],
        note: "we lose on price and win on speed"
      }
    ],
    [
      "section",
      {
        n: "05",
        title: "The Q4 plan",
        blurb: "Three bets, each with an owner, a date, and the number we report back in January.",
        kicker: "Where the quarter points",
        art: "il-109-map-location",
        note: "no bet without a name on it"
      }
    ],
    [
      "threeCards",
      {
        eyebrow: "The Q4 plan",
        title: "Three bets, with owners",
        cards: [
          [
            "flag",
            "Pilots for every enterprise deal",
            "Make the two-week pilot the default. Owner: Priya. Target: 60% of enterprise pipeline."
          ],
          [
            "shield",
            "Security review in under ten days",
            "A pre-answered questionnaire and a named engineer. Owner: Sam. Target: no deal stalls past day ten."
          ],
          [
            "coin",
            "Hold the line on discounting",
            "Approval above 15% moves to the VP. Owner: Marcus. Target: average discount under 12%."
          ]
        ],
        note: "same slide in January, numbers filled in"
      }
    ],
    [
      "closing",
      {
        title: "Questions",
        subtitle: "The full pipeline review and the rep-by-rep numbers are in the shared folder.",
        rows: [
          [
            "mail",
            "marcus@northwind.example"
          ],
          [
            "world",
            "northwind.example/sales"
          ],
          [
            "calendar",
            "Next QBR: 14 January"
          ]
        ],
        cta: "Book a follow-up",
        art: "la-hero-image-2",
        note: "bring the stalled six to the follow-up"
      }
    ]
  ]
};
