// Team Offsite: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: cream paper with pine for the ink, a campfire orange for the
// kicker, rules and numerals, and lake blue for every second card; a deep
// ground that runs from lake blue into the night, with a warmer, paler
// orange for accent text there. Ridges as the ornament: soft ridgelines
// along the bottom, a moon and two layers of stars, the evening by the
// water. A rounded geometric display, a plain humanist body and a loose
// hand for the kicker and the notes. Relaxed, but on purpose.
// The signature is the two-day grid: two columns of time-stamped session
// blocks, each tinted by its kind (talk, work, break) and sized by its
// length, and the dinner as one deep band across both, where day one ends.

import { text, rect, ellipse, icon, button, chrome, note, type, sparkles, deepGround, mixHex, M, CW } from "../lib/deck-kit.mjs";

// --- the two-day grid ----------------------------------------------------------

const COL_GAP = 40;
const COL_W = (CW - COL_GAP) / 2;
const BLOCK_GAP = 10;

/** A block's height from its length in minutes: a coffee is a strip, the
 *  three-hour planning session is the tallest thing on the page. A session
 *  is never shorter than two lines, so its pill never shares a row with
 *  the line under its name. */
const blockH = (min, session) => Math.max(session ? 72 : 52, Math.min(150, Math.round(min * 0.5 + 46)));

const signature = {
  /** Two columns, one per day, headed by the day and its date. Each block
   *  carries its start time in the kind's tone, its name, a line under it
   *  and, for a session, a pill with the length; a break is one line. The
   *  dinner is a band on the deep ground across both columns, with the
   *  evening's sparkle where no text sits. A legend on the title row names
   *  the three kinds. */
  twoDays(K, i, c) {
    const g = K.paper;
    const d = K.deep;
    const t = type(K, g);
    const td = type(K, d);
    // The title keeps clear of the legend on its row.
    const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title, { titleWidth: 1140 });
    const fill = [];
    fill.push({ node: nodes.findIndex((n) => n.text === c.title), label: "Title", hint: "What the two days are for" });
    const tones = { talk: g.accent2Ink ?? g.accent2, work: g.accentInk ?? g.accent, break: g.muted };
    const tints = { talk: mixHex(g.bg, g.accent2, 0.14), work: mixHex(g.bg, g.accent, 0.14), break: g.panel };
    const subInk = mixHex(g.muted, g.ink, 0.35);
    const radius = Math.min(K.radius, 14);
    // The legend, on the title row, right of the title and clear of the
    // ornament's disc in the corner.
    c.legend.forEach(([kind, label], k) => {
      const x = 1276 + k * 172;
      nodes.push(ellipse(x, 152, 16, 16, tints[kind], { stroke: tones[kind], strokeWidth: 2 }));
      nodes.push(text(x + 26, 148, 140, 24, label, t.meta({ size: 15 })));
    });
    const top = bodyTop + 66;
    let bottom = top;
    c.days.forEach(({ head, date, blocks }, k) => {
      const x = M + k * (COL_W + COL_GAP);
      nodes.push(text(x, bodyTop, 260, 36, head, t.display(28)));
      nodes.push(text(x + 200, bodyTop + 8, COL_W - 200, 24, date, t.meta()));
      nodes.push(rect(x, bodyTop + 46, COL_W, 2, g.line));
      let y = top;
      blocks.forEach(([time, name, sub, min, kind]) => {
        const session = kind !== "break";
        const h = blockH(min, session);
        const tone = tones[kind];
        nodes.push(rect(x, y, COL_W, h, tints[kind], { radius }));
        // The kind dot sits on the time's line, not the block's middle, so a
        // tall block reads as one entry that runs long.
        nodes.push(ellipse(x + 24, h >= 70 ? y + 24 : y + (h - 12) / 2, 12, 12, tone));
        if (h >= 70) {
          nodes.push(text(x + 52, y + 16, 80, 28, time, t.strong(20, { color: tone })));
          nodes.push(text(x + 140, y + 14, COL_W - 300, 30, name, t.display(24)));
          nodes.push(text(x + 140, y + 44, COL_W - 300, 24, sub, t.body(17, { color: subInk })));
        } else {
          nodes.push(text(x + 52, y + (h - 28) / 2, 80, 28, time, t.strong(20, { color: tone })));
          nodes.push(text(x + 140, y + (h - 30) / 2, 320, 30, name, t.display(22)));
          nodes.push(text(x + 470, y + (h - 24) / 2, COL_W - 494, 24, sub, t.body(17, { color: subInk })));
        }
        if (session) nodes.push(button(x + COL_W - 132, y + 16, 108, 30, `${min} min`, { fill: mixHex(tints[kind], tone, 0.14), color: tone, family: K.body, size: 14, weight: 700 }));
        y += h + BLOCK_GAP;
      });
      bottom = Math.max(bottom, y);
    });
    // The dinner: one band across both days on the deep ground.
    const dy = bottom + 16, dh = 96;
    nodes.push(rect(M, dy, CW, dh, deepGround(d), { radius: K.radius }));
    nodes.push(...sparkles(d.accent, 30 + i, 6, { x: M + 1180, y: dy + 10, w: 520, h: dh - 20 }));
    nodes.push(icon("flame", M + 32, dy + 30, 36, d.accent));
    nodes.push(text(M + 88, dy + 34, 80, 28, c.dinner.time, td.strong(20, { color: d.accentInk ?? d.accent })));
    nodes.push(text(M + 176, dy + 20, 260, 34, c.dinner.head, td.display(28)));
    nodes.push(text(M + 176, dy + 56, 900, 24, c.dinner.sub, td.body(17)));
    nodes.push(...note(K, g, c.note));
    return { page: { name: "The two days", bg: g.bg, nodes }, fill };
  },
};

export default {
  id: "deck-team-offsite",
  title: "Team Offsite",
  base: "terra",
  rank: 66,
  tags: [
    "offsite",
    "team",
    "planning",
    "culture"
  ],
  meta: {
    company: "Fernwood",
    deck: "Team offsite, Q4",
    kicker: "Relaxed, but on purpose",
    farewell: "Before the shuttle leaves",
  },
  look: {
    display: "Quicksand", dw: 700,
    body: "Figtree", bw: 400,
    mono: null,
    accentFace: "Handlee", accentWeight: 400, accentSize: 40,
    paper: { bg: "#F7F3E9", ink: "#1B3129", muted: "#5B6A63", line: "#D8D3C4", panel: "#EEE9DC", panel2: "#E3DECE", accent: "#E0692A", accent2: "#2E7EA6", accentInk: "#9E3F0E", accent2Ink: "#1D5F80", sun: "#F0B64A" },
    deep: { bg: "#1C4757", bg2: "#0D2A36", ink: "#F7F3E9", muted: "#B5C9CF", line: "#2F6274", panel: "#25566A", panel2: "#2E667C", accent: "#F28E4E", accent2: "#8FD3EA", accentInk: "#F9AE72", sun: "#F0B64A" },
    radius: 18,
    ornament: "ridges",
    art: {
      cover: "il-day96-camping",
      section: "il-day21-lantern",
      picture: "il-day31-sweet-home",
      closing: "il-day61-travel-bag"
    },
    peeps: ["op-peep-31", "op-peep-44", "op-peep-67", "op-peep-77", "op-peep-94"],
    scale: { cover: 112, title: 60, section: 230, statement: 78, numeral: 104, quote: 54 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "Why we are here\nin person",
        subtitle: "Two days, four sessions and one dinner: the state of the team, the conversation we keep avoiding, and next quarter drafted together.",
        presenter: "Hosted by Dana Whitfield  ·  Lakeside Lodge, 5 and 6 November",
        art: "il-day96-camping",
        note: "phones go in the basket by the door"
      }
    ],
    [
      "raw",
      {
        build: signature.twoDays,
        eyebrow: "The two days",
        title: "Two days, four sessions, one dinner",
        legend: [["talk", "someone presents"], ["work", "we make something"], ["break", "food, air, coffee"]],
        days: [
          {
            head: "Day one",
            date: "Wednesday 5 November",
            blocks: [
              ["09:30", "Coffee and check-in", "The good espresso", 30, "break"],
              ["10:00", "State of the team", "What the survey said, and what we make of it", 60, "talk"],
              ["11:15", "The big conversation", "The one topic we keep avoiding", 90, "work"],
              ["12:45", "Lunch on the porch", "One table, everyone", 60, "break"],
              ["14:00", "The lake walk", "Gentle loop or the jetty, in pairs you did not pick", 90, "break"]
            ]
          },
          {
            head: "Day two",
            date: "Thursday 6 November",
            blocks: [
              ["09:00", "Coffee", "Slower start, on purpose", 30, "break"],
              ["09:30", "Planning session", "Next quarter, drafted together on the wall", 180, "work"],
              ["12:30", "Lunch", "The cards stay on the wall", 60, "break"],
              ["13:30", "Commitments", "One each, written, read aloud", 45, "talk"],
              ["14:30", "Shuttle home", "Leaves at 15:00 sharp", 30, "break"]
            ]
          }
        ],
        dinner: {
          time: "19:00",
          head: "Dinner",
          sub: "Day one ends here: no agenda, one long table, everyone, and the fire after."
        },
        note: "the lake walk is not optional, the jetty is"
      }
    ],
    [
      "facts",
      {
        eyebrow: "Where we are staying",
        title: "Lakeside Lodge",
        intro: "A timber lodge on the north shore, two hours from the office: a main hall, a long porch, a jetty, and not one meeting room.",
        items: [
          ["map-pin", "Two hours by shuttle", "Leaves the office car park at 07:45"],
          ["home", "A hall that seats all 26", "Sessions, meals and the wall of cards"],
          ["bed", "Thirteen twin cabins", "Pairs land in your inbox on Friday"],
          ["cloud", "Highs of 9, lows of 2", "A hoodie and an opinion, both required"]
        ],
        art: "il-day31-sweet-home"
      }
    ],
    [
      "fourCards",
      {
        eyebrow: "How we do this",
        title: "Four agreements for two days",
        cards: [
          ["clock", "Sessions start on time", "The room does not wait, and neither does the walk."],
          ["microphone", "Everyone speaks", "Every session ends with a round, quietest first."],
          ["device-mobile", "Phones in the basket", "Notes on cards; a photo of the wall at the end."],
          ["heart", "Kind by default", "Hard things said plainly, and taken well."]
        ],
        note: "kept from the spring offsite, because it worked"
      }
    ],
    [
      "section",
      {
        n: "01",
        title: "State of\nthe team",
        blurb: "What the survey said, what it did not, and the one score that fell.",
        kicker: "Day one, 10:00, the main hall",
        art: "il-day21-lantern",
        note: "24 of 26 answered. That is a mandate."
      }
    ],
    [
      "figures",
      {
        eyebrow: "State of the team",
        title: "What the team said in the survey",
        stats: [
          [
            "8.1",
            "Would recommend the team",
            "+0.6 on spring",
            "Highest since the survey started."
          ],
          [
            "6.2",
            "Clarity on priorities",
            "-0.9 on spring",
            "The one score that fell. This is the big conversation."
          ],
          [
            "7.8",
            "Manager support",
            "Flat",
            "Consistent across every sub-team."
          ],
          [
            "91%",
            "Response rate",
            "24 of 26",
            "Enough to trust the numbers."
          ]
        ],
        note: "6.2 is the whole reason for session two"
      }
    ],
    [
      "statement",
      {
        text: "The topic we keep avoiding: we say yes to everything, and then we quietly drop half of it.",
        source: "The big conversation, day one, 11:15",
        note: "ninety minutes, one topic, nobody leaves early"
      }
    ],
    [
      "process",
      {
        eyebrow: "Day two, the planning session",
        title: "Next quarter, drafted together",
        steps: [
          [
            "Diverge",
            "Everyone writes the three things the quarter must deliver. Twenty minutes, alone, on cards."
          ],
          [
            "Cluster",
            "Cards on the wall, grouped by theme, duplicates merged. No debate yet."
          ],
          [
            "Decide",
            "Dot-vote to five themes. Argue for the sixth if you must; it needs a sponsor."
          ],
          [
            "Own",
            "Each theme gets an owner and a first milestone before we leave the room."
          ]
        ],
        note: "three hours, one wall, a lot of dots"
      }
    ],
    [
      "closing",
      {
        title: "What we take home",
        subtitle: "One commitment each, written on a card, read aloud, and checked at the December retro.",
        rows: [
          [
            "message",
            "#team-fernwood on Slack"
          ],
          [
            "mail",
            "dana@fernwood.example"
          ],
          [
            "calendar",
            "Check-in: December retro"
          ]
        ],
        cta: "See the commitments",
        art: "il-day61-travel-bag",
        note: "one card each, read aloud, no passes"
      }
    ]
  ]
};
