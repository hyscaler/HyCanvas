// Employee Onboarding: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: a welcome card. Cream paper with a sunflower accent and a teal
// second, a deep teal ground with a pale sunflower for accent text, floating
// discs in the two colours as the ornament, a rounded display face, a plain
// friendly body face and a clean handwriting for the kicker and the notes.
// The signature is the first-week map: five weekdays as five columns, each
// a station on a dotted trail, with the day's stops (a meeting, a reading,
// a task) as small cards under it, tinted by kind.

import { text, rect, ellipse, icon, chrome, note, card, type, mixHex, inkOn, M, W } from "../lib/deck-kit.mjs";

// --- the first-week map ------------------------------------------------------

const COL_W = 326, COL_GAP = 24, STOP_H = 118, STOP_GAP = 16;
/** Where each day's station sits on the trail: a gentle wave. */
const STATION_Y = [304, 334, 300, 338, 308];

/** The week: day name, its stops as [icon, kind, when, label], and for a
 *  lighter day a hand note for the slot it leaves free. */
const DAYS = [
  ["Monday", [
    ["map-pin", "task", "09:00", "Badge, laptop, desk"],
    ["message", "meeting", "10:30", "Coffee with your buddy"],
    ["book", "reading", "after lunch", "The whole welcome page"],
  ]],
  ["Tuesday", [
    ["user", "meeting", "09:30", "Team standup, every day"],
    ["book", "reading", "20 min", "How we make money"],
    ["settings", "task", "an hour", "Slack, the wiki, the tracker"],
  ]],
  ["Wednesday", [
    ["presentation", "meeting", "15:00", "The Wednesday demo"],
    ["book", "reading", "30 min", "Last quarter's retro notes"],
  ], "free afternoon, go wander"],
  ["Thursday", [
    ["user", "meeting", "11:00", "Your manager, one to one"],
    ["search", "reading", "an hour", "The product, end to end"],
    ["message", "task", "2 min", "Say hello in #welcome"],
  ]],
  ["Friday", [
    ["user", "meeting", "16:00", "Friday retro, just listen"],
    ["pencil", "task", "15 min", "Write down three questions"],
  ], "leave at four, we mean it"],
];

const KINDS = { meeting: "Meeting", reading: "Reading", task: "Task" };

/** Dots at even spacing along a wave through the points: the trail. */
function trailDots(pts, step = 17) {
  const out = [];
  let acc = 0, last = null;
  for (let s = 0; s < pts.length - 1; s++) {
    const [x0, y0] = pts[s], [x1, y1] = pts[s + 1];
    const n = Math.max(8, Math.round((x1 - x0) / 2));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * (1 - Math.cos(Math.PI * t)) / 2;
      if (last) acc += Math.hypot(x - last[0], y - last[1]);
      if (!last || acc >= step) { out.push([x, y]); acc = 0; }
      last = [x, y];
    }
  }
  return out;
}

const signature = {
  /** The first-week map: a dotted trail from a start flag to a finish, five
   *  numbered stations on it, one per weekday, and under each station the
   *  day's stops as small cards, tinted by kind. */
  weekMap(K, i, c) {
    const g = K.paper;
    const t = type(K, g);
    const { nodes } = chrome(K, g, i, c.eyebrow ?? "Your first week", c.title ?? "Five days, thirteen stops");
    const fill = [];
    // Kind: the fill of its dot and disc tint, and the ink of its icon and label.
    const tone = {
      meeting: { fill: g.accent2, ink: g.accent2Ink ?? g.accent2, tint: mixHex(g.panel, g.accent2, 0.2) },
      reading: { fill: g.accent, ink: g.accentInk ?? g.accent, tint: mixHex(g.panel, g.accent, 0.24) },
      task: { fill: g.ink, ink: g.ink, tint: mixHex(g.panel, g.ink, 0.1) },
    };
    const days = c.days ?? DAYS;
    const cx = days.map((_, k) => M + k * (COL_W + COL_GAP) + COL_W / 2);
    // The trail: start flag, the stations, the finish.
    const trail = [[M + 54, 320], ...cx.map((x, k) => [x, STATION_Y[k]]), [W - M - 54, 320]];
    for (const [x, y] of trailDots(trail)) nodes.push(ellipse(Math.round(x - 3), Math.round(y - 3), 6, 6, g.accent2, { opacity: 0.55 }));
    nodes.push(icon("flag", M, 302, 36, g.accentInk ?? g.accent));
    nodes.push(text(M, 346, 200, 30, "start here", t.kicker({ align: "left", size: 22 })));
    nodes.push(icon("confetti", W - M - 36, 302, 36, g.accentInk ?? g.accent));
    nodes.push(text(W - M - 240, 346, 240, 30, "week one, done", t.kicker({ align: "right", size: 22 })));
    days.forEach(([day, stops, free], k) => {
      const x = M + k * (COL_W + COL_GAP);
      const sy = STATION_Y[k];
      // The station: a numbered disc on the trail, the day under it.
      nodes.push(ellipse(cx[k] - 26, sy - 26, 52, 52, g.accent));
      nodes.push(text(cx[k] - 26, sy - 26, 52, 52, String(k + 1), { family: K.display, size: 24, weight: K.dw, color: inkOn(K, g.accent), align: "center", vAlign: "middle", lineHeight: 1 }));
      nodes.push(text(x, 376, COL_W, 36, day, t.display(28, { align: "center" })));
      stops.forEach(([ic, kind, when, label], j) => {
        const y = 428 + j * (STOP_H + STOP_GAP);
        const tn = tone[kind] ?? tone.task;
        nodes.push(card(K, g, x, y, COL_W, STOP_H));
        nodes.push(ellipse(x + 16, y + 22, 44, 44, tn.tint));
        nodes.push(icon(ic, x + 27, y + 33, 22, tn.ink));
        nodes.push(text(x + 74, y + 20, COL_W - 90, 22, `${KINDS[kind] ?? kind}  ·  ${when}`, t.eyebrow({ size: 13, letterSpacing: 2, color: tn.ink })));
        nodes.push(text(x + 74, y + 46, COL_W - 90, 56, label, t.strong(20)));
        fill.push({ node: nodes.length - 1, label: `${day}, stop ${j + 1}`, hint: "One short line: what, or who" });
      });
      // A lighter day says so in the hand, where its third stop would be.
      if (free) {
        const y = 428 + stops.length * (STOP_H + STOP_GAP);
        nodes.push(text(x + 12, y + 30, COL_W - 24, 64, free, t.kicker({ align: "center", size: 24, lineHeight: 1.15 })));
      }
    });
    // The legend: what the tints mean.
    const ly = 428 + 3 * (STOP_H + STOP_GAP) + 26;
    Object.entries(KINDS).forEach(([kind, label], k) => {
      const x = M + k * 170;
      nodes.push(ellipse(x, ly + 6, 14, 14, tone[kind].fill));
      nodes.push(text(x + 26, ly, 140, 26, label, t.body(17)));
    });
    nodes.push(...note(K, g, c.note));
    return { page: { name: "First week", bg: g.bg, nodes }, fill };
  },
};

export default {
  id: "deck-onboarding",
  title: "Employee Onboarding",
  base: "terra",
  rank: 82,
  tags: [
    "onboarding",
    "hr",
    "new hire",
    "welcome"
  ],
  meta: {
    company: "Fernwood",
    deck: "Welcome aboard",
    kicker: "We are glad you are here",
    farewell: "That is the tour",
    art: {
      cover: "il-day31-sweet-home",
      section: "il-109-map-location",
      picture: "il-day62-office-bag",
      closing: "la-hero-image-2"
    }
  },
  look: {
    display: "Fredoka", dw: 600,
    body: "Karla", bw: 400,
    mono: null,
    accentFace: "Patrick Hand", accentWeight: 400, accentSize: 40,
    charWidth: 0.58,
    paper: { bg: "#FFF8E8", ink: "#1E2E33", muted: "#5A6A6F", line: "#EAD9BC", panel: "#FFF1D6", panel2: "#FBE6BF", accent: "#F4B41A", accentInk: "#85580A", accent2: "#1F8A87", accent2Ink: "#16706E", sun: "#F4B41A" },
    deep: { bg: "#146362", bg2: "#0B3F3E", ink: "#FFF8E8", muted: "#C6E4DF", line: "#2A7E7C", panel: "#1B6E6C", panel2: "#227977", accent: "#FFC53D", accentInk: "#FFD970", accent2: "#9FE1D8", accent2Ink: "#C9F0EA", sun: "#FFC53D" },
    radius: 20,
    ornament: "orbs",
    // Four for the team page; index 4 is the quote's.
    peeps: ["op-peep-11", "op-peep-90", "op-peep-46", "op-peep-96", "op-peep-102"],
    scale: { cover: 116, title: 60, section: 236, statement: 80, numeral: 104, quote: 54 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "Welcome to\nFernwood",
        subtitle: "Who we are, how we work, your first thirty days, the people to meet, and where to ask anything.",
        presenter: "Your first week, with the People team  ·  November 2026",
        note: "no homework before day one"
      }
    ],
    [
      "threeCards",
      {
        eyebrow: "Who we are",
        title: "The mission, and the money",
        cards: [
          [
            "heart",
            "The mission",
            "Every community organisation should run on tools as good as any company's. We build them, and we keep them affordable."
          ],
          [
            "coin",
            "How we make money",
            "Subscriptions from organisations over fifty people. Everything under that is free, and always will be."
          ],
          [
            "world",
            "Where we are",
            "One hundred and twelve people in three offices and eleven countries. Most of us work from home two days a week."
          ]
        ],
        note: "the free tier is the point, not the funnel"
      }
    ],
    [
      "columns",
      {
        eyebrow: "How we work",
        title: "Rituals, tools, rules",
        intro: "Three rituals, three tools, three rules.",
        cols: [
          [
            "Rituals",
            "The shape of a week",
            [
              ["Monday plan", "Thirty minutes, the whole team, what matters this week."],
              ["Wednesday demo", "Anyone shows anything that shipped. Fifteen minutes, no slides."],
              ["Friday retro", "What went well, what did not, one thing to change."]
            ]
          ],
          [
            "Tools",
            "Three, and only three",
            [
              ["Slack for talk", "Public channels by default. DMs for the personal stuff."],
              ["The wiki for decisions", "If it is not written down there, it was not decided."],
              ["The tracker for work", "Every task has an owner and a week. Nothing lives in a chat."]
            ]
          ],
          [
            "Unwritten rules",
            "Now written down",
            [
              ["Ask in public", "Someone else has the same question. Channels, not DMs."],
              ["Disagree in the doc", "Comments first, then the meeting decides, then we commit."],
              ["Thank people by name", "In the channel, in the retro, in the all-hands."]
            ]
          ]
        ],
        note: "not written down? ask, then write it down"
      }
    ],
    [
      "section",
      {
        n: "",
        title: "Your first\nthirty days",
        blurb: "A week to look around, a week to shadow, a week to own something small, and a chat about what comes next.",
        kicker: "No deliverables in week one",
        art: "il-109-map-location",
        note: "a guide, not a test"
      }
    ],
    [
      "facts",
      {
        eyebrow: "Day one",
        title: "Monday, in practice",
        intro: "Nothing to prepare. Turn up at nine with your ID, and we take it from there.",
        items: [
          ["map-pin", "Reception, level 1, at nine", "Your badge and your buddy are waiting"],
          ["device-desktop", "A laptop, already set up", "Sign in with the email we sent last week"],
          ["home", "Your desk is on level 2", "By the window, with your team"],
          ["chef-hat", "Lunch at half twelve, all of us", "The long table by the kitchen"]
        ],
        art: "il-day62-office-bag"
      }
    ],
    [
      "raw",
      {
        build: signature.weekMap,
        eyebrow: "Your first week",
        title: "Five days, thirteen stops",
        note: "thirteen stops, no deliverables, lots of questions"
      }
    ],
    [
      "timeline",
      {
        eyebrow: "Week by week",
        title: "Look, shadow, own, reflect",
        done: 0,
        steps: [
          [
            "Week 1",
            "Meet and read",
            "Your buddy, your team, your manager. The wiki's welcome page, end to end. No deliverables."
          ],
          [
            "Week 2",
            "Shadow",
            "Sit with support for a day and with a customer call. Ship one small change, with help."
          ],
          [
            "Week 3",
            "Own something small",
            "A ticket, a doc, a customer question. Yours start to finish."
          ],
          [
            "Week 4",
            "Reflect",
            "A thirty-minute chat with your manager: what surprised you, what is unclear, what you want next."
          ]
        ],
        note: "week four is a chat, not a review"
      }
    ],
    [
      "team",
      {
        eyebrow: "The people to meet",
        title: "Your map of the org",
        people: [
          [
            "Elena Sato",
            "Chief Executive",
            "Books a coffee with every new hire in the first month. Take her up on it."
          ],
          [
            "Dana Whitfield",
            "People",
            "Your first stop for anything about pay, leave, equipment or how things work."
          ],
          [
            "Tomas Reyes",
            "Engineering",
            "Runs the Wednesday demo. Ask him for the architecture tour."
          ],
          [
            "Aisha Bello",
            "Support",
            "Knows what customers actually ask. Shadow her team in week two."
          ]
        ],
        note: "all four have already said yes to a coffee"
      }
    ],
    [
      "closing",
      {
        title: "Ask anything",
        subtitle: "No silly questions in your first month, and very few after that. Your buddy, the People channel, or anyone in the kitchen.",
        rows: [
          [
            "message",
            "#welcome on Slack"
          ],
          [
            "mail",
            "people@fernwood.example"
          ],
          [
            "calendar",
            "Your week-four chat is already booked"
          ]
        ],
        cta: "Open the welcome page",
        art: "la-hero-image-2",
        note: "the kitchen counts as a channel"
      }
    ]
  ]
};
