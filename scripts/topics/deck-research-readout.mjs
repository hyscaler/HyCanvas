// Research Readout: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: warm grey and oxblood on paper white for reading, a deep oxblood
// gradient for the cover, the participant quote and the closing. A Caslon
// for the display, a humanist sans for the body, a typewriter mono for the
// eyebrows, the footer and every participant code, and a pen hand for the
// notes. The ornament is the watermark, and the glyph is the sample size.
// The signature slide is the evidence wall: one chip per session, each
// carrying the three findings as filled or empty squares, with the three
// findings and their counts as the legend beneath.

import { text, rect, icon, chrome, card, type, note, inkOn, mixHex, M, CW } from "../lib/deck-kit.mjs";

/** The fourteen sessions in the order they ran: code, company size, date. */
const SESSIONS = [
  ["P01", 140, "6 Oct"], ["P02", 520, "6 Oct"], ["P03", 60, "7 Oct"], ["P04", 340, "7 Oct"],
  ["P05", 85, "8 Oct"], ["P06", 900, "9 Oct"], ["P07", 210, "9 Oct"], ["P08", 120, "10 Oct"],
  ["P09", 640, "13 Oct"], ["P10", 180, "13 Oct"], ["P11", 260, "14 Oct"], ["P12", 410, "15 Oct"],
  ["P13", 240, "16 Oct"], ["P14", 780, "17 Oct"],
];
const LARGE = 300;
/** The three who had read the welcome email before their session. */
const READ_EMAIL = new Set(["P03", "P08", "P12"]);
/** Which sessions showed each finding. */
const SUPPORT = [
  new Set(SESSIONS.map(([c]) => c).filter((c) => !READ_EMAIL.has(c))),
  new Set(["P01", "P02", "P04", "P05", "P07", "P09", "P10", "P13", "P14"]),
  new Set(SESSIONS.filter(([, n]) => n >= LARGE).map(([c]) => c)),
];
const FINDINGS = [
  ["Nobody knew what the first step was", "Every session where the participant had not read the welcome email."],
  ["They wanted the report before the setup", "Asked to see it before connecting anything, most of them unprompted."],
  ["Large teams wanted a colleague first", "All six large teams. The invite mattered more than the import."],
];

/** The evidence wall: fourteen chips in two rows of seven, one per session
 *  in the order they ran, each with its code in the mono, the company size,
 *  three squares for the three findings (filled in the finding's colour
 *  when the session showed it) and the date; an envelope on the three who
 *  had read the welcome email. Under the wall, the three findings as a
 *  legend with their counts. */
function evidenceWall(K, i) {
  const g = K.paper;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, "The evidence", "Fourteen sessions, three findings");
  const tones = [g.accent, g.accent2Ink ?? g.accent2, g.sun];
  const cols = 7, gap = 16, cw = Math.floor((CW - (cols - 1) * gap) / cols), ch = 196;
  const y0 = bodyTop + 8;
  SESSIONS.forEach(([code, size, date], k) => {
    const x = M + (k % cols) * (cw + gap), y = y0 + Math.floor(k / cols) * (ch + gap);
    const large = size >= LARGE;
    nodes.push(card(K, g, x, y, cw, ch));
    nodes.push(text(x + 24, y + 20, 120, 34, code, { family: K.mono, size: 26, weight: 700, color: g.ink, lineHeight: 1.2 }));
    nodes.push(text(x + 24, y + 28, cw - 48, 20, large ? "Large team" : "Small team", t.eyebrow({ size: 12, letterSpacing: 2, align: "right", color: large ? g.accentInk ?? g.accent : g.muted })));
    nodes.push(text(x + 24, y + 60, cw - 48, 24, `${size} people`, t.meta({ size: 16 })));
    tones.forEach((tone, f) => {
      const sx = x + 24 + f * 56, sy = y + 100;
      if (SUPPORT[f].has(code)) {
        nodes.push(rect(sx, sy, 44, 44, tone, { radius: 4 }));
        nodes.push(text(sx, sy, 44, 44, String(f + 1), { family: K.display, size: 19, weight: K.dw, color: inkOn(K, tone), align: "center", vAlign: "middle", lineHeight: 1 }));
      } else {
        nodes.push(rect(sx, sy, 44, 44, g.bg, { radius: 4, stroke: g.line, strokeWidth: 1.5 }));
        nodes.push(text(sx, sy, 44, 44, String(f + 1), { family: K.display, size: 19, weight: K.dw, color: mixHex(g.bg, g.muted, 0.45), align: "center", vAlign: "middle", lineHeight: 1 }));
      }
    });
    nodes.push(text(x + 24, y + 160, 120, 22, date, t.meta({ size: 14 })));
    if (READ_EMAIL.has(code)) nodes.push(icon("mail", x + cw - 24 - 18, y + 160, 18, g.muted));
  });
  const wallBottom = y0 + 2 * ch + gap;
  nodes.push(text(M, wallBottom + 8, CW, 26, "One chip per session, in the order we ran them. A filled square means the session showed that finding; the envelope marks the three who had read the welcome email.", t.meta({ size: 16 })));

  // The legend: the three findings, their colour, and how many of fourteen.
  const ly = wallBottom + 46, lh = 160, lw = (CW - 48) / 3;
  FINDINGS.forEach(([head, sub], f) => {
    const x = M + f * (lw + 24), tone = tones[f], n = SUPPORT[f].size;
    nodes.push(card(K, g, x, ly, lw, lh));
    nodes.push(rect(x, ly, lw, 6, tone, { radius: 0 }));
    nodes.push(rect(x + 28, ly + 34, 40, 40, tone, { radius: 4 }));
    nodes.push(text(x + 28, ly + 34, 40, 40, String(f + 1), { family: K.display, size: 18, weight: K.dw, color: inkOn(K, tone), align: "center", vAlign: "middle", lineHeight: 1 }));
    nodes.push(text(x + 88, ly + 28, lw - 88 - 28 - 150, 60, head, t.strong(21)));
    nodes.push(text(x + lw - 28 - 140, ly + 22, 140, 72, String(n), t.display(64, { align: "right", color: f === 2 ? g.ink : tone })));
    nodes.push(text(x + lw - 28 - 140, ly + 94, 140, 24, "of fourteen", t.meta({ size: 15, align: "right" })));
    nodes.push(text(x + 28, ly + 100, lw - 56 - 150, 50, sub, t.body(17)));
  });
  nodes.push(...note(K, g, "P06 is the session to watch, ask for the clip"));
  return { page: { name: "Evidence wall", bg: g.bg, nodes }, fill: [] };
}

const signature = { evidenceWall };

export default {
  id: "deck-research-readout",
  title: "Research Readout",
  base: "folio",
  rank: 40,
  tags: [
    "research",
    "ux",
    "findings",
    "readout"
  ],
  styleTags: ["calm", "editorial", "scholarly"],
  meta: {
    company: "Meridian Studio",
    deck: "Research readout: onboarding",
    kicker: "Evidence first",
    farewell: "That is the evidence",
    art: {
      cover: "la-conversation-illustration",
      section: "il-day46-experiment-lab",
      picture: "il-day94-ui-ux",
      closing: "la-cassette"
    }
  },
  look: {
    display: "Libre Caslon Text", dw: 700,
    body: "Alegreya Sans", bw: 400,
    mono: "Courier Prime",
    accentFace: "Nothing You Could Do", accentWeight: 400, accentSize: 40,
    paper: { bg: "#F8F6F1", ink: "#2B2724", muted: "#6A635C", line: "#DAD4CB", panel: "#F0ECE5", panel2: "#E6E0D7", accent: "#7A1F2B", accent2: "#857A70", accent2Ink: "#5F564E", sun: "#B8862B" },
    deep: { bg: "#5F1B25", bg2: "#3A0F16", ink: "#F8F6F1", muted: "#D8C2C3", line: "#7B3841", panel: "#6C2531", panel2: "#78303B", accent: "#E8C9A6", accent2: "#CFC3B8", sun: "#E1B25C" },
    radius: 6,
    ornament: "watermark",
    watermark: "14",
    peeps: ["op-peep-19", "op-peep-44", "op-peep-70", "op-peep-97", "op-peep-33"],
    scale: { cover: 112, title: 60, section: 236, statement: 80, numeral: 100, quote: 52 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "What we studied,\nand what we found",
        subtitle: "Fourteen new customers, watched through their first week. What we saw, how sure we are, and what to change first.",
        presenter: "Aisha Bello, Research lead  ·  24 October 2026",
        presenterName: "Aisha Bello",
        when: "24 October 2026",
        where: "Studio, level 2",
        chips: [["14", "sessions"], ["45 min", "each"], ["3", "findings"]],
        art: "la-conversation-illustration",
        note: "every claim here has a clip behind it"
      }
    ],
    [
      "threeCards",
      {
        eyebrow: "The study",
        title: "The question, the method, the participants",
        cards: [
          [
            "search",
            "The question",
            "Why do half of new accounts need a support call before their first report?"
          ],
          [
            "eye",
            "The method",
            "Fourteen moderated sessions, forty-five minutes each, on the participant's own data. Recorded and coded."
          ],
          [
            "user",
            "The participants",
            "Operations leads at companies of 60 to 900 people, six weeks or less into the product."
          ]
        ],
        note: "the question came from support, not from us"
      }
    ],
    ["raw", { build: signature.evidenceWall }],
    [
      "textPicture",
      {
        eyebrow: "Finding one",
        title: "Nobody knew what the first step was",
        points: [
          [
            "What we observed",
            "Eleven of fourteen opened the integrations page, scrolled, and closed it. The grid of forty logos read as a decision, not a step."
          ],
          [
            "What it means for the product",
            "One source, chosen for them, with the others hidden until the first import succeeds."
          ],
          [
            "Confidence",
            "High. It happened in every session where the participant had not read the welcome email."
          ]
        ],
        art: "il-day94-ui-ux",
        note: "we counted: forty logos, zero clicks"
      }
    ],
    [
      "twoColumns",
      {
        eyebrow: "Finding two",
        title: "The surprise: proof before setup",
        left: {
          eyebrow: "What we assumed",
          head: "Careful configuration, then the report",
          lines: [
            "Connect sources and map fields, then see the report.",
            "The wizard was built for careful configuration.",
            "Forty-one percent of accounts finish it."
          ],
          icon: "settings"
        },
        right: {
          eyebrow: "What they wanted",
          head: "Proof first, setup after",
          lines: [
            "Nine of fourteen asked to see the report first.",
            "Most asked unprompted, before the intro was over.",
            "Confidence high: support transcripts agree."
          ],
          icon: "eye"
        },
        note: "nine asked before we had finished the intro"
      }
    ],
    [
      "quote",
      {
        pageName: "Participant",
        text: "Can I just see what it looks like first? I will connect everything after, I promise.",
        name: "P07, operations lead at a 210-person company",
        role: "Session seven, eleven minutes in"
      }
    ],
    [
      "textPicture",
      {
        eyebrow: "Finding three",
        title: "The pattern across segments",
        points: [
          [
            "Small teams",
            "Wanted a sample report immediately and forgave rough edges."
          ],
          [
            "Large teams",
            "Wanted a colleague in the room before committing; the invite step mattered more than the import."
          ],
          [
            "Confidence",
            "Medium. Six of the fourteen were large teams, which is a thin base for the second half."
          ]
        ],
        art: "la-flat-character-illustrations",
        note: "six large teams is a thin base, so we say so"
      }
    ],
    [
      "figures",
      {
        eyebrow: "What the numbers say",
        title: "The quantitative backdrop",
        stats: [
          [
            "11 days",
            "Median time to first report",
            "All new accounts",
            "From the product analytics, last quarter."
          ],
          [
            "52%",
            "Accounts needing a call",
            "Before the first report",
            "Support tickets tagged onboarding, last quarter."
          ],
          [
            "41%",
            "Wizard completion",
            "Current flow",
            "Of accounts that started the setup wizard."
          ],
          [
            "78%",
            "Preview-first completion",
            "Prototype test",
            "Of the fourteen participants, on the preview-first prototype."
          ]
        ],
        note: "the 78% is fourteen people, not a launch"
      }
    ],
    [
      "process",
      {
        eyebrow: "Recommendations",
        title: "Three changes, ranked by confidence and effort",
        steps: [
          [
            "Preview first",
            "Show the first report before any setup. High confidence, medium effort. Ship first."
          ],
          [
            "One source at a time",
            "Hide the integrations grid until the first import works. High confidence, low effort."
          ],
          [
            "Invite from the preview",
            "Let large teams bring a colleague onto the report itself. Medium confidence, low effort."
          ],
          [
            "Re-test",
            "Fourteen more sessions on the new flow in December, same method, before the general release."
          ]
        ],
        note: "confidence first, effort second, always"
      }
    ],
    [
      "closing",
      {
        title: "Questions",
        subtitle: "Session recordings, the coded notes and the prototype are in the research folder. Ask for any clip.",
        rows: [
          [
            "mail",
            "aisha@meridian.example"
          ],
          [
            "world",
            "research.meridian.example/onboarding"
          ],
          [
            "calendar",
            "Re-test: December"
          ]
        ],
        cta: "Open the findings",
        art: "la-cassette",
        note: "every clip is cut and named, just ask"
      }
    ]
  ]
};
