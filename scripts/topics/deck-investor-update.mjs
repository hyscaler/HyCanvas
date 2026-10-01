// Investor Update: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look is a plain monthly letter. Bond paper and charcoal ink, with a
// deep amber for anything set in the accent; a charcoal gradient with a
// brighter amber on the deep pages. A clean grotesk for titles, a quiet sans
// for reading, a mono for every label and for the letter's figures, and a
// pen for the margin notes. The ornament is a dot grid: ledger paper.

import { text, rect, note, chrome, type, M } from "../lib/deck-kit.mjs";

const PAPER = { bg: "#F4F3EF", ink: "#232326", muted: "#63646A", line: "#D8D6D0", panel: "#EBEAE4", panel2: "#E1DFD8", accent: "#B4700F", accent2: "#4B4C53", accentInk: "#8E5A0A" };
const DEEP = { bg: "#2B2C31", bg2: "#151618", ink: "#F4F3EF", muted: "#ABAAA5", line: "#3F4046", panel: "#34353B", panel2: "#3D3E45", accent: "#E9A63F", accent2: "#D6D2C8" };

/** The letter: the month in three typed paragraphs at left, signed by hand,
 *  and the three figures that matter pulled into a narrow column at the
 *  right, set in the mono. The slide the cover promises. */
function letter(K, i) {
  const g = K.paper;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, "The letter  ·  4 October 2026", "Dear investors,");
  const fill = [];
  const titleAt = nodes.findIndex((n) => n.kind === "text" && n.text === "Dear investors,");
  fill.push({ node: titleAt, label: "Salutation", hint: "Who the letter is to" });

  // Three paragraphs, each with room for four lines.
  const paras = [
    "September was the fourth month in a row above 8% growth. Revenue closed at $412K, expansion was a third of it, and logo churn fell to 1.1%, the lowest we have recorded. Burn did not move.",
    "We lost the platform lead we had courted since June to a counter-offer we chose not to match. The search has restarted with a new firm, and the data pipeline roadmap slips by three weeks. Nothing else on the plan moved.",
    "Three asks, on the last page: one introduction, two customer intros, and thirty minutes on pricing. If you have time for one, make it the pricing call; we think the self-serve tier is underpriced by half.",
  ];
  const colW = 1060;
  paras.forEach((p, k) => {
    nodes.push(text(M, bodyTop + k * 170, colW, 156, p, t.body(26, { color: g.ink })));
    fill.push({ node: nodes.length - 1, label: `Paragraph ${k + 1}`, hint: k === 0 ? "The month in one breath" : k === 1 ? "What went wrong, plainly" : "What you need from the reader" });
  });
  // Signed by hand, then the typed name.
  const signY = bodyTop + 2 * 170 + 156 + 28;
  nodes.push(text(M, signY, 600, 56, "Sam", t.kicker({ size: 44 })));
  fill.push({ node: nodes.length - 1, label: "Signature", hint: "Your first name" });
  nodes.push(text(M, signY + 62, 800, 26, "Sam Whitfield, Chief Executive, Beacon", t.meta()));
  fill.push({ node: nodes.length - 1, label: "Name and title", hint: "Who signs" });

  // The figures column: a hairline, an eyebrow, three numbers in the mono.
  const cx = 1316, cw = 508;
  nodes.push(rect(1252, bodyTop, 1, 600, g.line));
  nodes.push(text(cx, bodyTop, cw, 28, "In numbers", t.eyebrow()));
  const figs = [
    ["$412K", "Monthly recurring revenue", "+9% month over month"],
    ["$310K", "Net burn", "flat, as planned"],
    ["21 mo", "Runway at this burn", "before any pipeline closes"],
  ];
  figs.forEach(([n, l, d], k) => {
    const y = bodyTop + 52 + k * 196;
    nodes.push(text(cx, y, cw, 72, n, t.numeral(64, { family: K.mono, weight: 500 })));
    fill.push({ node: nodes.length - 1, label: `Figure ${k + 1}`, hint: "One number" });
    nodes.push(text(cx, y + 80, cw, 30, l, t.strong(22)));
    fill.push({ node: nodes.length - 1, label: `Label ${k + 1}`, hint: "What it measures" });
    nodes.push(text(cx, y + 114, cw, 26, d, t.meta({ color: g.accentInk ?? g.accent })));
    if (k < figs.length - 1) nodes.push(rect(cx, y + 160, cw, 1, g.line));
  });
  nodes.push(...note(K, g, "if you read one slide, read this one"));
  return { page: { name: "The letter", bg: g.bg, nodes }, fill };
}

const signature = { letter };

export default {
  id: "deck-investor-update",
  title: "Investor Update",
  base: "slate",
  rank: 54,
  tags: [
    "investors",
    "update",
    "metrics",
    "startup"
  ],
  meta: {
    company: "Beacon",
    deck: "Investor update, September",
    kicker: "monthly update, no spin",
    farewell: "Thank you for reading",
    art: {
      cover: "il-day21-lantern",
      section: "il-day36-abacus",
      picture: "il-day78-wallet",
      closing: "il-day6-open-vault"
    }
  },
  look: {
    display: "Schibsted Grotesk", dw: 700,
    body: "Public Sans", bw: 400,
    mono: "DM Mono",
    accentFace: "Kalam", accentWeight: 700, accentSize: 32,
    paper: PAPER,
    deep: DEEP,
    radius: 4,
    ornament: "dots",
    peeps: ["op-peep-33", "op-peep-68", "op-peep-15", "op-peep-94", "op-peep-2"],
    scale: { cover: 108, title: 58, section: 220, statement: 76, numeral: 96, quote: 50 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "September\nin one page",
        subtitle: "Revenue, burn and runway, what went right, what went wrong, and the three things we need from you.",
        presenter: "Sam Whitfield, Chief Executive  ·  4 October 2026",
        note: "read the letter first, the rest is the receipts"
      }
    ],
    [
      "raw",
      { build: signature.letter }
    ],
    [
      "figures",
      {
        eyebrow: "Metrics",
        title: "The four numbers",
        stats: [
          [
            "$412K",
            "Monthly recurring revenue",
            "+9% month over month",
            "Fourth straight month above 8%; expansion was a third of it."
          ],
          [
            "$310K",
            "Net burn",
            "Flat",
            "Two hires offset by the office move; contractors down to one."
          ],
          [
            "21",
            "Months of runway",
            "Plan holds",
            "At current burn, before any of the pipeline closes."
          ],
          [
            "112%",
            "Net revenue retention",
            "+2 pts",
            "Churn fell to 1.1%; two accounts doubled seats."
          ]
        ],
        note: "cash and contracted, nothing forecast"
      }
    ],
    [
      "chart",
      {
        eyebrow: "Metrics",
        title: "Revenue and burn, six months",
        takeaway: "Revenue has grown every month since April; burn has not moved. The gap is closing on schedule.",
        chartType: "line",
        categories: [
          "Apr",
          "May",
          "Jun",
          "Jul",
          "Aug",
          "Sep"
        ],
        series: [
          {
            name: "MRR",
            color: PAPER.accent,
            values: [
              268,
              292,
              318,
              346,
              378,
              412
            ]
          },
          {
            name: "Net burn",
            color: PAPER.accent2,
            values: [
              322,
              312,
              298,
              315,
              308,
              310
            ]
          }
        ],
        calls: [
          [
            "$412K",
            "MRR at month end"
          ],
          [
            "1.1%",
            "Logo churn, the lowest yet"
          ],
          [
            "Q2 2027",
            "Default-alive at this trajectory"
          ]
        ],
        note: "one axis for both lines, so the gap is honest"
      }
    ],
    [
      "bigStat",
      {
        eyebrow: "Default alive",
        value: "Q2 2027",
        caption: "The month revenue covers burn at this trajectory, before a raise and before any of the pipeline closes.",
        delta: "one month ahead"
      }
    ],
    [
      "twoColumns",
      {
        eyebrow: "Highlights and lowlights",
        title: "What went right, what went wrong",
        left: {
          eyebrow: "Right",
          head: "The self-serve tier started paying",
          lines: [
            "Thirty-one upgrades without a sales call",
            "Payback under four months on that cohort",
            "Support tickets per account down 40%"
          ],
          icon: "circle-check"
        },
        right: {
          eyebrow: "Wrong",
          head: "We lost the platform lead we wanted",
          lines: [
            "Counter-offer we could not match",
            "Search restarted with a new firm",
            "Roadmap slips by three weeks"
          ],
          icon: "alert-triangle"
        },
        note: "the counter-offer was 40% over band; we held the band"
      }
    ],
    [
      "threeCards",
      {
        eyebrow: "Asks",
        title: "Three things we need",
        cards: [
          [
            "user",
            "One introduction",
            "A head of platform engineering, ideally someone who has scaled a data pipeline past a billion events a day."
          ],
          [
            "briefcase",
            "Two customer intros",
            "Logistics or fleet operators with more than 500 vehicles. Two names would change Q4."
          ],
          [
            "message",
            "Thirty minutes of advice",
            "Pricing for the self-serve tier. We think we are underpriced by half and want a second opinion."
          ]
        ],
        note: "one reply with one name is enough"
      }
    ],
    [
      "closing",
      {
        title: "Thank you",
        subtitle: "Reply to this deck with anything; we read every note. The data room is updated with the September actuals.",
        rows: [
          [
            "mail",
            "sam@beacon.example"
          ],
          [
            "world",
            "beacon.example/investors"
          ],
          [
            "calendar",
            "Next update: 4 November"
          ]
        ],
        cta: "Open the data room",
        note: "bad news gets a call before it gets a slide"
      }
    ]
  ]
};
