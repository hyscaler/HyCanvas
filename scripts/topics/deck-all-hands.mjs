// Company All-Hands: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: cream paper with a coral accent and a cobalt second, a calm
// cobalt deep ground with a peach ink for accent text, a sun disc as the
// ornament, a rounded display face, a rounded body face and a marker
// handwriting for the kicker and the notes. A town hall, not a boardroom.
// The signature is the wins wall: six sticky notes pinned at slight angles
// across the slide, one person and one win each, in three tints.

import { text, rect, ellipse, art, chrome, note, type, mixHex, M } from "../lib/deck-kit.mjs";

// --- the wins wall -----------------------------------------------------------

const NOTE_W = 540, NOTE_H = 280, GAP_X = 54, GAP_Y = 38;
const TILT = [-2.4, 1.8, -1.3, 2.1, -1.7, 1.2];

/** The wall's six: name, team, the win, and which of the look's portraits.
 *  Index 4 of the portrait set is the quote's, so the wall skips it. */
const WINS = [
  ["Aisha Bello", "Support", "Ran the night shift through the Brightline weekend without a single escalation.", 0],
  ["Tomas Reyes", "Platform", "Found the import bug at 2 a.m. and shipped the fix before standup.", 1],
  ["Mei Lin", "Growth", "Built the upgrade flow that crossed $100K on its own.", 2],
  ["Jonah Park", "Sales", "Closed Brightline after eleven months and a lot of patience.", 3],
  ["Priya Nair", "Finance", "Closed the October books in four days with the auditors in the room.", 5],
  ["Sam Okafor", "Design", "Redrew the pricing page in a week; it beat the old one in its first test.", 6],
];

/** Where a point (u, v) in the frame of a card at (x, y), turned by deg,
 *  lands on the page. The engine rotates a node about its own top-left
 *  corner, so every child of a tilted card is placed here and given the
 *  card's tilt. */
function turned(x, y, deg, u, v) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [Math.round(x + u * c - v * s), Math.round(y + u * s + v * c)];
}

const signature = {
  /** The wins wall: two rows of three sticky notes, each pinned at its own
   *  slight angle, in three tints. A portrait, a name, a team and the win in
   *  the hand face. */
  wall(K, i) {
    const g = K.paper;
    const t = type(K, g);
    const { nodes, bodyTop } = chrome(K, g, i, "Shoutouts", "Six people who made the month");
    const fill = [];
    // Peach, yellow and a pale blue: cobalt mixed straight into cream goes
    // grey, so the blue note mixes toward a lighter sibling of the accent.
    const tints = [mixHex(g.bg, g.accent, 0.2), mixHex(g.bg, g.sun, 0.45), mixHex(g.bg, "#7FB0FF", 0.42)];
    // The team label is small type, so on the peach and yellow notes it
    // takes a deeper sibling of the accent ink to stay above 4.5:1.
    const label = mixHex(g.accentInk ?? g.accent, g.ink, 0.2);
    const tones = [label, label, g.accent2];
    const illustrations = [];
    const row0 = bodyTop + 16;
    WINS.forEach(([name, team, win, face], k) => {
      const col = k % 3, row = Math.floor(k / 3);
      const x = M + col * (NOTE_W + GAP_X);
      const y = row0 + row * (NOTE_H + GAP_Y);
      const deg = TILT[k];
      const tint = tints[k % 3];
      const tone = tones[k % 3];
      const at = (u, v) => turned(x, y, deg, u, v);
      // The shadow, then the note, then its pin.
      nodes.push(rect(x + 5, y + 9, NOTE_W, NOTE_H, g.ink, { rotation: deg, opacity: 0.1, radius: 4 }));
      nodes.push(rect(x, y, NOTE_W, NOTE_H, tint, { rotation: deg, radius: 4 }));
      const [px, py] = at(NOTE_W / 2 - 11, -9);
      nodes.push(ellipse(px, py, 22, 22, g.accent2, { rotation: deg }));
      const [hx, hy] = at(NOTE_W / 2 - 4, -5);
      nodes.push(ellipse(hx, hy, 8, 8, g.bg, { rotation: deg, opacity: 0.85 }));
      // The portrait: a white sticker circle with a drawn peep.
      const [cx, cy] = at(28, 26);
      nodes.push({ ...ellipse(cx, cy, 100, 100, mixHex(g.bg, "#FFFFFF", 0.75), { rotation: deg }), name: "Photo" });
      const [ax, ay] = at(40, 34);
      illustrations.push(art(K.peeps[face % K.peeps.length], ax, ay, 76, 84));
      const [nx, ny] = at(148, 36);
      nodes.push(text(nx, ny, 364, 36, name, t.display(26, { rotation: deg })));
      fill.push({ node: nodes.length - 1, label: `Name ${k + 1}`, hint: "Who made the difference" });
      const [tx, ty] = at(148, 76);
      nodes.push(text(tx, ty, 364, 24, team, t.eyebrow({ size: 14, letterSpacing: 3, color: tone, rotation: deg })));
      const [wx, wy] = at(28, 146);
      nodes.push(text(wx, wy, NOTE_W - 56, 112, win, { family: K.accentFace, size: 26, weight: 400, color: g.ink, lineHeight: 1.3, rotation: deg }));
      fill.push({ node: nodes.length - 1, label: `Win ${k + 1}`, hint: "One sentence, what they did" });
    });
    nodes.push(...note(K, g, "add yours in #wins, we pin them Friday"));
    return { page: { name: "Wins wall", bg: g.bg, nodes, illustrations }, fill };
  },
};

export default {
  id: "deck-all-hands",
  title: "Company All-Hands",
  base: "pulse",
  rank: 38,
  tags: [
    "all hands",
    "company",
    "update",
    "culture"
  ],
  meta: {
    company: "Loop",
    deck: "All-hands, October",
    kicker: "October all-hands",
    farewell: "See you next month",
    art: {
      cover: "la-small-character-illustrations",
      section: "il-day52-auntum",
      picture: "la-conversation-illustration",
      closing: "il-day26-rainbow"
    }
  },
  look: {
    display: "Baloo 2", dw: 700,
    body: "Nunito", bw: 500,
    mono: null,
    accentFace: "Kalam", accentWeight: 700, accentSize: 40,
    paper: { bg: "#FFF4E8", ink: "#2B1D17", muted: "#6E5A50", line: "#EBD8C8", panel: "#FFEBDB", panel2: "#FCDFC9", accent: "#E04A28", accentInk: "#BE3C26", accent2: "#2A4FCB", sun: "#FFC857" },
    deep: { bg: "#2643B5", bg2: "#172A78", ink: "#FFF4E8", muted: "#C9D2F5", line: "#4B66D1", panel: "#3352C4", panel2: "#3F5ED2", accent: "#FF8F73", accentInk: "#FFC4B3", accent2: "#FFC857", sun: "#FFC857" },
    radius: 20,
    ornament: "sun",
    // Six for the wall, and index 4 for the quote.
    peeps: ["op-peep-16", "op-peep-19", "op-peep-1", "op-peep-95", "op-peep-73", "op-peep-89", "op-peep-34"],
    scale: { cover: 118, title: 64, section: 240, statement: 80, numeral: 108, quote: 54 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "What October\nlooked like",
        subtitle: "Wins worth naming, the numbers against plan, what we are fixing, and the people who made the month.",
        presenter: "Elena Sato, Chief Executive  ·  31 October 2026",
        note: "forty minutes, then your questions"
      }
    ],
    [
      "threeCards",
      {
        eyebrow: "Wins to celebrate",
        title: "Three wins worth naming",
        cards: [
          [
            "trophy",
            "Brightline went live",
            "Our largest customer, 4,000 seats, migrated in a weekend. Not one ticket on Monday."
          ],
          [
            "sparkles",
            "Self-serve crossed $100K",
            "Monthly revenue with no sales call, for the first time. Growth is now a real team."
          ],
          [
            "heart",
            "Support hit a 96 satisfaction score",
            "Highest ever, with the queue at its longest. Thank the night shift."
          ]
        ],
        note: "zero tickets on Monday, we checked twice"
      }
    ],
    [
      "quote",
      {
        text: "You moved four thousand people over a weekend and nobody noticed on Monday. That is the whole review.",
        name: "Rowan Achebe",
        role: "Chief Financial Officer, Brightline Logistics",
        note: "Rowan said this on the Tuesday call"
      }
    ],
    [
      "figures",
      {
        eyebrow: "The numbers",
        title: "Where we stand against plan",
        stats: [
          [
            "$3.9M",
            "October revenue",
            "104% of plan",
            "Expansion carried it; new business was flat."
          ],
          [
            "1,940",
            "Customers",
            "+86 this month",
            "Churn at 1.3%, back under target."
          ],
          [
            "118",
            "People",
            "+7 this month",
            "Three in engineering, two in support, two in sales."
          ],
          [
            "19",
            "Months of runway",
            "Plan holds",
            "Before the round, at the current burn."
          ]
        ],
        note: "flat new business is the one to watch"
      }
    ],
    [
      "twoColumns",
      {
        eyebrow: "What we are fixing",
        title: "The honest view",
        left: {
          eyebrow: "Not working",
          head: "Onboarding takes too long",
          lines: [
            "Median time to first value: 11 days",
            "Half of new accounts need a call",
            "The import tool fails on large files"
          ],
          icon: "alert-triangle"
        },
        right: {
          eyebrow: "What we are doing",
          head: "A two-week onboarding sprint",
          lines: [
            "Import rebuilt for files over 1 GB",
            "Guided setup for the top three use cases",
            "Target: first value in under three days"
          ],
          icon: "circle-check"
        },
        note: "eleven days is the number we are chasing"
      }
    ],
    [
      "timeline",
      {
        eyebrow: "Next month",
        title: "Priorities everyone should know",
        done: 1,
        steps: [
          [
            "Week 1",
            "Onboarding sprint starts",
            "Growth and platform pair for two weeks. Everything else waits."
          ],
          [
            "Week 2",
            "Pricing page relaunch",
            "The new tiers go live; sales gets the talk track on Monday."
          ],
          [
            "Week 3",
            "Brightline case study",
            "Marketing publishes; every rep gets the one-pager."
          ],
          [
            "Week 4",
            "Planning week",
            "Q1 objectives drafted in the open. Comment on anything."
          ]
        ],
        note: "week four is yours: comment on anything"
      }
    ],
    [
      "raw",
      {
        build: signature.wall
      }
    ],
    [
      "closing",
      {
        title: "Thank you",
        subtitle: "Questions in the channel all week. The recording and the numbers are in the all-hands folder.",
        rows: [
          [
            "message",
            "#all-hands on Slack"
          ],
          [
            "mail",
            "elena@loop.example"
          ],
          [
            "calendar",
            "Next all-hands: 28 November"
          ]
        ],
        cta: "Ask a question",
        note: "recording in the folder by five"
      }
    ]
  ]
};
