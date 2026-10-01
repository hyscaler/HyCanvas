// Conference Talk: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: a keynote at poster scale. The deep pages are black, the reading
// pages are acid yellow with black type, so the deck alternates between a
// black poster and a yellow one and never looks like a document. One heavy
// condensed display face carries every title and every figure; a plain
// screen sans reads the body; a marker hand is the speaker's voice in the
// kicker and the asides. Black is the accent on yellow, yellow
// is the accent on black, and a dark olive is the only other colour, for
// every second card. The ornament is one disc off the top right corner: a
// spotlight on the black pages, a black dot on the yellow ones. No radius
// anywhere: posters have corners.

import { text, footer, note, ornamentDeep, type, deepGround, fitSize, W, M, CW } from "../lib/deck-kit.mjs";

// --- the signature slide -------------------------------------------------------

/** The claim: the talk's one sentence at poster size, filling the page. The
 *  sentence runs up to its turn in white, then the words the room should
 *  remember in acid yellow at the largest size the width allows. The
 *  speaker's handle sits small in the top left corner, and nothing else. */
const signature = {
  claim(K, i, c) {
    const g = K.deep;
    const t = type(K, g);
    const fill = [];
    const yellow = g.accentInk ?? g.accent;
    const cw = K.charWidth ?? 0.56;

    // The setup: the sentence up to its turn, in white caps.
    const setupSize = 96;
    const setupLines = c.setup.split("\n").length;
    const setupH = Math.round(setupSize * 1.02 * setupLines) + 8;
    const setupY = 160;

    // The turn: as large as the content width allows, in acid yellow.
    const size = fitSize(c.payoff, 290, CW, 0.6, cw);
    const lines = c.payoff.split("\n").length;
    const payoffY = setupY + setupH + 20;
    const payoffH = Math.round(size * 0.94 * lines) + 12;

    // The sun scatters its sparkle over the top of the page, and this page is
    // type from edge to edge: keep only the dots that fall clear of a line.
    const lineBoxes = [
      ...c.setup.split("\n").map((l, k) => ({ x: M, y: setupY + k * setupSize, w: l.length * setupSize * cw, h: setupSize })),
      ...c.payoff.split("\n").map((l, k) => ({ x: M, y: payoffY + k * size * 0.92, w: l.length * size * cw, h: size })),
    ];
    const pad = 12;
    const clearOfType = (n) => n.kind !== "ellipse" || n.w > 20
      || !lineBoxes.some((b) => n.x + n.w > b.x - pad && n.x < b.x + b.w + pad && n.y + n.h > b.y - pad && n.y < b.y + b.h + pad);
    const nodes = ornamentDeep(K, g).filter(clearOfType);

    // The handle, on the reading grid's eyebrow baseline.
    nodes.push(text(M, 84, 900, 30, c.handle, t.strong(22, { color: yellow })));
    fill.push({ node: nodes.length - 1, label: "Speaker handle", hint: "Your handle, and the event" });

    nodes.push(text(M, setupY, CW, setupH, c.setup, t.display(setupSize, { lineHeight: 1.0, upper: true })));
    fill.push({ node: nodes.length - 1, label: "The claim, up to the turn", hint: "The sentence, stopping where the surprise starts" });

    nodes.push(text(M, payoffY, CW, payoffH, c.payoff, t.display(size, { lineHeight: 0.92, upper: true, color: yellow })));
    fill.push({ node: nodes.length - 1, label: "The claim, the turn", hint: "The words you want them to leave with, two short lines" });

    nodes.push(...footer(K, g, i));
    return { page: { name: "The claim", bg: deepGround(g), nodes }, fill };
  },
};

export default {
  id: "deck-conference-talk",
  title: "Conference Talk",
  base: "vanta",
  rank: 84,
  tags: [
    "conference",
    "talk",
    "keynote",
    "tech"
  ],
  styleTags: ["bold", "poster", "dark"],
  meta: {
    company: "Nova Systems",
    deck: "Talk: the boring platform",
    kicker: "one idea, defended",
    farewell: "go and make something boring",
    art: {
      cover: "il-day22-owl",
      section: "il-day13-it-girl",
      picture: "la-relaxing",
      closing: "la-relaxing"
    }
  },
  look: {
    display: "Anton", dw: 400,
    body: "Geist", bw: 400,
    mono: null,
    accentFace: "Covered By Your Grace", accentWeight: 400, accentSize: 44,
    // Anton runs about 0.42 em per character; the estimate stays a little
    // conservative so a heavy line never overruns its box.
    charWidth: 0.44,
    // Yellow pages type in black (17.6:1) with a dark olive as the second
    // voice (7.2:1); black pages type in white and acid yellow (16.4:1).
    // No accent vibrates as text on either ground, so no accentInk.
    paper: { bg: "#E9FF33", ink: "#0B0B0B", muted: "#3F4712", line: "#C4D91C", panel: "#F3FF99", panel2: "#FBFFD4", accent: "#0B0B0B", accent2: "#4A5600", sun: "#0B0B0B" },
    deep: { bg: "#151515", bg2: "#000000", ink: "#FFFFFF", muted: "#A9A9A9", line: "#2E2E2E", panel: "#1F1F1F", panel2: "#2A2A2A", accent: "#E9FF33", accent2: "#FFFFFF", sun: "#E9FF33" },
    radius: 0,
    ornament: "sun",
    peeps: ["op-peep-10", "op-peep-19", "op-peep-33", "op-peep-50", "op-peep-77"],
    // The cover title at 120 keeps the subtitle clear of the chip row, which
    // sits on a fixed baseline; the claim slide carries the poster scale.
    scale: { cover: 120, title: 68, section: 260, statement: 88, numeral: 112, quote: 58 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "Make the platform\nboring",
        subtitle: "One idea, defended: the best platform team is the one nobody talks about. Eighteen months of getting there.",
        presenter: "Tomas Reyes, Engineering Lead  ·  PlatformConf 2026",
        chips: [
          [
            "18",
            "months"
          ],
          [
            "3",
            "failures"
          ],
          [
            "1",
            "idea"
          ]
        ],
        art: "il-day22-owl",
        note: "the on-call phone has not rung since March"
      }
    ],
    [
      "raw",
      {
        build: signature.claim,
        handle: "@tomasreyes  ·  PlatformConf 2026",
        setup: "The best platform team\nis the one",
        payoff: "nobody\ntalks about."
      }
    ],
    [
      "statement",
      {
        text: "Every platform team we know is proud of the incident it handled well. We wanted to be proud of the one that never happened.",
        source: "The problem everyone in this room has",
        note: "hands up if you have a war room channel"
      }
    ],
    [
      "threeCards",
      {
        eyebrow: "What we tried",
        title: "The failures that taught us",
        cards: [
          [
            "presentation",
            "More dashboards",
            "We built forty. Nobody looked at thirty-eight of them. A dashboard is a question somebody asked once."
          ],
          [
            "bell",
            "More alerts",
            "We doubled them. On-call muted half within a month. Volume is not signal."
          ],
          [
            "flame",
            "A war room",
            "We staffed one for a quarter. It made incidents feel handled and did nothing to make them rarer."
          ]
        ],
        note: "forty dashboards. we counted twice."
      }
    ],
    [
      "quote",
      {
        text: "I muted half the alerts in month two.\nNobody noticed for a quarter.\nThat was the day we knew.",
        name: "Ana Ferreira",
        role: "On-call engineer, Nova Systems. Said at the retro that started all of this.",
        note: "we kept the quote and deleted the alerts"
      }
    ],
    [
      "process",
      {
        eyebrow: "What worked",
        title: "The approach, step by step",
        steps: [
          [
            "One timeline",
            "Every change and every alert in one place. The first week, three incidents explained themselves."
          ],
          [
            "Ten alerts",
            "We kept the ten that had ever paged for a real cause and deleted the rest. Pages fell by 70%."
          ],
          [
            "Change budgets",
            "Any service over its error budget stops deploying until it is back. Nobody argued after the second month."
          ],
          [
            "Narratives, not reviews",
            "The timeline writes the first paragraph. The review became a conversation instead of a blank page."
          ]
        ],
        note: "the order matters. the timeline pays for the rest."
      }
    ],
    [
      "figures",
      {
        eyebrow: "The evidence",
        title: "The numbers from production",
        stats: [
          [
            "−70%",
            "Pages per week",
            "18 months",
            "From 41 to 12, with three times the services."
          ],
          [
            "9 min",
            "Median time to cause",
            "Was 52",
            "Measured from the first alert to the change named in the channel."
          ],
          [
            "99.97%",
            "Uptime",
            "Was 99.6%",
            "Twelve months, every customer-facing service."
          ],
          [
            "0",
            "Weekend deploys",
            "Was 14 a month",
            "Nobody misses them."
          ]
        ],
        note: "twelve months, every customer-facing service, no rounding"
      }
    ],
    [
      "section",
      {
        n: "",
        title: "What to do\nMonday",
        blurb: "Three things, none of them a dashboard. Each one fits in a morning, and the first one is free.",
        kicker: "the part you can take home",
        art: "il-day13-it-girl",
        wide: true,
        note: "start with the timeline. it pays for the other two."
      }
    ],
    [
      "threeCards",
      {
        eyebrow: "What you should do Monday",
        title: "Three things to try this week",
        cards: [
          [
            "clock",
            "Build the timeline",
            "Even a shared channel where every deploy and every alert is posted. Read it backwards at the next incident."
          ],
          [
            "bell",
            "Delete an alert",
            "Find one that has never paged for a real cause. Delete it. Tell the team why. Repeat on Tuesday."
          ],
          [
            "pencil",
            "Write the narrative first",
            "At the next incident, write what happened in three sentences before the review meeting. Watch the meeting get shorter."
          ]
        ],
        note: "if you only do one, delete the alert"
      }
    ],
    [
      "closing",
      {
        title: "Thank you",
        subtitle: "Slides, the alert audit template and the timeline setup guide are at the link. Find me at the platform track table.",
        rows: [
          [
            "world",
            "novasystems.example/boring"
          ],
          [
            "mail",
            "tomas@novasystems.example"
          ],
          [
            "message",
            "@tomasreyes"
          ]
        ],
        cta: "Get the slides",
        art: "la-relaxing",
        note: "I will be the calm one at the table"
      }
    ]
  ]
};
