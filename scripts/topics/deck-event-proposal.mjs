// Event Proposal: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: midnight, neon pink and champagne gold; a dark deck, the paper
// one shade lighter than the deep gradient, the way an invitation card is
// printed on night blue. A high-contrast Bodoni for every title and figure,
// a geometric sans for reading, a script for the kicker and the notes. The
// ornament is the year as a monogram: an enormous "27" ghosted bottom
// right of every page. Pink is the headline act and gold is the champagne;
// a lighter pink carries any accent that has to read as text.
//
// The signature slide is the run of show: the day as a vertical timeline
// down the page, one block per act with its height set by its minutes, so
// the keynote is the largest block and the encore closes the page in gold.
// Each block carries its owner and its minute count in columns at right.

import { text, rect, ellipse, halo, sparkles, chrome, note, card, type, mixHex, inkOn, M, W } from "../lib/deck-kit.mjs";

// --- the run of show -----------------------------------------------------------

const SHOW = {
  eyebrow: "Run of show  ·  Thursday 13 May 2027",
  title: "Ten hours, one stage",
  // { time, head, sub, owner, min, tone }: tone "star" is the headline act
  // (pink), "encore" the last block (gold); everything else sits on a card.
  blocks: [
    { time: "09:00", head: "Doors and coffee", sub: "Registration, the product wall, and the first customer conversations of the day.", owner: "Aisha Bello", min: 60 },
    { time: "10:00", head: "The keynote", sub: "The 2027 plan, two customer stories on stage, and one launch nobody expects.", owner: "Priya Raman", min: 120, tone: "star" },
    { time: "12:00", head: "Lunch", sub: "Long tables on the terrace, seated by industry.", owner: "Aisha Bello", min: 60 },
    { time: "13:00", head: "Workshops", sub: "Three tracks, forty people each, hands on with their own data.", owner: "Mei Lin", min: 90 },
    { time: "14:30", head: "Roundtables", sub: "Eight tables, one rep and one product lead at each.", owner: "Jonah Park", min: 60 },
    { time: "15:30", head: "Ask us anything", sub: "The product team on stage, the questions from the floor, nothing off the table.", owner: "Priya Raman", min: 90 },
    { time: "17:00", head: "The encore", sub: "Drinks on the terrace, the band at six, and the photo everyone posts.", owner: "Jonah Park", min: 120, tone: "encore" },
  ],
  note: "the band is on hold too, until Friday",
};

/** The run of show: a spine down the left with a dot per act, the acts as
 *  blocks whose heights are their minutes (600 minutes over 600 pixels),
 *  the keynote in pink under a halo and the encore in gold at the foot of
 *  the page. The owner and the minute count sit in two columns at right,
 *  on the same line as each act's heading. */
function runOfShow(K, i, c) {
  const g = K.paper;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
  const fill = [{ node: nodes.findIndex((n) => n.text === c.title), label: "Title", hint: "One short line" }];
  // A little glitter top right, where nothing is written.
  nodes.push(...sparkles(g.accent2, 31, 6, { x: 1340, y: 84, w: 480, h: 120 }));

  // Columns: the time, the spine, the block, the owner, the minutes.
  const tx = M, sx = M + 140, bx = M + 180, bw = 904, ox = 1230, ow = 280, mx = 1540, mw = W - M - 1540;
  const head = t.eyebrow({ size: 15, letterSpacing: 3 });
  nodes.push(text(tx, bodyTop, 120, 24, "Time", head));
  nodes.push(text(bx, bodyTop, 400, 24, "On stage", head));
  nodes.push(text(ox, bodyTop, ow, 24, "Owner", head));
  nodes.push(text(mx, bodyTop, mw, 24, "Minutes", t.eyebrow({ size: 15, letterSpacing: 3, align: "right" })));

  // One pixel per minute, the blocks separated by a six pixel gap.
  const y0 = bodyTop + 44;
  const total = c.blocks.reduce((n, b) => n + b.min, 0);
  const s = 600 / total;
  let y = y0;
  const rows = c.blocks.map((b) => { const r = { ...b, y, h: Math.round(b.min * s) - 6 }; y += Math.round(b.min * s); return r; });
  nodes.push(rect(sx - 1, y0, 3, Math.round(total * s) - 6, g.line));

  // The headline act is lit: a halo behind the largest block, under everything.
  const star = rows.find((r) => r.tone === "star") ?? rows[0];
  nodes.push(...halo(bx + bw / 2, star.y + star.h / 2, 380, g.accent));

  rows.forEach((r) => {
    const tall = r.h >= 100, mid = r.h >= 80;
    const fillC = r.tone === "star" ? g.accent : r.tone === "encore" ? g.accent2 : g.panel;
    const inkC = r.tone ? inkOn(K, fillC) : g.ink;
    // The sub-line on a coloured block is its ink tinted toward the fill:
    // a lighter tint on the pink, which starts near 6:1, than on the gold,
    // which starts past 12:1, so both stay above 4.5:1.
    const subC = r.tone === "star" ? mixHex(inkC, fillC, 0.16) : r.tone ? mixHex(inkC, fillC, 0.28) : g.muted;
    const headSize = tall ? 30 : mid ? 26 : 24;
    const headY = mid ? 18 : Math.round((r.h - Math.round(headSize * 1.2)) / 2);
    if (r.tone) nodes.push(rect(bx, r.y, bw, r.h, fillC));
    else nodes.push(card(K, g, bx, r.y, bw, r.h));
    // The dot on the spine, on the heading's line.
    nodes.push(ellipse(sx - 8, r.y + headY + Math.round(headSize * 0.6) - 8, 17, 17, r.tone ? fillC : g.muted));
    nodes.push(text(tx, r.y + headY + Math.round((headSize * 1.2 - 26) / 2), 120, 26, r.time, { family: K.body, size: 22, weight: 600, color: g.ink, lineHeight: 1.2 }));
    nodes.push(text(bx + 28, r.y + headY, bw - 56, Math.round(headSize * 1.2), r.head, t.display(headSize, { color: inkC })));
    if (r.tone === "star") fill.push({ node: nodes.length - 1, label: "Headline act", hint: "The block the day is built around" });
    if (mid) nodes.push(text(bx + 28, r.y + headY + Math.round(headSize * 1.2) + 4, bw - 56, 28, r.sub, t.body(19, { color: subC })));
    nodes.push(text(ox, r.y + headY + Math.round((headSize * 1.2 - 28) / 2), ow, 28, r.owner, t.strong(21)));
    const msize = r.tone ? 34 : 26;
    const mcolor = r.tone === "star" ? (g.accentInk ?? g.accent) : (g.accent2Ink ?? g.accent2);
    nodes.push(text(mx, r.y + headY + Math.round((headSize * 1.2 - msize * 1.2) / 2), mw, Math.round(msize * 1.2), `${r.min} min`, t.numeral(msize, { align: "right", color: mcolor })));
  });

  nodes.push(...note(K, g, c.note));
  return { page: { name: "Run of show", bg: g.bg, nodes }, fill };
}

const signature = { runOfShow };

export default {
  id: "deck-event-proposal",
  title: "Event Proposal",
  base: "pulse",
  rank: 72,
  tags: [
    "event",
    "proposal",
    "planning",
    "budget"
  ],
  meta: {
    company: "Loop",
    deck: "Proposal: Loop Live 2027",
    kicker: "An invitation, with a budget",
    farewell: "The decision",
    art: {
      cover: "il-day35-firework",
      section: "il-day86-candle",
      picture: "la-conversation-illustration",
      closing: "il-day4-polariod"
    }
  },
  look: {
    display: "Bodoni Moda", dw: 800,
    body: "Jost", bw: 400,
    mono: null,
    accentFace: "Parisienne", accentWeight: 400, accentSize: 46,
    charWidth: 0.52,
    // A dark deck: the paper is the midnight of the deep pages, one shade
    // lighter. The base's lime and its lime accentInk are cleared by the
    // new accent; pink text takes a lighter pink so it reads on the night.
    paper: { bg: "#1B2154", ink: "#FBF5EA", muted: "#BCBFDA", line: "#333B7E", panel: "#242B68", panel2: "#2D3576", accent: "#FF3D9E", accent2: "#EACB8A", accentInk: "#FF6DB6", accent2Ink: "#EACB8A" },
    deep: { bg: "#131843", bg2: "#070A24", ink: "#FBF5EA", muted: "#B9BCD6", line: "#2A3170", panel: "#1C2360", panel2: "#252D6E", accent: "#FF3D9E", accent2: "#EACB8A", accentInk: "#FF6DB6", accent2Ink: "#EACB8A" },
    radius: 0,
    ornament: "watermark",
    watermark: "27",
    peeps: ["op-peep-89", "op-peep-46", "op-peep-96", "op-peep-11", "op-peep-102"],
    scale: { cover: 112, title: 58, section: 236, statement: 78, numeral: 96, quote: 54 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "Loop Live:\none day, one room",
        subtitle: "What it is and who it is for, the day itself, the budget and the break-even line, and what we need approved today.",
        presenter: "Mei Lin, Marketing  ·  November 2026",
        chips: [
          ["400", "seats"],
          ["13 May", "2027"],
          ["$380K", "all in"]
        ],
        note: "the venue holds the date until Friday"
      }
    ],
    [
      "statement",
      {
        text: "Our customers have never been in one room. Four hundred finance leaders, one day, and the 2027 plan announced from the stage.",
        source: "Why now: the moment this event captures",
        note: "they keep asking when we will do this"
      }
    ],
    [
      "textPicture",
      {
        eyebrow: "The room",
        title: "Four hundred seats, three kinds of guest",
        points: [
          [
            "Customers, two hundred and forty",
            "Finance leaders at the accounts that renew in 2027. They hear the plan first, from the stage."
          ],
          [
            "Prospects, one hundred",
            "Late-stage deals, invited as a guest of their rep and seated with a customer in their industry."
          ],
          [
            "Partners and press, sixty",
            "Four sponsors, the analysts who cover us, and the two writers who asked to come."
          ]
        ],
        art: "la-conversation-illustration",
        note: "every prospect sits next to a customer"
      }
    ],
    [
      "quote",
      {
        text: "Put four hundred of us in one room\nand I will bring my CFO, my board pack\nand every question I have been saving.",
        name: "Sofia Marchetti",
        role: "Group Finance Director, Harbor and Vale. Customer advisory board",
        note: "unprompted, at the advisory board"
      }
    ],
    [
      "facts",
      {
        eyebrow: "The venue",
        title: "The Glasshouse, on the river",
        intro: "A glass hall on the river, twenty minutes from the airport, with a terrace that faces west. Held for us until Friday.",
        items: [
          [
            "map-pin",
            "Twenty minutes from the airport",
            "Shuttles every fifteen minutes, both ways"
          ],
          [
            "ticket",
            "A hall that seats four hundred",
            "Cabaret tables, one stage, one screen"
          ],
          [
            "home",
            "Three rooms for the workshops",
            "Forty seats each, on the floor above"
          ],
          [
            "sun",
            "The terrace, facing west",
            "Drinks from five, the band at six, sunset at half past eight"
          ]
        ],
        art: "il-day54-building",
        note: "the terrace is why we picked it"
      }
    ],
    [
      "raw",
      {
        build: signature.runOfShow,
        ...SHOW
      }
    ],
    [
      "figures",
      {
        eyebrow: "Budget",
        title: "Costs, sponsorships, and the break-even line",
        stats: [
          [
            "$380K",
            "Total cost",
            "Venue and stage",
            "Fixed once the venue signs; every other line has a cap."
          ],
          [
            "$160K",
            "Sponsorships",
            "Four partners",
            "Two confirmed in principle, two in conversation."
          ],
          [
            "$120K",
            "Ticket revenue",
            "400 at $300",
            "Customers pay; prospects come as guests of their rep."
          ],
          [
            "$100K",
            "Net cost",
            "Twelve deals",
            "Twelve enterprise deals sourced at the event pays for it."
          ]
        ],
        note: "nine deals came out of one dinner"
      }
    ],
    [
      "team",
      {
        eyebrow: "The team",
        title: "Who runs what",
        people: [
          [
            "Mei Lin",
            "Event lead",
            "Programme, stage, and the run of show."
          ],
          [
            "Jonah Park",
            "Sponsors and sales",
            "Partners on the floor and every prospect's rep in the room."
          ],
          [
            "Aisha Bello",
            "Experience",
            "Registration, the product wall, workshops and the terrace."
          ],
          [
            "Priya Raman",
            "The keynote",
            "The plan, the launch, and the two customers on stage."
          ]
        ],
        note: "all four have run one of these before"
      }
    ],
    [
      "closing",
      {
        title: "One yes, by Friday",
        subtitle: "Approve the venue deposit and the $380K budget today; the venue holds the date until Friday.",
        rows: [
          [
            "mail",
            "mei@loop.example"
          ],
          [
            "file-text",
            "Full budget and venue proposal attached"
          ],
          [
            "calendar",
            "Venue hold expires: Friday"
          ]
        ],
        cta: "Approve the budget",
        art: "il-day4-polariod",
        note: "a yes today, invitations Monday"
      }
    ]
  ]
};
