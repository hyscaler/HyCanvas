// Marketing Plan: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: magenta and ink on warm white with a mustard second accent, a
// high-contrast editorial serif for titles, a plain grotesque for reading
// and a marker hand for the notes. One magenta corner on every page is the
// spine; the creative half is the copy. The signature slide is the
// calendar: the year as twelve columns, four campaign bars spanning their
// months in the two accents, each bar labelled, its budget share under it,
// and an ink bar along the bottom for the always-on work.

import { text, rect, chrome, note, type, inkOn, mixHex, M, CW } from "../lib/deck-kit.mjs";

// --- the calendar ------------------------------------------------------------

const CALENDAR = {
  eyebrow: "The calendar",
  title: "Four campaigns across the year",
  months: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  // [name, first month, last month (inclusive), spend, share, the moment]
  campaigns: [
    ["The Friday campaign", 1, 4, "$640K", "34%", "Launch film on 14 January, a customer story a week after"],
    ["The report", 4, 6, "$300K", "16%", "Published 5 May; the briefings run through June"],
    ["Partner season", 7, 10, "$360K", "19%", "Twenty partners, one co-written story a week"],
    ["The conference", 9, 12, "$460K", "24%", "Four hundred people on 12 November; the 2028 plan from the stage"],
  ],
  alwaysOn: ["Always on: search, content, community", "$140K", "7%"],
  legend: "A bar spans the months a campaign is live; the figure under it is its share of the $1.9M.",
  note: "the overlaps are on purpose",
};

/** The calendar: a reading page whose body is the year, twelve columns
 *  under a heavy rule, the odd quarters banded. Each campaign is one bar in
 *  an accent, its name inside, its spend and share under it, and its one
 *  moment beside it. The always-on work is an ink bar along the bottom. */
function calendar(K, i) {
  const g = K.paper;
  const t = type(K, g);
  const c = CALENDAR;
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
  const fill = [{ node: nodes.findIndex((n) => n.text === c.title), label: "Title", hint: "One short line" }];
  const colW = CW / 12;
  const headY = bodyTop;
  const gridTop = headY + 36;
  const pitch = 112, barH = 50;
  // The month row sits inside the grid, under the heavy rule, clear of the
  // corner mark; the first bar starts under it.
  const firstBar = gridTop + 54;
  const onY = firstBar + c.campaigns.length * pitch;
  const gridBottom = onY + 30 + 20;
  const gridH = gridBottom - gridTop;
  // The odd quarters on a band, then the month rules, heavier at a quarter.
  [1, 3].forEach((q) => nodes.push(rect(M + q * 3 * colW, gridTop, 3 * colW, gridH, g.panel)));
  for (let m = 0; m <= 12; m++) nodes.push(rect(M + m * colW - (m === 12 ? 1 : 0), gridTop, 1, gridH, m % 3 === 0 ? mixHex(g.line, g.ink, 0.3) : g.line));
  c.months.forEach((mo, m) => nodes.push(text(M + m * colW, gridTop + 12, colW, 24, mo, t.eyebrow({ size: 15, letterSpacing: 3, align: "center", color: g.ink }))));
  nodes.push(rect(M, gridTop, CW, 2, g.ink));
  nodes.push(rect(M, gridBottom, CW, 2, g.ink));
  c.campaigns.forEach(([name, from, to, spend, share, moment], k) => {
    const y = firstBar + k * pitch;
    const x0 = M + (from - 1) * colW + 6;
    const x1 = M + to * colW - 6;
    const tone = k % 2 ? g.accent2 : g.accent;
    nodes.push(rect(x0, y, x1 - x0, barH, tone, { radius: K.radius }));
    nodes.push(text(x0 + 20, y + 11, x1 - x0 - 40, 28, name, t.strong(21, { color: inkOn(K, tone) })));
    fill.push({ node: nodes.length - 1, label: `Campaign ${k + 1}`, hint: "The campaign's name" });
    nodes.push(text(x0, y + barH + 8, Math.max(x1 - x0, 420), 24, `${spend}  ·  ${share} of the budget`, t.meta({ size: 17, color: k % 2 ? (g.accent2Ink ?? g.accent2) : (g.accentInk ?? g.accent), weight: 600 })));
    // The one moment, beside the bar on whichever side has the room.
    if (from > 6) nodes.push(text(M, y + 12, x0 - M - 20, 28, moment, t.body(18, { align: "right" })));
    else nodes.push(text(x1 + 20, y + 12, M + CW - x1 - 20, 28, moment, t.body(18)));
  });
  // The always-on work: one ink bar across every month.
  nodes.push(rect(M + 6, onY, CW - 12, 30, g.ink, { radius: K.radius }));
  nodes.push(text(M + 26, onY + 5, 900, 22, c.alwaysOn[0], t.strong(16, { color: g.bg })));
  nodes.push(text(M + CW - 6 - 340, onY + 5, 320, 22, `${c.alwaysOn[1]}  ·  ${c.alwaysOn[2]} of the budget`, t.strong(16, { color: g.bg, align: "right" })));
  [0, 1, 2, 3].forEach((q) => nodes.push(text(M + q * 3 * colW, gridBottom + 12, 3 * colW, 22, `Q${q + 1}`, t.eyebrow({ size: 14, letterSpacing: 3, align: "center", color: g.muted }))));
  nodes.push(text(M, gridBottom + 48, 1000, 26, c.legend, t.meta({ size: 17 })));
  nodes.push(...note(K, g, c.note));
  return { page: { name: "Calendar", bg: g.bg, nodes }, fill };
}

const signature = { calendar };

export default {
  id: "deck-marketing-plan",
  title: "Marketing Plan",
  base: "folio",
  rank: 80,
  tags: [
    "marketing",
    "plan",
    "campaign",
    "strategy"
  ],
  meta: {
    company: "Meridian Studio",
    deck: "Marketing plan 2027",
    kicker: "Creative, with a spine",
    farewell: "And then we measure it",
    art: {
      cover: "il-day17-walkie-talkie",
      section: "il-day70-designer-fav-tool-wacom",
      picture: "la-youtube-illustration",
      closing: "il-day42-imac"
    }
  },
  look: {
    display: "DM Serif Display", dw: 400,
    body: "Work Sans", bw: 400,
    mono: null,
    accentFace: "Gochi Hand", accentWeight: 400, accentSize: 38,
    paper: { bg: "#FBF7F0", ink: "#1E1822", muted: "#665C6B", line: "#E3D9CC", panel: "#F3ECE0", panel2: "#E9DFD0", accent: "#C2185B", accent2: "#E3A91B", accent2Ink: "#7F5B0E" },
    deep: { bg: "#241A2B", bg2: "#110A16", ink: "#FBF7F0", muted: "#B7ABBE", line: "#3D2F45", panel: "#2E2237", panel2: "#392B43", accent: "#DA3283", accentInk: "#FF8AC2", accent2: "#F2C14E" },
    radius: 6,
    ornament: "corner",
    art: { cover: "il-day17-walkie-talkie", section: "il-day70-designer-fav-tool-wacom", picture: "la-youtube-illustration", closing: "il-day42-imac" },
    peeps: ["op-peep-2", "op-peep-16", "op-peep-19", "op-peep-34", "op-peep-46"],
    scale: { cover: 112, title: 62, section: 230, statement: 78, numeral: 100, quote: 54 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "What marketing\nowes the business",
        subtitle: "The objective, the audience, the big idea, the calendar, the budget, and the dashboard we will check every week.",
        presenter: "Mei Lin, Head of Marketing  ·  12 December 2026",
        note: "a year, four campaigns, one Friday"
      }
    ],
    [
      "figures",
      {
        eyebrow: "The objective",
        title: "What we owe the business in 2027",
        stats: [
          [
            "$9M",
            "Sourced pipeline",
            "+50% on 2026",
            "Marketing-sourced, first touch, measured in the CRM."
          ],
          [
            "2,400",
            "Qualified leads",
            "200 a month",
            "Up from 140; the free tier is the largest new source."
          ],
          [
            "38%",
            "Share of voice",
            "+10 pts",
            "In our category, measured quarterly by the analyst survey."
          ],
          [
            "$1.9M",
            "Budget",
            "Flat",
            "Same money, reweighted toward the channels that worked."
          ]
        ],
        note: "same money, aimed better"
      }
    ],
    [
      "table",
      {
        eyebrow: "The audience",
        title: "Segments, moments and messages",
        cols: [
          "",
          "Moment",
          "Message",
          "Channel"
        ],
        rows: [
          [
            "Founders, 10 to 50 people",
            "First hire in ops",
            "Set up in an afternoon",
            "Product and community"
          ],
          [
            "Ops leads, 50 to 500",
            "The spreadsheet broke",
            "One place for the whole team",
            "Search and content"
          ],
          [
            "Directors, 500 plus",
            "Board asks for the number",
            "Answers, not reports",
            "Events and partners"
          ],
          [
            "Partners",
            "Their client asks",
            "Refer and earn",
            "Partner programme"
          ],
          [
            "Free-tier teams",
            "Hit the seat limit",
            "Bring the whole team",
            "In-app and email"
          ]
        ],
        note: "one line per person, or it is not a message"
      }
    ],
    [
      "section",
      {
        n: "2027",
        kicker: "The creative half",
        title: "One idea, then the year",
        blurb: "One idea, four campaigns, twelve months and one budget. Everything after this page is how the money gets spent.",
        art: "il-day70-designer-fav-tool-wacom",
        note: "argue with the calendar, not the idea"
      }
    ],
    [
      "statement",
      {
        text: "The big idea: show the afternoon a team gets back. Not the features, the Friday.",
        source: "Campaign concept, 2027",
        note: "the whole campaign in one breath"
      }
    ],
    [
      "raw",
      {
        build: signature.calendar
      }
    ],
    [
      "chart",
      {
        eyebrow: "The budget",
        title: "Spend by channel, with expected return",
        takeaway: "Content and partners carry the plan; events are the bet; paid stays capped.",
        chartType: "barGrouped",
        categories: [
          "Content",
          "Partners",
          "Events",
          "Paid",
          "Brand"
        ],
        series: [
          {
            name: "Spend ($K)",
            values: [
              520,
              380,
              460,
              300,
              240
            ]
          },
          {
            name: "Expected pipeline ($K)",
            values: [
              3100,
              2600,
              1800,
              900,
              600
            ]
          }
        ],
        calls: [
          [
            "6x",
            "Content pipeline against spend"
          ],
          [
            "4x",
            "Events, the bet of the year"
          ],
          [
            "3x",
            "Paid, capped at $300K"
          ]
        ],
        note: "content earns it, events bet it"
      }
    ],
    [
      "fourCards",
      {
        eyebrow: "The dashboard",
        title: "Four numbers, every Monday",
        cards: [
          [
            "chart-pie",
            "Sourced pipeline",
            "$9M for the year, so $750K a month. First touch, in the CRM, nothing counted by hand."
          ],
          [
            "user",
            "Qualified leads",
            "200 a month. The free tier is the largest new source and gets its own line."
          ],
          [
            "microphone",
            "Share of voice",
            "38% by Q4. The analyst survey each quarter, mentions each month in between."
          ],
          [
            "coin",
            "Cost per lead",
            "$790 or under. A channel above $1,200 for two months in a row loses its money."
          ]
        ],
        note: "miss twice and the money moves"
      }
    ],
    [
      "closing",
      {
        title: "How we will know",
        subtitle: "One dashboard, four numbers, checked every Monday at nine. If a channel misses two months, we move its money.",
        rows: [
          [
            "mail",
            "mei@meridian.example"
          ],
          [
            "world",
            "meridian.example/marketing"
          ],
          [
            "calendar",
            "Weekly review: Mondays, 09:00"
          ]
        ],
        cta: "Open the dashboard",
        art: "il-day42-imac",
        note: "Mondays at nine, coffee provided"
      }
    ]
  ]
};
