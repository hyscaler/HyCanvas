// Workshop Facilitation: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: a warm white paper with a marker yellow for rules, rings and
// icons, a dark mustard for any text in the accent, and black for every
// second card; a near-black deep ground where the same yellow reads as it
// is. Stripes as the ornament: three diagonal bands in tints of the yellow,
// the caution tape of a room where the timer is real. A heavy poster
// grotesk for titles and numerals, a plain rounded sans for reading, and a
// felt-tip hand for the kicker and the notes, the pen the sticky notes are
// written with. The signature is the time box: one exercise as a kitchen
// timer, a giant numeral of minutes in a thick yellow ring with a dial of
// sixty ticks, the instruction as three sticky notes pinned beside it, and
// the what-good-looks-like line on a black bar below.

import { text, rect, ellipse, chrome, note, halo, type, deepGround, M } from "../lib/deck-kit.mjs";

// --- the time box --------------------------------------------------------------

const RING = 236, STICKY_W = 336, STICKY_H = 300, STICKY_GAP = 48, STICKY = "#FFE14D";

const signature = {
  /** The time box: a thick yellow ring with the minutes as one huge numeral
   *  and a dial of sixty ticks around it, three sticky notes with the
   *  instruction pinned in a row beside it, each numbered, slightly askew,
   *  and the what-good-looks-like line on the deep ground below them. */
  timer(K, i, c) {
    const g = K.paper;
    const d = K.deep;
    const t = type(K, g);
    const td = type(K, d);
    const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
    const fill = [];
    // The ring: a soft glow behind it, sixty ticks on the dial (every fifth
    // one heavier), the ring itself as a stroked disc, the numeral inside.
    const cx = M + RING + 40, cy = bodyTop + 30 + RING + 39;
    nodes.push(...halo(cx, cy, 720, g.accent));
    for (let k = 0; k < 60; k++) {
      const a = (k / 60) * Math.PI * 2;
      const big = k % 5 === 0;
      const r = RING + 34, s = big ? 10 : 5;
      nodes.push(ellipse(Math.round(cx + Math.cos(a) * r - s / 2), Math.round(cy + Math.sin(a) * r - s / 2), s, s, g.ink, { opacity: big ? 0.85 : 0.3 }));
    }
    nodes.push(ellipse(cx - RING, cy - RING, RING * 2, RING * 2, g.bg, { stroke: g.accent, strokeWidth: 28 }));
    nodes.push(text(cx - 200, cy - 124, 400, 190, c.minutes, t.display(176, { align: "center", lineHeight: 1 })));
    fill.push({ node: nodes.length - 1, label: "Minutes", hint: "The time box, as a number" });
    nodes.push(text(cx - 170, cy + 80, 340, 28, c.unit, t.eyebrow({ align: "center" })));
    // Three sticky notes, numbered, each a few degrees off square: the
    // shadow, the note, the number disc and the instruction in the hand.
    const x0 = cx + RING + 34 + 66;
    const y0 = bodyTop + 24;
    const tilt = [-2, 1.5, -1.2];
    c.steps.forEach((str, k) => {
      const x = x0 + k * (STICKY_W + STICKY_GAP);
      const rot = tilt[k % tilt.length];
      nodes.push(rect(x + 6, y0 + 10, STICKY_W, STICKY_H, g.ink, { opacity: 0.1, rotation: rot }));
      nodes.push(rect(x, y0, STICKY_W, STICKY_H, STICKY, { rotation: rot }));
      nodes.push(ellipse(x + 24, y0 + 24, 44, 44, g.ink, { rotation: rot }));
      nodes.push(text(x + 24, y0 + 24, 44, 44, String(k + 1), { family: K.display, size: 20, weight: K.dw, color: g.accent, align: "center", vAlign: "middle", lineHeight: 1, rotation: rot }));
      nodes.push(text(x + 26, y0 + 84, STICKY_W - 62, 200, str, { family: K.accentFace, size: 26, weight: K.accentWeight, color: g.ink, lineHeight: 1.25, rotation: rot }));
      fill.push({ node: nodes.length - 1, label: `Instruction ${k + 1}`, hint: "One line, the way you would say it" });
    });
    // What good looks like: the bar on the deep ground under the notes.
    const bw = 3 * STICKY_W + 2 * STICKY_GAP, by = y0 + STICKY_H + 36, bh = cy + RING - by;
    nodes.push(rect(x0, by, bw, bh, deepGround(d), { radius: K.radius }));
    nodes.push(rect(x0, by, 8, bh, d.accent, { radius: 0 }));
    nodes.push(text(x0 + 44, by + 34, bw - 88, 28, c.goodLabel, td.eyebrow()));
    nodes.push(text(x0 + 44, by + 76, bw - 88, 100, c.good, td.strong(27, { lineHeight: 1.3 })));
    fill.push({ node: nodes.length - 1, label: "What good looks like", hint: "One test a card has to pass" });
    nodes.push(...note(K, g, c.note));
    return { page: { name: "The time box", bg: g.bg, nodes }, fill };
  },
};

export default {
  id: "deck-workshop",
  title: "Workshop Facilitation",
  base: "pulse",
  rank: 46,
  tags: [
    "workshop",
    "facilitation",
    "exercise",
    "team"
  ],
  meta: {
    company: "Loop",
    deck: "Workshop: the next bet",
    kicker: "Hands on",
    farewell: "Commitments",
    art: {
      cover: "il-day10-canvas-stand",
      section: "il-day73-writing-tool",
      picture: "il-day74-stationary-set",
      closing: "il-day4-polariod"
    }
  },
  look: {
    display: "Archivo Black", dw: 400,
    body: "Rubik", bw: 400,
    mono: null,
    accentFace: "Gloria Hallelujah", accentWeight: 400, accentSize: 36,
    charWidth: 0.64,
    paper: { bg: "#FFFDF5", ink: "#111111", muted: "#57544C", line: "#E3E0D5", panel: "#F5F2E8", panel2: "#EBE7DA", accent: "#F5C400", accentInk: "#745600", accent2: "#111111", accent2Ink: "#111111" },
    deep: { bg: "#1B1B1B", bg2: "#050505", ink: "#FFFFFF", muted: "#BDBAB1", line: "#353535", panel: "#262626", panel2: "#303030", accent: "#FFD200", accent2: "#FFF1A8" },
    radius: 6,
    ornament: "stripes",
    peeps: ["op-peep-2", "op-peep-11", "op-peep-28", "op-peep-33", "op-peep-44"],
    scale: { cover: 112, title: 60, section: 236, statement: 76, numeral: 100, quote: 50 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "What we will\nmake together",
        subtitle: "Three hours, twelve people, one wall of ideas, and a shortlist we all own by the end of the afternoon.",
        presenter: "Facilitated by Mei Lin  ·  15 October 2026",
        chips: [["3 hrs", "one room"], ["12", "people"], ["5", "we keep"]],
        note: "bring a marker, not a laptop"
      }
    ],
    [
      "table",
      {
        eyebrow: "Run of show  ·  15 October",
        title: "Three hours, five blocks",
        cols: ["", "Starts", "Minutes", "Who"],
        rows: [
          ["Arrive and ground rules", "13:00", "15", "Everyone"],
          ["Exercise one: twenty ideas", "13:15", "20 + 5", "Alone"],
          ["Share back", "13:50", "50", "Groups of four"],
          ["Converge: vote and cluster", "14:40", "40", "Everyone"],
          ["Commit", "15:20", "20", "The five owners"]
        ],
        note: "two breaks, both short, both real"
      }
    ],
    [
      "process",
      {
        eyebrow: "How today works",
        title: "Diverge, discuss, decide",
        steps: [
          [
            "Diverge",
            "Everyone generates alone first. Quantity over quality; judgment comes later."
          ],
          [
            "Discuss",
            "Each group shares back in one minute. Questions only, no rebuttals."
          ],
          [
            "Decide",
            "Dot-vote, cluster, and pick. The room decides; nobody vetoes after."
          ],
          [
            "Commit",
            "Every chosen idea leaves with an owner and a first step."
          ]
        ],
        note: "alone first, together after"
      }
    ],
    [
      "threeCards",
      {
        eyebrow: "Ground rules",
        title: "What keeps it safe and fast",
        cards: [
          [
            "clock",
            "Time boxes are real",
            "When the timer ends, pens down. Unfinished is fine; late is not."
          ],
          [
            "message",
            "Questions before opinions",
            "Ask what someone meant before saying what you think. Most disagreement is misunderstanding."
          ],
          [
            "heart",
            "Every idea gets read aloud",
            "Nothing is skipped because it looks odd on the card. The odd ones are usually the ones we keep."
          ]
        ],
        note: "safe is what makes it fast"
      }
    ],
    [
      "checklist",
      {
        eyebrow: "Before we start",
        title: "What is on your table",
        items: [
          ["A pad of sticky notes", true],
          ["A marker, not a pen", true],
          ["Three voting dots", true],
          ["The one-page brief", true],
          ["A timer you can see", true],
          ["Blank index cards", true],
          ["Coffee", false],
          ["Your laptop, shut", false]
        ],
        legend: ["on every table", "up to you"],
        art: "il-day74-stationary-set",
        note: "write big enough to read from across the room"
      }
    ],
    [
      "section",
      {
        n: "01",
        title: "Exercise one",
        blurb: "Twenty minutes alone with a stack of cards and a marker. Quantity first; judging comes later.",
        kicker: "Pens up",
        art: "il-day73-writing-tool",
        note: "markers up, phones face down"
      }
    ],
    [
      "raw",
      {
        build: signature.timer,
        eyebrow: "Exercise one  ·  the time box",
        title: "Twenty ideas in twenty minutes",
        minutes: "20",
        unit: "minutes, alone",
        steps: [
          "One idea per card: a headline and one sentence. No paragraphs.",
          "Draw if it helps. Nobody is grading the art, only the idea.",
          "Write until the timer stops. Then pick your best three for the wall."
        ],
        goodLabel: "What good looks like",
        good: "Specific enough that a stranger could build the first version. 'Better onboarding' is not an idea; 'preview before setup' is.",
        note: "when it rings, finish the word, not the sentence"
      }
    ],
    [
      "twoColumns",
      {
        eyebrow: "Share back and converge",
        title: "From forty cards to five",
        left: {
          eyebrow: "Share back",
          head: "One minute per group",
          lines: [
            "Headline, sentence, why it matters",
            "Clarifying questions only",
            "The facilitator holds the clock"
          ],
          icon: "microphone"
        },
        right: {
          eyebrow: "Converge",
          head: "Dot-vote and cluster",
          lines: [
            "Three dots each, no more than two on one idea",
            "Cluster the winners by theme",
            "The top five leave with an owner"
          ],
          icon: "circle-check"
        },
        note: "three dots each, no trading"
      }
    ],
    [
      "closing",
      {
        title: "Commitments",
        subtitle: "Five ideas, five owners, five first steps by next Friday. The wall gets photographed and posted before anyone leaves.",
        rows: [
          [
            "message",
            "#workshop-next-bet on Slack"
          ],
          [
            "mail",
            "mei@loop.example"
          ],
          [
            "calendar",
            "First steps due: 22 October"
          ]
        ],
        cta: "See the shortlist",
        note: "first steps, not whole plans"
      }
    ]
  ]
};
