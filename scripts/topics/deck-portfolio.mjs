// Personal Portfolio: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: a designer's own book. Warm off-white paper, near-black ink and
// one personal accent, a terracotta, with a calmer sibling for accent text.
// A characterful wide grotesk for titles, a plain grotesk for reading, a
// wide mono for the eyebrows, captions and labels the way a printed
// portfolio numbers its figures, and a quick pen for the hand notes. The
// ornament is her monogram: one enormous "A" in a tint of the ground,
// bottom right, and a rule across the top.

import { text, rect, button, photo, art, halo, note, type, chrome, mixHex, inkOn, fitSize, M } from "../lib/deck-kit.mjs";

// --- the signature slide -------------------------------------------------------

/** The case study spread: a large picture slot at left with an index tab
 *  and a figure caption, and at right the problem, the role and the outcome
 *  as three labelled paragraphs, then the one result figure large with the
 *  "before" value struck through beside it. The hand note sits under the
 *  picture, where a designer writes in the margin of her own book. */
const signature = {
  spread(K, i, c) {
    const g = K.paper;
    const t = type(K, g);
    const accentInk = g.accentInk ?? g.accent;
    const mono = K.mono ?? K.body;
    const cw = K.charWidth ?? 0.56;
    const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
    const fill = [];
    fill.push({ node: nodes.findIndex((n) => n.kind === "text" && n.text === c.title), label: "Title", hint: "The product and the company" });

    // Left: the picture slot (drop the real screens on it), the index tab
    // in the corner, the drawing in a halo, and the figure caption below.
    const px = M, py = bodyTop, pw = 880, ph = 560;
    nodes.push(photo(px, py, pw, ph, { angle: 160, stops: [[mixHex(g.panel, g.accent, 0.16), 0], [g.panel, 1]] }, { radius: K.radius * 1.5 }));
    nodes.push(...halo(px + pw / 2, py + ph / 2, 440, g.accent));
    // The chip takes the calmer accent so its small label clears 4.5:1.
    nodes.push(button(px + 20, py + 20, 116, 36, c.index, { fill: accentInk, color: inkOn(K, accentInk), family: mono, size: 14, weight: 600 }));
    fill.push({ node: `${nodes.length - 1}-label`, label: "Index", hint: "Which case study of how many" });
    nodes.push(text(px, py + ph + 22, pw, 26, c.caption, t.meta({ size: 16 })));
    fill.push({ node: nodes.length - 1, label: "Caption", hint: "What the picture shows" });
    const illustrations = [art(c.art ?? K.art.picture, px + 190, py + 60, 500, 440)];

    // Right: three labelled paragraphs, a hairline, then the result.
    const rx = px + pw + 64, rw = 1824 - (px + pw + 64);
    c.blocks.forEach(([label, para], k) => {
      const y = bodyTop + k * 140;
      nodes.push(text(rx, y, rw, 26, label, t.eyebrow({ size: 17, letterSpacing: 3 })));
      nodes.push(text(rx, y + 34, rw, 92, para, t.body(21)));
      fill.push({ node: nodes.length - 1, label, hint: "Two or three lines" });
    });
    const ry = bodyTop + 3 * 140 - 6;
    nodes.push(rect(rx, ry, rw, 1, g.line));
    nodes.push(text(rx, ry + 18, rw, 24, c.result.eyebrow, t.eyebrow({ size: 15, letterSpacing: 3 })));
    const fy = ry + 52;
    const fw = 380;
    const fsize = fitSize(c.result.figure, K.scale.numeral, fw, 0.6, cw);
    nodes.push(text(rx, fy, fw, K.scale.numeral + 12, c.result.figure, t.numeral(fsize)));
    fill.push({ node: nodes.length - 1, label: "Result", hint: "The one figure" });
    const sx = rx + fw + 20, sw = rw - fw - 20;
    // The "before" value, struck through, with a small tag beside it so it
    // reads even where a renderer skips the decoration.
    nodes.push(text(sx, fy + 6, 120, 44, c.result.before, t.display(34, { color: g.muted, strike: true })));
    nodes.push(text(sx + 96, fy + 16, 120, 22, "before", t.meta({ size: 14 })));
    nodes.push(text(sx, fy + 56, sw, 30, c.result.label, t.strong(22)));
    nodes.push(text(sx, fy + 92, sw, 56, c.result.sub, t.body(19)));

    nodes.push(...note(K, g, c.note, false, { x: px, y: py + ph + 62, w: pw, align: "left" }));
    return { page: { name: "Case study", bg: g.bg, nodes, illustrations }, fill };
  },
};

export default {
  id: "deck-portfolio",
  title: "Personal Portfolio",
  base: "slate",
  rank: 76,
  tags: [
    "portfolio",
    "personal",
    "showcase",
    "work"
  ],
  meta: {
    company: "Aisha Bello",
    deck: "Product design portfolio",
    kicker: "Aisha Bello, product designer",
    farewell: "thanks for looking",
    art: {
      cover: "il-day13-it-girl",
      section: "il-day4-polariod",
      picture: "il-day78-wallet",
      closing: "la-coffee"
    }
  },
  look: {
    display: "Syne", dw: 700,
    body: "Host Grotesk", bw: 400,
    mono: "Martian Mono",
    accentFace: "Reenie Beanie", accentWeight: 400, accentSize: 44,
    charWidth: 0.6,
    paper: { bg: "#F4F1EA", ink: "#151412", muted: "#5B564E", line: "#D9D3C7", panel: "#ECE8DF", panel2: "#E2DDD1", accent: "#C4522B", accent2: "#151412", accentInk: "#A8421F", accent2Ink: "#151412" },
    deep: { bg: "#1C1B18", bg2: "#0C0C0A", ink: "#F4F1EA", muted: "#B4AFA4", line: "#35332E", panel: "#26251F", panel2: "#312F29", accent: "#E5734A", accent2: "#F4F1EA", accentInk: "#EE8A63", accent2Ink: "#F4F1EA" },
    radius: 6,
    ornament: "watermark",
    watermark: "A",
    peeps: ["op-peep-15", "op-peep-31", "op-peep-44", "op-peep-68", "op-peep-94"],
    scale: { cover: 116, title: 60, section: 236, statement: 80, numeral: 104, quote: 54 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "Hi, I am Aisha.\nI design the\nfirst week.",
        subtitle: "Product designer, eight years, three companies. I work where a stranger decides whether to stay.",
        presenter: "Selected work, 2023 to 2026",
        note: "ask me for the long version"
      }
    ],
    [
      "statement",
      {
        text: "The first week decides whether a product becomes someone's. That is the week I design.",
        source: "Aisha Bello, on why every case study here starts at signup",
        note: "written on a sticky note above my desk"
      }
    ],
    [
      "section",
      {
        n: "",
        title: "Selected work",
        blurb: "Three products, three years, one question each. The newest first, the shortest last.",
        kicker: "three case studies, 2023 to 2026",
        art: "il-day4-polariod",
        note: "each fits on one page, on purpose"
      }
    ],
    [
      "raw",
      {
        build: signature.spread,
        eyebrow: "Selected work one  ·  2025",
        title: "Onboarding at Form & Function",
        index: "01 / 03",
        caption: "Fig. 01  ·  the preview-first flow, the version fourteen people tested",
        art: "il-day94-ui-ux",
        blocks: [
          [
            "The problem",
            "Half of new accounts needed a support call before their first report. Eleven days to first value, most of it spent connecting sources nobody had asked for yet."
          ],
          [
            "My role",
            "Research lead and sole designer. Fourteen sessions, one prototype, one very opinionated flow."
          ],
          [
            "The outcome",
            "Preview-first onboarding: the first report drawn from their own data before any setup. Completion nearly doubled in testing, and first value came in three days after launch."
          ]
        ],
        result: {
          eyebrow: "The result",
          figure: "78%",
          before: "41%",
          label: "Completion in testing",
          sub: "Three days to first value after launch, from eleven."
        },
        note: "fourteen sessions on a borrowed laptop"
      }
    ],
    [
      "textPicture",
      {
        eyebrow: "Selected work two  ·  2024",
        title: "Billing at Cobalt Health",
        points: [
          [
            "The constraint",
            "An invoice that finance, the customer and a regulator all had to read, in one layout, with no second version."
          ],
          [
            "What shaped the solution",
            "I designed for the regulator first. If the strictest reader could follow it, the others could."
          ],
          [
            "The outcome",
            "Disputes fell by two thirds. Finance stopped sending the explanatory email."
          ]
        ],
        art: "il-day78-wallet",
        note: "designed for the strictest reader first"
      }
    ],
    [
      "figures",
      {
        eyebrow: "Selected work three  ·  2023",
        title: "The mobile app at Beacon, in numbers",
        stats: [
          [
            "4.8",
            "App store rating",
            "Was 3.6",
            "Twelve months after the redesign shipped."
          ],
          [
            "62%",
            "Weekly active",
            "Was 38%",
            "Drivers who open the app every week."
          ],
          [
            "−54%",
            "Support contacts",
            "Per active user",
            "The map and the shift screen did most of it."
          ],
          [
            "3",
            "People",
            "One designer",
            "A small team, a long list, and a lot of saying no."
          ]
        ],
        note: "three of us, and a very long list of no"
      }
    ],
    [
      "quote",
      {
        text: "She asks the question the room was avoiding, then draws the answer so nobody has to argue about it.",
        name: "Tomas Reyes",
        role: "Engineering lead, Form & Function",
        note: "he led the build on case study one"
      }
    ],
    [
      "process",
      {
        eyebrow: "How I work",
        title: "Watch, argue, build, measure.",
        steps: [
          [
            "Watch first",
            "Sessions with real users on their own data before a single screen is drawn."
          ],
          [
            "One flow, argued",
            "A prototype with an opinion, tested against the alternative I rejected."
          ],
          [
            "Build alongside",
            "I sit with the engineers through the build. The design is done when it ships, not when it is handed over."
          ],
          [
            "Measure",
            "One number, agreed before launch, checked at thirty days."
          ]
        ],
        note: "step three is where the work actually is"
      }
    ],
    [
      "closing",
      {
        title: "Let's talk.",
        subtitle: "I am looking for a team that cares about the first week as much as the tenth feature. Case studies in full at the link.",
        rows: [
          [
            "mail",
            "aisha@bello.example"
          ],
          [
            "world",
            "bello.example/work"
          ],
          [
            "message",
            "@aishadesigns"
          ]
        ],
        cta: "See the case studies",
        note: "coffee is on me, remote or not"
      }
    ]
  ]
};
