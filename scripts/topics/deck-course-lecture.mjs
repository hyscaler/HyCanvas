// Course Lecture: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: a lecture hall. Chalk white on a slate green board, the reading
// pages one shade lighter than the deep ones, and a sunny yellow for the
// rules, the numerals and the kicker, the one stick of coloured chalk on the
// ledge; a pale sky chalk for every second card. A clear humanist sans for
// titles, a face drawn for legibility for the reading, and a schoolroom
// hand for the kicker and the notes, the way the lecturer writes in the
// margin of the board. Rules as the ornament: the inset frame in yellow is
// the chalk line around a blackboard, the sparkle is chalk dust. The
// signature is the definition card: the term set huge as a headword in the
// margin, its part of speech and origin under it in the hand, the
// one-sentence definition beside it, and a worked example in a box ruled in
// yellow beneath, the way a textbook sets Definition 4.1.

import { text, rect, button, chrome, note, type, M, CW } from "../lib/deck-kit.mjs";

// --- the definition card ---------------------------------------------------------

const HEAD_W = 600, GUTTER = 56, PAD = 56;

const signature = {
  /** The definition card: a numbered tag top left, the term as a huge
   *  headword with a chalk underline, its part of speech in the hand and its
   *  origin under it, a hairline, then the one-sentence definition and a
   *  worked example in a yellow-ruled box with three named rows. */
  definition(K, i, c) {
    const g = K.paper;
    const t = type(K, g);
    const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
    const fill = [];
    const x = M, y = bodyTop, w = CW, h = 640;
    nodes.push(rect(x, y, w, h, g.panel, { radius: K.radius, stroke: g.line, strokeWidth: 1.5 }));
    // The tag: "Definition 4.1", the way a textbook numbers its definitions.
    nodes.push(button(x + PAD - 8, y + 40, 210, 36, c.tag, { fill: g.accent, color: K.deep.bg2, family: K.body, size: 15, weight: 700, upper: true, letterSpacing: 1, radius: K.radius }));
    fill.push({ node: `${nodes.length - 1}-label`, label: "Tag", hint: "Definition number" });
    // The headword, with a chalk underline a degree off square.
    const hx = x + PAD;
    nodes.push(text(hx, y + 96, HEAD_W - PAD, 170, c.term, t.display(150, { lineHeight: 1 })));
    fill.push({ node: nodes.length - 1, label: "Term", hint: "One word, the thing being defined" });
    const under = Math.min(HEAD_W - PAD, Math.round(c.term.length * 150 * (K.charWidth ?? 0.56)));
    nodes.push(rect(hx + 4, y + 266, under, 6, g.accent, { rotation: -1, radius: 3, opacity: 0.9 }));
    nodes.push(text(hx, y + 296, HEAD_W - PAD, 48, c.speech, t.kicker({ size: 34, color: g.muted })));
    nodes.push(text(hx, y + 352, HEAD_W - PAD - 40, 64, c.origin, t.body(20)));
    fill.push({ node: nodes.length - 1, label: "Origin", hint: "Where the word comes from" });
    // See also: the two neighbours the term is mistaken for, the way a
    // textbook points the reader sideways at the foot of a definition.
    nodes.push(text(hx, y + 452, HEAD_W - PAD, 24, c.seeAlsoLabel, t.eyebrow({ size: 16 })));
    c.seeAlso.forEach(([term, gloss], k) => {
      const sy = y + 486 + k * 72;
      nodes.push(text(hx, sy, HEAD_W - PAD - 40, 30, term, t.strong(22)));
      nodes.push(text(hx, sy + 30, HEAD_W - PAD - 40, 30, gloss, t.body(19)));
    });
    // The column rule between the headword and the definition.
    nodes.push(rect(x + PAD + HEAD_W, y + 48, 1, h - 96, g.line));
    // The definition: a short yellow rule, then the one sentence.
    const dx = x + PAD + HEAD_W + GUTTER, dw = x + w - PAD - dx;
    nodes.push(rect(dx, y + 52, 72, 4, g.accent));
    nodes.push(text(dx, y + 74, dw, 100, c.definition, t.strong(34, { lineHeight: 1.35 })));
    fill.push({ node: nodes.length - 1, label: "Definition", hint: "One sentence, no jargon" });
    // The worked example: a box ruled in yellow, its label sitting on the
    // border the way a fieldset legend does, three rows of name, value and
    // who uses it under a row of small headers.
    const bx = dx, by = y + 212, bw = dw, bh = h - 212 - 48;
    nodes.push(rect(bx, by, bw, bh, undefined, { stroke: g.accent, strokeWidth: 2, radius: K.radius }));
    nodes.push(rect(bx + 24, by - 12, 236, 24, g.panel));
    nodes.push(text(bx + 32, by - 13, 230, 26, c.exampleLabel, t.eyebrow({ size: 16 })));
    const cols = [0, 360, 560];
    c.exampleHeads.forEach((hd, k) => nodes.push(text(bx + 32 + cols[k], by + 34, 300, 24, hd, t.meta({ size: 15, upper: true, letterSpacing: 3 }))));
    nodes.push(rect(bx + 32, by + 66, bw - 64, 1, g.line));
    c.example.forEach(([name, value, who], k) => {
      const ry = by + 84 + k * 96;
      nodes.push(text(bx + 32 + cols[0], ry + 6, 340, 34, name, t.strong(24)));
      fill.push({ node: nodes.length - 1, label: `Token ${k + 1}`, hint: "The token's name" });
      nodes.push(text(bx + 32 + cols[1], ry + 4, 190, 36, value, t.numeral(26)));
      nodes.push(text(bx + 32 + cols[2], ry + 8, bw - 64 - cols[2], 60, who, t.body(20)));
      if (k < c.example.length - 1) nodes.push(rect(bx + 32, ry + 82, bw - 64, 1, g.line));
    });
    nodes.push(...note(K, g, c.note));
    return { page: { name: "Definition", bg: g.bg, nodes }, fill };
  },
};

export default {
  id: "deck-course-lecture",
  title: "Course Lecture",
  base: "folio",
  rank: 44,
  tags: [
    "education",
    "lecture",
    "course",
    "teaching"
  ],
  meta: {
    company: "Meridian Institute",
    deck: "Design systems, lecture 4",
    kicker: "Lecture four",
    farewell: "Until next Thursday",
    art: {
      cover: "il-day11-blackboard",
      section: "il-day36-abacus",
      picture: "il-day15-color-tool",
      closing: "il-day63-school-bag"
    }
  },
  look: {
    display: "Fira Sans", dw: 700,
    body: "Atkinson Hyperlegible", bw: 400,
    mono: null,
    accentFace: "Schoolbell", accentWeight: 400, accentSize: 40,
    strongWeight: 700,
    charWidth: 0.54,
    paper: { bg: "#37554D", ink: "#F4F1E8", muted: "#CDD6D0", line: "#516D65", panel: "#3F5F57", panel2: "#4A6B63", accent: "#FFD24A", accent2: "#AED6F1" },
    deep: { bg: "#2E4A42", bg2: "#1B2F2A", ink: "#F4F1E8", muted: "#C0CCC6", line: "#46605A", panel: "#3A574F", panel2: "#456760", accent: "#FFD24A", accent2: "#AED6F1" },
    radius: 6,
    ornament: "rules",
    peeps: ["op-peep-1", "op-peep-15", "op-peep-57", "op-peep-67", "op-peep-69"],
    scale: { cover: 112, title: 60, section: 236, statement: 76, numeral: 100, quote: 50 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "Tokens: the smallest\nunit of a design system",
        subtitle: "By the end you will be able to name a token, decide what deserves one, and read a system's tokens to predict how it will age.",
        presenterName: "Dr. Priya Raman",
        when: "Thursday, 10:00, Room 204",
        note: "slides go up Friday. listen first, write second"
      }
    ],
    [
      "agenda",
      {
        eyebrow: "Where we left off",
        title: "The three ideas from last time",
        items: [
          [
            "Components are promises",
            "A component is a contract about behaviour, not a picture",
            "Recap"
          ],
          [
            "Variants multiply",
            "Every variant doubles the surface you must test",
            "Recap"
          ],
          [
            "Systems age",
            "The parts nobody owns are the parts that rot",
            "Recap"
          ],
          [
            "Today: tokens",
            "The unit underneath components",
            "New"
          ],
          [
            "Next: theming",
            "How tokens make a second brand cheap",
            "Preview"
          ]
        ],
        card: {
          eyebrow: "Today",
          big: "Wk 4",
          meta: [
            [
              "Reading",
              "Chapter 5, pages 88 to 112"
            ],
            [
              "Exercise",
              "Due Tuesday, in the portal"
            ],
            [
              "Office hours",
              "Wednesday, 14:00"
            ],
            [
              "Recording",
              "Posted by Friday"
            ]
          ]
        },
        note: "the recap is five minutes. hold your questions"
      }
    ],
    [
      "raw",
      {
        build: signature.definition,
        eyebrow: "The core concept",
        title: "What we mean by a token",
        tag: "Definition 4.1",
        term: "token",
        speech: "noun",
        origin: "Old English tacen: a sign, a mark that stands in for the thing itself.",
        seeAlsoLabel: "See also",
        seeAlso: [
          ["Variable", "A name with no decision behind it."],
          ["Style", "A bundle of tokens with one use."]
        ],
        definition: "A name for a value the system has decided on. Components use the name, never the value.",
        exampleLabel: "Worked example",
        exampleHeads: ["Name", "Value", "Used by"],
        example: [
          ["colour.accent", "#FFD24A", "The button, the link, the focus ring"],
          ["space.unit", "8 px", "Every gap on every screen is a multiple of it"],
          ["type.body", "18 / 1.5", "Paragraphs, labels, this slide"]
        ],
        note: "say it back in your own words first"
      }
    ],
    [
      "textPicture",
      {
        eyebrow: "Holding the idea",
        title: "A token is a named decision",
        points: [
          [
            "The intuition",
            "When the value changes, every use changes with it. When the name is missing, every use is a separate decision waiting to drift."
          ],
          [
            "The test",
            "If two designers would pick a different value, it deserves a token. If everyone would pick the same one, it does not."
          ],
          [
            "The boundary",
            "A token is not a component and not a style. It is the one number or colour underneath both, named for why."
          ]
        ],
        art: "il-day15-color-tool",
        note: "the test is the part everyone forgets"
      }
    ],
    [
      "section",
      {
        n: "",
        title: "Twelve values,\none accent",
        blurb: "A product with a light and a dark theme. The accent must read on both, and every value gets a name.",
        kicker: "Now, on the board",
        art: "il-day36-abacus",
        note: "count the values with me. there are twelve"
      }
    ],
    [
      "process",
      {
        eyebrow: "Worked example",
        title: "One real case, stepped through",
        steps: [
          [
            "The brief",
            "A product with a light and a dark theme, and one accent that must read on both."
          ],
          [
            "Name the decisions",
            "Ground, surface, ink, muted ink, accent, line. Six names, twelve values."
          ],
          [
            "Bind the components",
            "The button uses accent and ink-on-accent. It never mentions a hex."
          ],
          [
            "Flip the theme",
            "Twelve values change, zero components change. That is the whole point."
          ]
        ],
        note: "step four is the whole lecture"
      }
    ],
    [
      "threeCards",
      {
        eyebrow: "Common mistakes",
        title: "Where students usually stumble",
        cards: [
          [
            "tag",
            "Naming the value, not the decision",
            "'blue-500' is a value with a name. 'accent' is a decision. The first breaks the moment the brand turns green."
          ],
          [
            "alert-triangle",
            "Tokens for everything",
            "Forty spacing tokens is a ruler, not a system. Six is a decision."
          ],
          [
            "palette",
            "Skipping the on-colours",
            "Every ground needs an ink that reads on it. The dark theme is where this is discovered, expensively."
          ]
        ],
        note: "I have made all three of these. Twice."
      }
    ],
    [
      "statement",
      {
        text: "Name the decision, not the value. Everything else in a design system follows from that.",
        source: "Lecture four, the one line to write down",
        note: "if you write one thing down, this is it"
      }
    ],
    [
      "closing",
      {
        title: "Before next session",
        subtitle: "Take any product you use daily and write its six tokens from observation alone. Bring the one you could not name.",
        rows: [
          [
            "world",
            "institute.example/design-systems"
          ],
          [
            "mail",
            "praman@institute.example"
          ],
          [
            "calendar",
            "Office hours: Wednesday, 14:00"
          ]
        ],
        cta: "Open the exercise",
        note: "one product, six names, no peeking at the code"
      }
    ]
  ]
};
