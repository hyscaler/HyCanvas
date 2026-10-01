// Annual Report: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: a bound printed report. Bottle green and an antique gold on
// cream, a Baskerville display over a Franklin body, pencil notes in the
// margin, and the year ghosted into the bottom right corner of every page.
// The signature slide is the year strip: twelve months as a ribbon with the
// four moments that changed the company marked on it.

import { text, rect, ellipse, art, halo, note, chrome, type, linesFor, W, M, CW } from "../lib/deck-kit.mjs";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The four moments on the strip: the month (0-based), the quarter it
 *  headlines, the caption and a small drawing for it. */
const MOMENTS = [
  { month: 2, q: "Q1", when: "March", head: "The platform relaunch", body: "Six months of rebuild shipped in one week, with no customer downtime.", art: "il-day20-rocket" },
  { month: 5, q: "Q2", when: "June", head: "The Lisbon office", body: "Our first team outside the country, twenty-two people by year end.", art: "il-109-map-location" },
  { month: 8, q: "Q3", when: "September", head: "The partner programme", body: "Forty partners signed; a third of new customers now arrive through them.", art: "la-flat-character-illustrations" },
  { month: 11, q: "Q4", when: "December", head: "The thousandth seat", body: "An enterprise seat, signed on a call that started as a support ticket.", art: "il-day97-champagne" },
];

const signature = {
  /** The year strip: a ribbon of twelve months across the page, the four
   *  marked months filled solid with a gold pin, a small drawing in a halo
   *  above each, and the quarter's caption under a bracket below. */
  yearStrip(K, i) {
    const g = K.paper;
    const d = K.deep;
    const t = type(K, g);
    const { nodes, bodyTop } = chrome(K, g, i, "The big moments", "Twelve months, four that mattered");
    const illustrations = [];
    const fill = [];
    const cell = CW / 12;
    const colW = CW / 4;
    const ribbonY = 556, ribbonH = 72;
    const artY = 296, artW = 230, artH = 190;
    nodes.push(text(M, bodyTop - 8, 1100, 34, "Every month of the year, and the four that changed the company.", t.body(22)));

    // The ribbon: a panel with a hairline, month cells, quarter boundaries
    // stronger than month boundaries.
    nodes.push(rect(M, ribbonY, CW, ribbonH, g.panel, { stroke: g.line, strokeWidth: 1.5 }));
    const marked = new Set(MOMENTS.map((m) => m.month));
    MONTHS.forEach((name, m) => {
      const x = M + m * cell;
      if (marked.has(m)) nodes.push(rect(x, ribbonY, cell, ribbonH, g.accent));
      nodes.push(text(x, ribbonY + 24, cell, 26, name, { family: K.body, size: 16, weight: 600, letterSpacing: 3, upper: true, align: "center", color: marked.has(m) ? d.ink : g.muted, lineHeight: 1.2 }));
      if (m > 0 && m % 3 === 0) nodes.push(rect(x - 1, ribbonY, 2, ribbonH, g.accent, { opacity: 0.5 }));
      else if (m > 0) nodes.push(rect(x, ribbonY + 14, 1, ribbonH - 28, g.line));
    });

    // The caption row shares one body baseline: if any heading wraps in the
    // display face, every body sits below the two-line height, so the four
    // captions never stagger.
    const tall = MOMENTS.some((m) => linesFor(m.head, 26, colW - 24) > 1);
    MOMENTS.forEach((m, k) => {
      const mx = M + m.month * cell + cell / 2;
      // The drawing sits over its month, held inside the margin at the
      // end of the year.
      const ax = Math.min(mx - artW / 2, W - M - artW);
      const acx = ax + artW / 2;
      nodes.push(...halo(acx, artY + artH / 2, 250, g.accent));
      illustrations.push(art(m.art, ax, artY, artW, artH));
      // A tick from the drawing to the gold pin on the ribbon.
      nodes.push(rect(mx - 1, artY + artH + 14, 2, ribbonY - 8 - (artY + artH + 14), g.accent, { opacity: 0.45 }));
      nodes.push(ellipse(mx - 8, ribbonY - 8, 16, 16, g.accent2));
      // Below: a tick to the quarter bracket, then the caption in the
      // quarter's column.
      const x = M + k * colW;
      const bracketY = ribbonY + ribbonH + 22;
      nodes.push(rect(mx - 1, ribbonY + ribbonH, 2, 22, g.accent, { opacity: 0.45 }));
      nodes.push(rect(x, bracketY, colW - 24, 2, g.accent, { opacity: 0.35 }));
      nodes.push(text(x, bracketY + 18, colW - 24, 24, `${m.q}  ·  ${m.when}`, t.eyebrow({ size: 16, letterSpacing: 3 })));
      nodes.push(text(x, bracketY + 50, colW - 24, tall ? 64 : 34, m.head, t.display(26, { lineHeight: 1.15 })));
      fill.push({ node: nodes.length - 1, label: `${m.q} moment`, hint: "What happened, in a few words" });
      nodes.push(text(x, bracketY + (tall ? 126 : 96), colW - 24, 84, m.body, t.body(19)));
    });
    nodes.push(...note(K, g, "not on this strip: the outage. It has its own page."));
    return { page: { name: "The year strip", bg: g.bg, nodes, illustrations }, fill };
  },
};

export default {
  id: "deck-annual-report",
  title: "Annual Report",
  base: "atlas",
  rank: 64,
  tags: [
    "annual",
    "report",
    "year",
    "review"
  ],
  meta: {
    company: "Harbor & Vale",
    deck: "Annual report 2026",
    kicker: "Twelve months, one story",
    farewell: "With thanks",
    art: {
      cover: "il-day54-building",
      section: "il-day35-firework",
      picture: "il-day57-reading-room",
      closing: "il-day65-city-road"
    }
  },
  look: {
    display: "Libre Baskerville", dw: 600,
    body: "Libre Franklin", bw: 400,
    mono: null,
    accentFace: "Kalam", accentWeight: 400, accentSize: 38,
    paper: { bg: "#F6F1E6", ink: "#1B2A22", muted: "#5A655E", line: "#D8D0BE", panel: "#EEE7D7", panel2: "#E4DCC7", accent: "#1E5B45", accent2: "#7F5E17" },
    deep: { bg: "#16483A", bg2: "#0A2A20", ink: "#F6F1E6", muted: "#B9C9BE", line: "#2C5A4A", panel: "#1E5546", panel2: "#276353", accent: "#D9B25A", accent2: "#8FC9AC", accentInk: "#E2C06A" },
    radius: 4,
    ornament: "watermark",
    watermark: "26",
    peeps: ["op-peep-96", "op-peep-95", "op-peep-16", "op-peep-57", "op-peep-83"],
    scale: { cover: 112, title: 62, section: 236, statement: 80, numeral: 100, quote: 52 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "The year we\ngrew up",
        subtitle: "Growth, customers and the team, and the moments that tested us along the way.",
        presenter: "Elena Sato, Chief Executive  ·  February 2027",
        note: "start with the hard parts, page six, if you like"
      }
    ],
    [
      "figures",
      {
        eyebrow: "By the numbers",
        title: "The year in four figures",
        stats: [
          [
            "$64M",
            "Revenue",
            "+28% year over year",
            "Second consecutive year above plan, with services now a fifth of the mix."
          ],
          [
            "2,900",
            "Customers",
            "+610 net new",
            "Three of the ten largest arrived through partners."
          ],
          [
            "186",
            "People",
            "+52 this year",
            "Two new offices, one of them our first outside the country."
          ],
          [
            "94%",
            "Customer retention",
            "+3 pts",
            "Highest on record; the support rebuild paid for itself by August."
          ]
        ],
        note: "every figure here is in the accounts, page 31 onward"
      }
    ],
    [
      "chart",
      {
        eyebrow: "By the numbers",
        title: "Revenue by quarter",
        takeaway: "Software carried the first half; services, a fifth of the mix by December, carried the second.",
        chartType: "barGrouped",
        categories: ["Q1", "Q2", "Q3", "Q4"],
        series: [
          { name: "Software ($M)", values: [12.1, 12.8, 13.4, 13.9] },
          { name: "Services ($M)", values: [2.1, 2.6, 3.2, 3.9] }
        ],
        calls: [
          ["$64M", "Revenue for the year, up 28%"],
          ["$11.8M", "Services revenue, a fifth of the mix"],
          ["$17.8M", "Q4, the first quarter above $17M"]
        ],
        note: "every quarter beat the one before it, a first for us"
      }
    ],
    [
      "section",
      {
        n: "01",
        title: "The big moments",
        blurb: "Four quarters, four things that changed the company.",
        kicker: "Four dates we will remember",
        art: "il-day35-firework"
      }
    ],
    [
      "raw",
      { build: signature.yearStrip }
    ],
    [
      "twoColumns",
      {
        eyebrow: "The hard parts",
        title: "What tested us",
        left: {
          eyebrow: "What went wrong",
          head: "The outage in May",
          lines: [
            "Nine hours, four hundred customers affected",
            "Root cause in a vendor we had not audited",
            "Two customers left over it"
          ],
          icon: "alert-triangle"
        },
        right: {
          eyebrow: "What we changed",
          head: "Reliability became a team",
          lines: [
            "Every vendor audited by September",
            "A named on-call owner for each service",
            "Uptime above 99.95% since June"
          ],
          icon: "circle-check"
        },
        note: "Elena called both customers who left, herself"
      }
    ],
    [
      "quote",
      {
        text: "They told us what broke, what they were doing about it, and when it would be fixed. That is why we stayed.",
        name: "Rowan Achebe",
        role: "Chief Information Officer, Brightline Logistics",
        note: "Brightline renewed for three years in January"
      }
    ],
    [
      "team",
      {
        eyebrow: "Thank you",
        title: "The people who made it",
        people: [
          [
            "Elena Sato",
            "Chief Executive",
            "Set the plan and kept every promise in it."
          ],
          [
            "Marcus Obi",
            "Chief Operating Officer",
            "Opened Lisbon and built the partner programme."
          ],
          [
            "Priya Raman",
            "Head of Product",
            "Led the relaunch and the platform team."
          ],
          [
            "Dana Whitfield",
            "Head of Customers",
            "Rebuilt support and won back the trust."
          ]
        ],
        note: "and the 182 people who are not on this page"
      }
    ],
    [
      "closing",
      {
        title: "The year ahead",
        subtitle: "Three markets, one new product line, and the same promise: tell the truth early.",
        rows: [
          [
            "mail",
            "elena@harborvale.example"
          ],
          [
            "world",
            "harborvale.example/2026"
          ],
          [
            "file-text",
            "Full report and accounts attached"
          ]
        ],
        cta: "Read the full report",
        art: "il-day65-city-road",
        note: "questions to Elena, any time before the AGM"
      }
    ]
  ]
};
