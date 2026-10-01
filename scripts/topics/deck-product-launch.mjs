// Product Launch Plan: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: black and hot orange on a pale sand, a wide grotesk for every
// title and numeral, a wide mono for the labels, a marker hand for the
// notes. A countdown: one orange triangle in the corner like the flag on a
// launch board, sharp corners, the hot orange kept for rules, bars and the
// deep pages, and a brick orange for any accent that has to read as text on
// the sand.

import { text, rect, ellipse, halo, sparkles, footer, type, deepGround, ornamentDeep, W, M, CW } from "../lib/deck-kit.mjs";

// --- the signature slide -------------------------------------------------------

/** The countdown: the days to launch as one enormous numeral in a halo,
 *  and launch day itself as a timed row beneath, 06:00 to 18:00, with the
 *  three moments (press, live, webinar) as ticks on the axis. The number
 *  is the only thing on this page that changes from week to week. */
const signature = {
  countdown(K, i) {
    const g = K.deep;
    const t = type(K, g);
    const mono = K.mono ?? K.body;
    // The corner ornament is a square rotated about its top-left corner: a
    // flag hanging from the top edge, widest near the top, its point at
    // (1560, 655). Its sparkle would land where the numeral sits; keep the
    // flag, move the sparkle into the dark gap between the numeral and the
    // flag, where no text sits.
    const nodes = ornamentDeep(K, g).filter((n) => n.kind !== "ellipse");
    nodes.push(...sparkles(g.ink, 27, 5, { x: 840, y: 100, w: 170, h: 500 }));
    const fill = [];

    // The reading grid's eyebrow baseline, kept on the deep ground.
    nodes.push(text(M, 88, 1100, 28, "T minus  ·  launch day is Thursday 12 November", t.eyebrow()));
    fill.push({ node: nodes.length - 1, label: "Launch day", hint: "The date, spelled out" });

    // The numeral: the days left, lit by a halo, as large as the page allows.
    nodes.push(...halo(M + 340, 390, 760, g.accent));
    nodes.push(text(M - 10, 130, 1000, 480, "42", t.numeral(460)));
    fill.push({ node: nodes.length - 1, label: "Days", hint: "Days to launch; update it every Monday" });
    nodes.push(text(M, 618, 1000, 60, "days to launch", t.display(48)));

    // In the flag, in black on the orange: the one line that does not
    // change, and the note under it. Each line is short enough to sit
    // inside the flag at its own height.
    const inkOnFlag = g.bg2;
    nodes.push(text(1200, 190, 720, 130, "Five owners.\nOne date.\nNothing moves it.", t.display(36, { color: inkOnFlag, align: "center" })));
    fill.push({ node: nodes.length - 1, label: "Statement", hint: "Three short lines" });
    nodes.push(text(1280, 330, 560, 44, "update the number every Monday", t.kicker({ color: inkOnFlag, align: "center", size: Math.round(K.accentSize * 0.85) })));

    // Beneath: launch day as a timed row, 06:00 to 18:00. The window from
    // the press embargo to the webinar is in the accent; each moment is a
    // tick with its time above and its heading and line below.
    const ax = M, aw = CW, ay = 800;
    const atX = (h) => Math.round(ax + (aw * (h - 6)) / 12);
    nodes.push(rect(ax, ay, aw, 2, g.line));
    nodes.push(rect(atX(7), ay - 1, atX(16) - atX(7), 4, g.accent));
    nodes.push(text(ax, 748, 100, 26, "06:00", t.meta()));
    nodes.push(text(W - M - 100, 748, 100, 26, "18:00", t.meta({ align: "right" })));
    const moments = [
      [7, "07:00", "Press", "Embargo lifts. Three pieces, two analysts briefed."],
      [9, "09:00", "Product live", "Insights on for every customer, in-app note out."],
      [16, "16:00", "Webinar", "Live demo on pilot data. Every rep on the call."],
    ];
    moments.forEach(([h, tm, head, sub]) => {
      const px = atX(h);
      nodes.push(ellipse(px - 12, ay - 11, 24, 24, g.accent));
      nodes.push(ellipse(px - 5, ay - 4, 10, 10, g.bg2));
      nodes.push(text(px - 12, 748, 200, 30, tm, { family: mono, size: 24, weight: 700, color: g.accent, lineHeight: 1.2 }));
      nodes.push(text(px - 12, 832, 270, 36, head, t.display(26)));
      fill.push({ node: nodes.length - 1, label: head, hint: "A launch-day moment" });
      nodes.push(text(px - 12, 872, 270, 56, sub, t.body(19)));
    });

    nodes.push(...footer(K, g, i));
    return { page: { name: "Countdown", bg: deepGround(g), nodes }, fill };
  },
};

export default {
  id: "deck-product-launch",
  title: "Product Launch Plan",
  base: "pulse",
  rank: 36,
  tags: [
    "launch",
    "product",
    "marketing",
    "gtm"
  ],
  meta: {
    company: "Loop",
    deck: "Launch plan: Loop Insights",
    kicker: "T minus 42 days",
    farewell: "Launch day is 12 November",
    art: {
      cover: "il-day17-walkie-talkie",
      section: "il-day35-firework",
      picture: "il-day37-calculator",
      closing: "il-day97-champagne"
    }
  },
  look: {
    display: "Unbounded", dw: 800,
    body: "Hanken Grotesk", bw: 400,
    mono: "Martian Mono",
    accentFace: "Permanent Marker", accentWeight: 400, accentSize: 32,
    // The base look carries a lime and a lime accentInk on deep; both are
    // cleared here so the deck has two colours and no third.
    paper: { bg: "#F2E9D8", ink: "#141210", muted: "#5A544B", line: "#D8CCB4", panel: "#EAE0CB", panel2: "#E0D3B8", accent: "#FF4A00", accent2: "#141210", accentInk: "#9E2B00", lime: undefined },
    deep: { bg: "#181614", bg2: "#070605", ink: "#F2E9D8", muted: "#B3AA99", line: "#302B25", panel: "#232019", panel2: "#2E2922", accent: "#FF4A00", accent2: "#F2E9D8", accentInk: "#FF4A00", lime: undefined },
    radius: 4,
    ornament: "corner",
    peeps: ["op-peep-10", "op-peep-43", "op-peep-69", "op-peep-100", "op-peep-28"],
    scale: { cover: 92, title: 50, section: 200, statement: 68, numeral: 84, quote: 42 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "42 days to\nLoop Insights",
        subtitle: "Payroll analytics for finance leaders, in one sentence: see next month's cost before you run this month's payroll.",
        presenter: "Mei Lin, Product Marketing  ·  1 October 2026",
        chips: [
          ["42", "days to go"],
          ["12", "pilots live"],
          ["5", "owners"]
        ],
        note: "every date here has a name next to it"
      }
    ],
    [
      "textPicture",
      {
        eyebrow: "Who it is for",
        title: "Who buys, and when",
        points: [
          [
            "Finance leaders",
            "At 200 to 2,000 people. They present headcount cost to the board quarterly and rebuild the number by hand every time."
          ],
          [
            "The week before the board pack",
            "Every competitor sells to payroll operators. Nobody sells to the person who has to explain the number."
          ],
          [
            "The insight they missed",
            "The data is already in payroll. The product is the question, not the spreadsheet."
          ]
        ],
        art: "il-day37-calculator",
        note: "we sold to the wrong desk for two years"
      }
    ],
    [
      "threeCards",
      {
        eyebrow: "Positioning",
        title: "Category, promise, proof",
        cards: [
          [
            "flag",
            "The category we claim",
            "Payroll analytics. Not reporting, not BI: answers to the questions a finance leader is actually asked."
          ],
          [
            "sparkles",
            "The promise we make",
            "See next month's cost before you run this month's payroll."
          ],
          [
            "chart-pie",
            "The proof we bring",
            "Twelve pilot customers cut board-pack preparation from three days to one afternoon."
          ]
        ],
        note: "say the promise the same way, everywhere"
      }
    ],
    [
      "quote",
      {
        text: "We rebuilt the headcount number\nby hand for six years. Last quarter\nthe board pack took one afternoon.",
        name: "Dana Okafor",
        role: "Finance Director, Calder Freight. Pilot customer since July",
        note: "nine of the twelve pilots said this"
      }
    ],
    [
      "timeline",
      {
        eyebrow: "Launch timeline",
        title: "Teaser, launch, and after",
        done: 0,
        steps: [
          [
            "29 Oct",
            "Teaser",
            "Pilot customers post their numbers; the waitlist page goes live."
          ],
          [
            "12 Nov",
            "Launch day",
            "Product live for every customer, press at 07:00, webinar at 16:00."
          ],
          [
            "19 Nov",
            "Follow-through",
            "Case studies from two pilots; every rep runs the demo with live data."
          ],
          [
            "10 Dec",
            "Review",
            "Day-30 metrics, the pricing decision, and what the next release fixes."
          ]
        ],
        note: "forty-two days, four dates, zero slipped"
      }
    ],
    [
      "table",
      {
        eyebrow: "Channels and owners",
        title: "Five channels, five owners",
        cols: [
          "",
          "Owner",
          "Ready by",
          "Day-one target"
        ],
        rows: [
          [
            "Product and in-app",
            "Priya",
            "5 Nov",
            "Every customer sees it"
          ],
          [
            "Email and blog",
            "Mei",
            "10 Nov",
            "40% open rate"
          ],
          [
            "Press and analysts",
            "Elena",
            "11 Nov",
            "Three pieces"
          ],
          [
            "Paid search and social",
            "Jonah",
            "12 Nov",
            "2,000 visits"
          ],
          [
            "Partners",
            "Marcus",
            "12 Nov",
            "Ten partner posts"
          ]
        ],
        note: "if your date slips, say so on the Monday"
      }
    ],
    [
      "raw",
      {
        build: signature.countdown
      }
    ],
    [
      "figures",
      {
        eyebrow: "Success metrics",
        title: "Day 1, day 7, day 30",
        stats: [
          [
            "60%",
            "Customers who open it",
            "Day 1",
            "Of active customers, in the product, on launch day."
          ],
          [
            "25%",
            "Weekly active",
            "Day 7",
            "Customers who come back to it in the first week."
          ],
          [
            "40",
            "Upgrades",
            "Day 30",
            "Accounts on the Insights tier by December."
          ],
          [
            "$80K",
            "New monthly revenue",
            "Day 30",
            "From upgrades and two new logos won on the launch."
          ]
        ],
        note: "we call it on day 30, not day 1"
      }
    ],
    [
      "closing",
      {
        title: "Launch day",
        subtitle: "12 November. If it is not on the checklist, it does not ship. Screenshot this page.",
        rows: [
          [
            "message",
            "#launch-insights on Slack"
          ],
          [
            "mail",
            "mei@loop.example"
          ],
          [
            "calendar",
            "Retro: 13 November, 15:00"
          ]
        ],
        cta: "Open the launch checklist",
        art: "il-day97-champagne",
        note: "the retro is already on the calendar"
      }
    ]
  ]
};
