// Go-to-Market Strategy: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: forest and brass on stone. A sturdy serif for the titles, a
// plain sans for the reading, a quick pen for the notes. Range rings off the
// corner, the way a field map draws its distances; brass for what we do,
// forest for the gate we have to pass. A field plan: staged, and decisive.

import { text, rect, ellipse, icon, card, type, chrome, note, mixHex, deepGround, M, CW } from "../lib/deck-kit.mjs";

// --- the signature slide -------------------------------------------------------

/** The motion map: the three buyers as columns, each with the promise we
 *  make, the proof we carry and the channel it travels; beneath them, on the
 *  deep ground, the ninety days as one band from soft launch to the week
 *  the plan doubles or cuts. Every column drops a line into the band: the
 *  message on top, the sequence that carries it below. */
const signature = {
  motionMap(K, i) {
    const g = K.paper;
    const d = K.deep;
    const t = type(K, g);
    const td = type(K, d);
    const { nodes, bodyTop } = chrome(K, g, i, "The message", "The promise, the proof, the channel");
    const fill = [];

    // Three persona columns. Brass for the two who buy, forest for the one
    // who can block: the colour bar says which side of the deal they sit on.
    const cw = (CW - 48) / 3;
    const y = bodyTop;
    const ch = 432;
    const personas = [
      ["briefcase", "Operations director", "Signs the deal", g.accent, g.accentInk ?? g.accent, [
        ["Promise", "Two points of uptime"],
        ["Proof", "The Brightline case study"],
        ["Channel", "Partner referral, then an executive brief"],
      ]],
      ["truck", "Dispatch lead", "Uses it nine hours a day", g.accent, g.accentInk ?? g.accent, [
        ["Promise", "Nothing to learn on Monday"],
        ["Proof", "A ninety-second demo"],
        ["Channel", "A two-week pilot on their own routes"],
      ]],
      ["shield", "IT and security", "Can block it in one call", g.accent2, g.accent2Ink ?? g.accent2, [
        ["Promise", "Your data stays yours"],
        ["Proof", "The certifications page"],
        ["Channel", "The questionnaire, answered before they ask"],
      ]],
    ];
    const drops = [];
    personas.forEach(([ic, name, role, tone, toneInk, rows], k) => {
      const x = M + k * (cw + 24);
      nodes.push(card(K, g, x, y, cw, ch));
      nodes.push(rect(x, y, cw, 6, tone, { radius: 0 }));
      nodes.push(ellipse(x + 36, y + 34, 64, 64, mixHex(g.panel, tone, 0.2)));
      nodes.push(icon(ic, x + 52, y + 50, 32, tone));
      nodes.push(text(x + 116, y + 30, cw - 152, 36, name, t.display(28)));
      fill.push({ node: nodes.length - 1, label: `Buyer ${k + 1}`, hint: "Who this column is for" });
      nodes.push(text(x + 116, y + 70, cw - 152, 24, role, t.meta({ size: 17 })));
      nodes.push(rect(x + 36, y + 120, cw - 72, 1, g.line));
      rows.forEach(([label, value], j) => {
        const ry = y + 146 + j * 96;
        nodes.push(text(x + 36, ry, cw - 72, 20, label, t.eyebrow({ size: 14, letterSpacing: 3, color: toneInk })));
        nodes.push(text(x + 36, ry + 26, cw - 72, 60, value, t.strong(22)));
        if (j === 0) fill.push({ node: nodes.length - 1, label: `Promise ${k + 1}`, hint: "One line they would repeat" });
      });
      // The drop line from the column into the band beneath.
      nodes.push(rect(x + cw / 2 - 1, y + ch, 2, 28, g.line));
      drops.push([x + cw / 2, tone]);
    });

    // The band: the ninety days on the deep ground, four stages on one track.
    const bx = M, by = y + ch + 28, bw = CW, bh = 176;
    nodes.push(rect(bx, by, bw, bh, deepGround(d), { radius: K.radius }));
    for (const [cx, tone] of drops) nodes.push(ellipse(cx - 6, by - 6, 12, 12, tone));
    nodes.push(text(bx + 40, by + 30, 270, 24, "The first ninety days", td.eyebrow({ size: 15, letterSpacing: 3 })));
    nodes.push(text(bx + 40, by + 62, 270, 72, "Soft launch\nto scale", td.display(30)));
    nodes.push(rect(bx + 304, by + 28, 1, bh - 56, d.line));
    const tx0 = bx + 348, sw = 334, ty = by + 84;
    nodes.push(rect(tx0, ty + 6, 4 * sw, 3, d.muted, { opacity: 0.5 }));
    const stages = [
      ["Weeks 1 to 2", "Soft launch", "Ten design partners live"],
      ["Weeks 3 to 6", "Partner enablement", "Forty partners trained"],
      ["Weeks 7 to 10", "Outbound at volume", "Two reps on the top 300"],
      ["Weeks 11 to 13", "Scale or stop", "Double two channels, cut one"],
    ];
    stages.forEach(([week, head, sub], k) => {
      const nx = tx0 + k * sw;
      nodes.push(text(nx - 8, by + 30, sw - 30, 22, week, td.eyebrow({ size: 14, letterSpacing: 3 })));
      nodes.push(ellipse(nx - 8, ty - 1, 16, 16, k === 0 ? d.accent : d.bg, k === 0 ? {} : { stroke: d.accent, strokeWidth: 3 }));
      nodes.push(text(nx - 8, ty + 30, sw - 30, 28, head, td.strong(21)));
      nodes.push(text(nx - 8, ty + 60, sw - 30, 22, sub, td.meta({ size: 15 })));
    });
    const ex = tx0 + 4 * sw;
    nodes.push(ellipse(ex - 8, ty - 1, 16, 16, d.accent2));
    nodes.push(text(ex - 128, by + 30, 136, 22, "Day 90", td.eyebrow({ size: 14, letterSpacing: 3, align: "right", color: d.accent2 })));

    nodes.push(...note(K, g, "if you keep one page, keep this one"));
    return { page: { name: "Motion map", bg: g.bg, nodes }, fill };
  },
};

export default {
  id: "deck-gtm-strategy",
  title: "Go-to-Market Strategy",
  base: "atlas",
  rank: 58,
  tags: [
    "gtm",
    "strategy",
    "sales",
    "marketing"
  ],
  meta: {
    company: "Northwind Systems",
    deck: "Go-to-market: Fleet Edition",
    kicker: "The motion",
    farewell: "What we will watch",
    art: {
      cover: "il-day65-city-road",
      section: "il-109-map-location",
      picture: "il-day14-forklift",
      closing: "il-day66-travel"
    }
  },
  look: {
    display: "Vollkorn", dw: 700,
    body: "Work Sans", bw: 400,
    mono: null,
    accentFace: "Gochi Hand", accentWeight: 400, accentSize: 36,
    paper: { bg: "#ECE8DF", ink: "#16281E", muted: "#4E5A52", line: "#D3CEC2", panel: "#E3DED3", panel2: "#D9D3C6", accent: "#A87A22", accent2: "#2E5C42", accentInk: "#7C5A14" },
    deep: { bg: "#1C3A2E", bg2: "#0E2119", ink: "#ECE8DF", muted: "#A8B7AC", line: "#2F5142", panel: "#254735", panel2: "#2D5540", accent: "#D3A84E", accent2: "#9CC7A8", accentInk: "#E0B95E" },
    radius: 6,
    ornament: "arcs",
    peeps: ["op-peep-28", "op-peep-54", "op-peep-70", "op-peep-11", "op-peep-97"],
    scale: { cover: 116, title: 62, section: 236, statement: 80, numeral: 104, quote: 54 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "How Fleet Edition\nreaches its buyer",
        subtitle: "The buyer, the message per persona, the channels and what each costs, and the first ninety days from soft launch to scale.",
        presenter: "Marcus Obi, VP Sales  ·  November 2026",
        chips: [["3", "buyers"], ["5", "channels"], ["90", "days"]],
        note: "read it as a field plan, not a forecast"
      }
    ],
    [
      "threeCards",
      {
        eyebrow: "The buyer",
        title: "Who signs, who uses, who blocks",
        cards: [
          [
            "briefcase",
            "Signs: the operations director",
            "Owns the fleet budget and the uptime number. Buys when a peer has already bought."
          ],
          [
            "truck",
            "Uses: the dispatch lead",
            "Lives in the tool nine hours a day. If the first week is hard, the deal dies at renewal."
          ],
          [
            "shield",
            "Blocks: IT and security",
            "Asks about data residency and SSO in the first call. Answer before they ask."
          ]
        ],
        note: "the blocker gets the first call, not the last"
      }
    ],
    [
      "section",
      {
        n: "01",
        title: "The motion",
        blurb: "One promise per buyer, proof they can check, and a channel that carries it. Then ninety days, staged.",
        kicker: "Where the plan starts",
        note: "three buyers, one route"
      }
    ],
    [
      "raw",
      { build: signature.motionMap }
    ],
    [
      "chart",
      {
        eyebrow: "The channels",
        title: "Where the motion runs, and what each costs",
        takeaway: "Partners bring the cheapest pipeline; paid search the most expensive. The plan weights accordingly.",
        categories: [
          "Partners",
          "Outbound",
          "Events",
          "Inbound",
          "Paid"
        ],
        series: [
          {
            name: "Cost per opportunity ($K)",
            values: [
              1.8,
              3.4,
              4.1,
              2.2,
              6.5
            ]
          }
        ],
        calls: [
          [
            "$1.8K",
            "Cost per opportunity through partners"
          ],
          [
            "45%",
            "Of pipeline expected from partners and inbound"
          ],
          [
            "$6.5K",
            "Paid search, capped at 10% of budget"
          ]
        ],
        note: "partners first, paid last"
      }
    ],
    [
      "timeline",
      {
        eyebrow: "The first 90 days",
        title: "From soft launch to scale",
        done: 0,
        steps: [
          [
            "Weeks 1 to 2",
            "Soft launch",
            "Ten design partners live; every call recorded and reviewed on Friday."
          ],
          [
            "Weeks 3 to 6",
            "Partner enablement",
            "Forty partners trained; the referral offer goes live."
          ],
          [
            "Weeks 7 to 10",
            "Outbound at volume",
            "Two reps on the top 300 accounts with the case study in hand."
          ],
          [
            "Weeks 11 to 13",
            "Scale or stop",
            "Review by channel. Double the two that work; cut the one that does not."
          ]
        ],
        note: "we cut on the number, not on a feeling"
      }
    ],
    [
      "quote",
      {
        text: "Two points of uptime is a number my board understands. The pilot proved it in a fortnight, and dispatch never once called support.",
        name: "Rowan Achebe",
        role: "Director of Operations, Brightline Logistics",
        note: "the proof we carry into every first call"
      }
    ],
    [
      "threeCards",
      {
        eyebrow: "What kills us",
        title: "The failure modes we will watch",
        cards: [
          [
            "alert-triangle",
            "The first week is hard",
            "If dispatch leads need a call to get started, renewals fail in twelve months. Watch: setup completion without support."
          ],
          [
            "coin",
            "We price like the incumbent",
            "Fleet buyers expect per-vehicle pricing. Per-seat confuses them. Watch: quote-to-close time."
          ],
          [
            "clock",
            "Partners sell our roadmap",
            "Partners promise features that are not built. Watch: escalations mentioning a promise we did not make."
          ]
        ],
        note: "three numbers, checked every Friday"
      }
    ],
    [
      "closing",
      {
        title: "Questions",
        subtitle: "The full plan, the persona research and the channel model are in the go-to-market folder.",
        rows: [
          [
            "mail",
            "marcus@northwind.example"
          ],
          [
            "world",
            "northwind.example/gtm"
          ],
          [
            "calendar",
            "Channel review: week 13"
          ]
        ],
        cta: "Open the plan",
        note: "bring the objections, we want them early"
      }
    ]
  ]
};
