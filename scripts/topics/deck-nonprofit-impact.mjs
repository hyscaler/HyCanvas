// Nonprofit Impact Report: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: the annual report a donor keeps on the shelf. Earth red and sky
// blue on unbleached paper, an oxblood deep ground with the sky as its
// accent, a humanist serif over a humanist sans, and a fine-pen hand for
// the kicker and the notes. The ornament is the inset rule, the border of a
// printed page. The signature slide is the dollar: one bill drawn as a wide
// bar, split into programmes, operations and fundraising with the cents on
// each, a portrait in the bill where a banknote keeps one, and the sentence
// that explains it.

import { text, rect, ellipse, photo, art, note, chrome, type, mixHex, inkOn, M, CW } from "../lib/deck-kit.mjs";

/** The three parts of the dollar: the cents, the name, the amount and what
 *  it bought. The cents sum to one hundred. */
const DOLLAR = [
  { cents: 84, name: "Programmes", amount: "$3.97M", line: "Food, rental support and four after-school sites." },
  { cents: 9, name: "Operations", amount: "$430K", line: "Rent, finance, the audit and the systems that keep the records." },
  { cents: 7, name: "Fundraising", amount: "$330K", line: "Two events, the spring appeal and this report." },
];

const signature = {
  /** The dollar: a bill the width of the page, with a double frame, a
   *  numeral in two corners and small print along its edges; inside it the
   *  bar, split by the cents, the wide part carrying the big figure and a
   *  portrait; under it the sentence and a legend with the amounts. */
  dollar(K, i, c) {
    const g = K.paper;
    const t = type(K, g);
    const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow ?? "Where the money went", c.title ?? "What one dollar did");
    const fill = [];
    const illustrations = [];
    const parts = c.parts ?? DOLLAR;
    const frame = g.accentInk ?? g.accent;
    // The segments take the darker accent inks so the cream figures read on
    // them; the third part takes a warm grey mixed from the panel and the ink.
    const tones = [g.accentInk ?? g.accent, g.accent2Ink ?? g.accent2, mixHex(g.panel, g.ink, 0.62)];

    // The bill.
    const bx = M, by = bodyTop + 20, bw = CW, bh = 340;
    nodes.push(rect(bx, by, bw, bh, g.panel, { radius: 10, stroke: frame, strokeWidth: 2 }));
    nodes.push(rect(bx + 12, by + 12, bw - 24, bh - 24, undefined, { radius: 6, stroke: frame, strokeWidth: 1, opacity: 0.5 }));
    nodes.push(text(bx + 32, by + 20, 80, 44, "1", t.display(36, { color: frame })));
    nodes.push(text(bx + bw - 112, by + bh - 64, 80, 44, "1", t.display(36, { color: frame, align: "right" })));
    nodes.push(text(bx + 140, by + 30, bw - 280, 22, `One dollar  ·  ${K.company}  ·  year to 30 June 2026`, t.eyebrow({ size: 14, letterSpacing: 5, align: "center" })));
    nodes.push(text(bx + 140, by + bh - 52, bw - 280, 22, "Every cent, in the order it was spent", t.eyebrow({ size: 14, letterSpacing: 5, align: "center" })));

    // The bar: one segment per part, its width the part's cents.
    const gap = 6;
    const sx = bx + 48, sy = by + 68, sw = bw - 96, sh = bh - 136;
    const total = parts.reduce((n, p) => n + p.cents, 0);
    let x = sx;
    parts.forEach((p, k) => {
      const w = k === parts.length - 1 ? sx + sw - x : Math.round((sw - gap * (parts.length - 1)) * p.cents / total);
      const tone = tones[k % tones.length];
      const onTone = inkOn(K, tone);
      nodes.push(rect(x, sy, w, sh, tone, { radius: 4 }));
      if (k === 0) {
        // The wide part: the big figure, its line, and the portrait a bill
        // keeps in the middle.
        nodes.push(text(x + 44, sy + Math.round((sh - 120) / 2), 320, 120, `${p.cents}¢`, t.numeral(112, { color: onTone })));
        fill.push({ node: nodes.length - 1, label: "Programme cents", hint: "Cents of each dollar that reached a programme" });
        nodes.push(text(x + 380, sy + Math.round((sh - 76) / 2), 520, 76, "of every dollar\nreached a programme", { family: K.body, size: 26, weight: 600, color: onTone, lineHeight: 1.35 }));
        const ox = x + w - 226, oy = sy + Math.round((sh - 150) / 2);
        nodes.push(photo(ox, oy, 150, 150, g.bg, { shape: "ellipse" }));
        nodes.push(ellipse(ox + 8, oy + 8, 134, 134, undefined, { stroke: frame, strokeWidth: 1.5, opacity: 0.6 }));
        illustrations.push(art(K.peeps[3 % K.peeps.length], ox + 22, oy + 14, 108, 120));
      } else {
        nodes.push(text(x, sy + Math.round((sh - 66) / 2), w, 66, `${p.cents}¢`, t.numeral(58, { color: onTone, align: "center" })));
        fill.push({ node: nodes.length - 1, label: `${p.name} cents`, hint: "Cents of each dollar" });
      }
      x += w + gap;
    });

    // The sentence that explains it.
    const sentenceY = by + bh + 32;
    nodes.push(text(M, sentenceY, CW, 84, c.sentence, t.display(32, { lineHeight: 1.25 })));
    fill.push({ node: nodes.length - 1, label: "The sentence", hint: "What the split means, in plain words" });

    // The legend: a chip in each tone, the name with the cents and the
    // amount, and what it bought.
    const ly = sentenceY + 116;
    const widths = [760, 484, 484];
    let lx = M;
    parts.forEach((p, k) => {
      const cw = widths[k] ?? 484;
      nodes.push(rect(lx, ly + 7, 16, 16, tones[k % tones.length], { radius: 3 }));
      nodes.push(text(lx + 30, ly, cw - 40, 30, `${p.name}  ·  ${p.cents}¢  ·  ${p.amount}`, t.strong(22)));
      fill.push({ node: nodes.length - 1, label: p.name, hint: "The part, its cents and its amount" });
      nodes.push(text(lx + 30, ly + 36, cw - 50, 56, p.line, t.body(19)));
      lx += cw;
    });

    nodes.push(...note(K, g, c.note));
    return { page: { name: "The dollar", bg: g.bg, nodes, illustrations }, fill };
  },
};

export default {
  id: "deck-nonprofit-impact",
  title: "Nonprofit Impact Report",
  base: "terra",
  rank: 74,
  tags: [
    "nonprofit",
    "impact",
    "report",
    "donors"
  ],
  meta: {
    company: "Fernwood Collective",
    deck: "Impact report 2026",
    kicker: "Our year together",
    farewell: "Thank you, and one ask",
    art: {
      cover: "il-day31-sweet-home",
      section: "il-day36-abacus",
      picture: "il-day59-kitchen",
      closing: "la-small-character-illustrations"
    }
  },
  look: {
    display: "Alegreya", dw: 700,
    body: "Fira Sans", bw: 400,
    mono: null,
    accentFace: "Neucha", accentWeight: 400, accentSize: 40,
    charWidth: 0.52,
    paper: { bg: "#F2EADB", ink: "#2A211B", muted: "#655648", line: "#D8CBB4", panel: "#E9DFCB", panel2: "#DED2B9", accent: "#B8432A", accentInk: "#8E2F19", accent2: "#3F86BE", accent2Ink: "#245B86" },
    deep: { bg: "#7A3226", bg2: "#471912", ink: "#F6EEDF", muted: "#E3C9BC", line: "#95503F", panel: "#843B2E", panel2: "#8E4638", accent: "#9FCCEC", accent2: "#D9E9F5" },
    radius: 6,
    ornament: "rules",
    peeps: ["op-peep-100", "op-peep-43", "op-peep-102", "op-peep-20", "op-peep-78"],
    scale: { cover: 116, title: 62, section: 236, statement: 80, numeral: 104, quote: 54 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "Why this\nwork matters",
        subtitle: "The people we reached this year, one story the numbers cannot hold, where every donated dollar went, and the gap we close next.",
        presenter: "Fernwood Collective  ·  Annual report 2026",
        art: "il-day31-sweet-home",
        note: "ten minutes, cover to cover"
      }
    ],
    [
      "figures",
      {
        eyebrow: "The year's impact",
        title: "People reached, outcomes achieved",
        stats: [
          [
            "12,400",
            "People served",
            "+22%",
            "Across food, housing support and the after-school programme."
          ],
          [
            "2,150",
            "Families housed",
            "+18%",
            "Through the rental support fund, all still housed at year end."
          ],
          [
            "840",
            "Young people in the programme",
            "Every weekday",
            "Four sites, two of them new this year."
          ],
          [
            "96%",
            "Programme completion",
            "+3 pts",
            "Of young people who joined in September and stayed to June."
          ]
        ],
        note: "every figure is in the accounts, page 12 on"
      }
    ],
    [
      "quote",
      {
        text: "They did not give us a leaflet. They gave us a week to breathe, and then a plan we could actually follow.",
        name: "Amara, a parent in the housing programme",
        role: "Housed since March 2026, still housed",
        note: "Amara asked us to use her first name only"
      }
    ],
    [
      "textPicture",
      {
        eyebrow: "The housing programme",
        title: "What a plan looks like",
        points: [
          [
            "A week of rent, paid the same day",
            "The first call ends with the arrears covered, so nobody decides anything while afraid."
          ],
          [
            "One caseworker, one phone number",
            "The same person every time, for as long as it takes. Forty families each, not sixty."
          ],
          [
            "A budget written at the kitchen table",
            "Together, on paper, with the landlord's number on it. Most families are off the fund in five months."
          ]
        ],
        art: "il-day59-kitchen",
        note: "five months on the fund, then off it"
      }
    ],
    [
      "section",
      {
        n: "",
        title: "Where the money went",
        blurb: "Every dollar, in the order it was spent: what reached a programme, what kept the doors open, and what raised the next one.",
        kicker: "Every dollar, accounted for",
        art: "il-day36-abacus",
        note: "the auditors signed on 14 August"
      }
    ],
    [
      "raw",
      {
        build: signature.dollar,
        eyebrow: "Where the money went",
        title: "What one dollar did",
        sentence: "Eighty-four cents of every dollar reached a programme. Nine cents ran the organisation, the rent and the finance and the audit. Seven cents raised the next dollar.",
        note: "the audit is on our site, the full ledger on request"
      }
    ],
    [
      "chart",
      {
        eyebrow: "Where the money went",
        title: "What each programme cost",
        takeaway: "Housing is the largest line and the one that grew most this year; every figure here matches the accounts.",
        chartType: "bar",
        categories: [
          "Food",
          "Housing",
          "Youth sites",
          "Operations",
          "Fundraising"
        ],
        series: [
          {
            name: "Spent ($K)",
            values: [
              1220,
              1810,
              940,
              430,
              330
            ]
          }
        ],
        calls: [
          [
            "$1.81M",
            "Rental support, the largest line and up 24%"
          ],
          [
            "$381",
            "Spent per person served, across every programme"
          ],
          [
            "$4.73M",
            "Spent in total, against $4.9M raised"
          ]
        ],
        note: "the $170K left over is January's float, not a surplus"
      }
    ],
    [
      "threeCards",
      {
        eyebrow: "What is next",
        title: "The gap we close next year",
        cards: [
          [
            "home",
            "A fifth youth site",
            "Two hundred more young people on the east side, where the waiting list is longest."
          ],
          [
            "heart",
            "Housing support for 400 more families",
            "The fund runs out in October every year. Next year it runs to December."
          ],
          [
            "user",
            "A second caseworker per site",
            "Caseloads of sixty are too many. Forty is the number every study points to."
          ]
        ],
        note: "the fifth site has a building; what it needs is a lease"
      }
    ],
    [
      "closing",
      {
        title: "Join us",
        subtitle: "A monthly gift, a volunteer shift, or an introduction to someone who should know about this work. Every one of them counts.",
        rows: [
          [
            "world",
            "fernwood.example/give"
          ],
          [
            "mail",
            "hello@fernwood.example"
          ],
          [
            "phone",
            "+1 415 555 0198"
          ]
        ],
        cta: "Give monthly",
        art: "la-small-character-illustrations",
        note: "thirty dollars a month is a week of rent"
      }
    ]
  ]
};
