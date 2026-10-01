// Team Retrospective: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: cream paper with a plum accent for the kicker, rules and
// numerals, sage for every second card and clay held in reserve for the
// board; a plum deep ground with a pale clay ink for accent text. Orbs as
// the ornament: floating discs in the two accents, the dots a room votes
// with. A humanist sans for titles, a soft sans for reading and a plain
// print hand for the kicker and the notes. A kitchen table, not a war room.
// The signature is the board: three columns of straight sticky notes taped
// at the top, four to a column in the column's tint, with the vote dots on
// the notes that won and a tag on the two that became the changes.

import { text, rect, ellipse, icon, button, chrome, note, type, mixHex, inkOn, M } from "../lib/deck-kit.mjs";

// --- the board ---------------------------------------------------------------

const COL_W = 552, COL_GAP = 36, NOTE_H = 132, NOTE_GAP = 12;

/** The three columns, four notes each: the note, its votes, and a tag on
 *  the notes that left the room as a change. Copy carries no names: the
 *  board is blameless by design. */
const BOARD = [
  {
    head: "Went well", icon: "circle-check",
    notes: [
      ["Pairing on the ticket that had been open for three sprints", 6],
      ["Nobody worked the weekend, first sprint since July", 5],
      ["The Wednesday demo changed the last three days for the better", 4],
      ["The new test runner: green in four minutes", 1],
    ],
  },
  {
    head: "Was hard", icon: "alert-triangle",
    notes: [
      ["Four pull requests sat two days with no review", 7],
      ["The spec changed on Thursday and nobody could say no", 5],
      ["Staging was down for most of Monday", 2],
      ["Standup ran long three days out of five", 1],
    ],
  },
  {
    head: "Try next", icon: "sparkles",
    notes: [
      ["Reviews first, every morning, before any new work", 8, "Change one"],
      ["Every scope change goes through one person", 6, "Change two"],
      ["A staging health check as the first line of standup", 2],
      ["Standup capped at ten minutes, a timer on the table", 1],
    ],
  },
];

const signature = {
  /** The board: three columns with a header each (an icon, the name and the
   *  column's vote total over a rule in its tone), then four sticky notes
   *  in the column's tint, taped at the top, the text in the hand face.
   *  Vote dots sit bottom right on the notes that got any; the two notes
   *  that became the changes carry a tag bottom left. */
  board(K, i) {
    const g = K.paper;
    const t = type(K, g);
    const { nodes, bodyTop } = chrome(K, g, i, "The board", "What the room said");
    const fill = [];
    // Sage, clay and plum stickies: each tint mixes the paper toward a
    // lighter sibling of its colour, so the notes stay bright rather than
    // greying the way the text-grade accents would.
    const tints = [mixHex(g.bg, "#A9C98F", 0.42), mixHex(g.bg, "#F0A47C", 0.38), mixHex(g.bg, "#C9A2C6", 0.4)];
    const tones = [g.accent2Ink ?? g.accent2, mixHex(g.sun, g.ink, 0.3), g.accentInk ?? g.accent];
    const dot = g.accentInk ?? g.accent;
    const y0 = bodyTop + 70;
    BOARD.forEach(({ head, icon: ic, notes }, c) => {
      const x = M + c * (COL_W + COL_GAP);
      const tone = tones[c];
      const total = notes.reduce((n, [, v]) => n + v, 0);
      // The header: icon, name, the vote total, and a rule in the tone.
      nodes.push(icon(ic, x, bodyTop + 4, 28, tone));
      nodes.push(text(x + 40, bodyTop, 300, 36, head, t.display(28, { color: tone })));
      nodes.push(text(x + COL_W - 200, bodyTop + 8, 200, 26, `${total} votes`, t.meta({ align: "right" })));
      nodes.push(rect(x, bodyTop + 48, COL_W, 3, tone, { radius: 2 }));
      notes.forEach(([str, votes, tag], k) => {
        const ny = y0 + k * (NOTE_H + NOTE_GAP);
        // The shadow, the note, then a strip of tape at the top edge.
        nodes.push(rect(x + 4, ny + 6, COL_W, NOTE_H, g.ink, { opacity: 0.08, radius: 3 }));
        nodes.push(rect(x, ny, COL_W, NOTE_H, tints[c], { radius: 3 }));
        nodes.push(rect(x + COL_W / 2 - 44, ny - 8, 88, 18, "#FFFFFF", { opacity: 0.55, rotation: k % 2 ? 2.5 : -3 }));
        nodes.push(text(x + 24, ny + 14, COL_W - 48, 66, str, { family: K.accentFace, size: 25, weight: K.accentWeight, color: g.ink, lineHeight: 1.25 }));
        fill.push({ node: nodes.length - 1, label: `${head}, note ${k + 1}`, hint: "One sticky note, no names" });
        // One dot per vote, bottom right; the room's dots, not a number.
        for (let v = 0; v < votes; v++) nodes.push(ellipse(x + COL_W - 36 - v * 18, ny + NOTE_H - 26, 12, 12, dot));
        if (tag) nodes.push(button(x + 24, ny + NOTE_H - 38, 128, 26, tag, { fill: dot, color: inkOn(K, dot), family: K.body, size: 13, weight: 700, upper: true, letterSpacing: 1, radius: 13 }));
      });
    });
    nodes.push(...note(K, g, "no names on the notes, on purpose"));
    return { page: { name: "The board", bg: g.bg, nodes }, fill };
  },
};

export default {
  id: "deck-retrospective",
  title: "Team Retrospective",
  base: "terra",
  rank: 48,
  tags: [
    "retro",
    "retrospective",
    "team",
    "agile"
  ],
  meta: {
    company: "Fernwood",
    deck: "Retro, sprint 18",
    kicker: "Candid, blameless",
    farewell: "Two changes, two owners",
    art: {
      cover: "il-day59-kitchen",
      section: "il-day26-rainbow",
      picture: "il-day11-blackboard",
      closing: "il-day30-cafe"
    }
  },
  look: {
    display: "Alegreya Sans", dw: 800,
    body: "Mulish", bw: 400,
    mono: null,
    accentFace: "Patrick Hand", accentWeight: 400, accentSize: 40,
    charWidth: 0.5,
    paper: { bg: "#F6F1E7", ink: "#2B2530", muted: "#6B6270", line: "#DCD3C6", panel: "#EEE8DB", panel2: "#E3DCCB", accent: "#7A4A78", accentInk: "#6A3C68", accent2: "#6F8C64", accent2Ink: "#46623E", sun: "#C8734E" },
    deep: { bg: "#4B2F4F", bg2: "#2C1A31", ink: "#F6F1E7", muted: "#DCD0DC", line: "#63476A", panel: "#573B5C", panel2: "#64476A", accent: "#E8A98A", accentInk: "#F0BFA6", accent2: "#B7CBA6", sun: "#E8A98A" },
    radius: 12,
    ornament: "orbs",
    peeps: ["op-peep-3", "op-peep-32", "op-peep-50", "op-peep-86", "op-peep-24"],
    scale: { cover: 116, title: 62, section: 236, statement: 80, numeral: 104, quote: 54 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "The work, the wins,\nthe weather",
        subtitle: "What went well and is worth repeating, what was hard and should be named, the data without judgment, and two changes we commit to.",
        presenter: "Facilitated by Dana Whitfield  ·  18 October 2026",
        note: "sixty minutes, phones in the basket"
      }
    ],
    [
      "fourCards",
      {
        eyebrow: "How we run this hour",
        title: "Four agreements first",
        cards: [
          [
            "heart",
            "Blameless, by design",
            "Everyone did the best they could with what they knew. We fix the system, not the person."
          ],
          [
            "hourglass",
            "Sixty minutes, timed",
            "Ten to write, ten to read, fifteen to talk, ten to vote, fifteen to decide."
          ],
          [
            "message",
            "One voice at a time",
            "Whoever holds the pen speaks. Nobody explains someone else's note."
          ],
          [
            "thumb-up",
            "The votes decide",
            "Three dots each. Whatever wins the board becomes the two changes."
          ]
        ],
        note: "the timer sits on the table, not on a screen"
      }
    ],
    [
      "raw",
      {
        build: signature.board
      }
    ],
    [
      "threeCards",
      {
        eyebrow: "What went well",
        title: "Things worth repeating",
        cards: [
          [
            "heart",
            "Pairing on the hard ticket",
            "Two people, one afternoon, a bug that had been open for three sprints. Keep doing this on purpose."
          ],
          [
            "circle-check",
            "The demo on Wednesday",
            "Showing the customer mid-sprint changed the last three days of work for the better."
          ],
          [
            "sparkles",
            "Nobody worked the weekend",
            "First sprint since July. The scope was right-sized and it showed."
          ]
        ],
        note: "the weekend one got the loudest cheer"
      }
    ],
    [
      "quote",
      {
        text: "Sales promised the field on Thursday and nobody knew who could say no. So everyone said yes.",
        name: "Jonah Reyes",
        role: "Engineer, from the notes on the board",
        note: "said out loud in the room, which is the point"
      }
    ],
    [
      "twoColumns",
      {
        eyebrow: "What was hard",
        title: "Friction we should name",
        left: {
          eyebrow: "The friction",
          head: "Reviews waited two days",
          lines: [
            "Four pull requests sat untouched",
            "Two people carried all the reviews",
            "One feature missed the sprint because of it"
          ],
          icon: "alert-triangle"
        },
        right: {
          eyebrow: "The other friction",
          head: "The spec changed on Thursday",
          lines: [
            "Sales promised a field we had not built",
            "Half a day lost to the rework",
            "Nobody knew who could say no"
          ],
          icon: "alert-triangle"
        },
        note: "two frictions, one root: nobody owned the no"
      }
    ],
    [
      "figures",
      {
        eyebrow: "The data",
        title: "Cycle time and scope, without judgment",
        stats: [
          [
            "4.2 days",
            "Median cycle time",
            "−0.8 days",
            "Faster than the last three sprints; the small tickets moved quickly."
          ],
          [
            "2.1 days",
            "Review wait",
            "+1.2 days",
            "The one number that got worse. It is the review problem, not the code."
          ],
          [
            "18%",
            "Scope change",
            "+11 pts",
            "Two stories added mid-sprint, one removed."
          ],
          [
            "11 of 12",
            "Stories done",
            "Same as last sprint",
            "The one carried is waiting on the review."
          ]
        ],
        note: "review wait is the only one that moved the wrong way"
      }
    ],
    [
      "section",
      {
        n: "",
        title: "The two we\ncommit to",
        blurb: "Eleven notes got votes. The two that won leave the room with an owner and a number we check at the next retro.",
        kicker: "From the votes to the work",
        art: "il-day26-rainbow",
        note: "after the weather, the rainbow"
      }
    ],
    [
      "twoColumns",
      {
        eyebrow: "Actions",
        title: "Two changes we commit to",
        left: {
          eyebrow: "Change one",
          head: "Reviews first, every morning",
          lines: [
            "Owner: Tomas",
            "Nobody starts new work with a review waiting",
            "Measured: review wait under one day"
          ],
          icon: "circle-check"
        },
        right: {
          eyebrow: "Change two",
          head: "Scope changes go through one person",
          lines: [
            "Owner: Priya",
            "Sales asks Priya, Priya asks the team",
            "Measured: scope change under 10%"
          ],
          icon: "circle-check"
        },
        note: "two numbers, checked on 1 November"
      }
    ],
    [
      "closing",
      {
        title: "Thank you",
        subtitle: "Two changes, two owners, checked at the next retro. Everything said in this room stays about the work.",
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
            "Next retro: 1 November"
          ]
        ],
        cta: "See the actions",
        note: "the kettle is on, stay if you like"
      }
    ]
  ]
};
