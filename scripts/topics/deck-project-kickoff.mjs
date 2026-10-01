// Project Kickoff: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: a construction site, clear and aligned. Safety orange and steel
// blue on a light concrete grey, a dark steel gradient for the deep pages, a
// sturdy grotesque for the titles, a hyperlegible sans for the reading, a
// road-sign mono for every label, and a marker hand for the kicker and the
// notes, the way a foreman writes on a board. The ornament is the inset rule
// of a site signboard. The signature slide is the responsibility grid: five
// workstreams as rows, four roles as columns, a filled disc where a role
// owns, a ring where it is consulted, nothing where it is not.

import { text, rect, ellipse, photo, art, type, chrome, note, mixHex, M, CW } from "../lib/deck-kit.mjs";

// --- the responsibility grid -------------------------------------------------

/** The four roles, one column each, a portrait on every header. */
const ROLES = [
  ["Marcus Obi", "Project lead"],
  ["Tomas Lind", "Engineering"],
  ["Aisha Rahman", "Design"],
  ["Elena Sato", "Customers"],
];

/** The five workstreams, one row each: the name, who outside the team is in
 *  the room, and a cell per role ("o" owns and decides, "c" is consulted
 *  first, "" is not involved). Exactly one "o" per row. */
const ROWS = [
  ["Scope and priorities", "Finance and Sales weigh in", ["o", "c", "", "c"]],
  ["Metering and the ledger", "Platform reviews the design", ["c", "o", "", ""]],
  ["Invoice design", "Finance and Support see every draft", ["", "c", "o", "c"]],
  ["Customer migration", "Sales calls each pilot customer", ["c", "c", "", "o"]],
  ["Launch go or no-go", "Finance signs the runbook first", ["o", "c", "c", "c"]],
];

const signature = {
  /** The grid: a label column of numbered workstreams, four role columns
   *  headed by a portrait, name and role, and in every cell a filled disc
   *  (owns), a ring (consulted) or nothing. Alternate rows are banded, the
   *  header rule is the steel blue, and a legend under the grid says what
   *  the marks mean. The room reads the discs in a second: one per row. */
  grid(K, i, c) {
    const g = K.paper;
    const t = type(K, g);
    const mono = K.mono ?? K.body;
    const title = c.title ?? "Five workstreams, four roles";
    const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow ?? "Who does what", title);
    const fill = [{ node: nodes.findIndex((n) => n.text === title), label: "Title", hint: "The grid in one line" }];
    const illustrations = [];
    const roles = c.roles ?? ROLES;
    const rows = c.rows ?? ROWS;
    const peeps = c.peeps ?? K.peeps;

    const labelW = 520;
    const gx = M + labelW;
    const colW = (CW - labelW) / roles.length;
    const headY = bodyTop;
    const headH = 84;
    const rowY0 = headY + headH + 12;
    const rowH = 94;
    const gridBottom = rowY0 + rows.length * rowH;

    // The header: the label column's own eyebrow, then a portrait, a name
    // and a role per column. Portrait circles are photo slots.
    nodes.push(text(M, headY + 32, labelW - 40, 24, "Workstream", t.eyebrow({ size: 15, letterSpacing: 3 })));
    roles.forEach(([name, role], k) => {
      const x = gx + k * colW;
      const px = x + 20, py = headY + 12;
      nodes.push(photo(px, py, 60, 60, mixHex(g.panel, k % 2 ? g.accent2 : g.accent, 0.22), { shape: "ellipse" }));
      illustrations.push(art(peeps[k % peeps.length], px + 8, py + 6, 44, 48));
      nodes.push(text(x + 96, headY + 14, colW - 108, 28, name, t.strong(21)));
      fill.push({ node: nodes.length - 1, label: `Role ${k + 1}`, hint: "Who holds the role" });
      nodes.push(text(x + 96, headY + 46, colW - 108, 22, role, t.eyebrow({ size: 14, letterSpacing: 3 })));
    });
    nodes.push(rect(M, headY + headH, CW, 3, g.accent2));

    // The rows: a numbered label, the outside parties in the room, and the
    // marks. Odd rows sit on a panel band; a ring takes the band's fill.
    rows.forEach(([name, sub, cells], r) => {
      const y = rowY0 + r * rowH;
      const band = r % 2 === 1;
      if (band) nodes.push(rect(M, y, CW, rowH, g.panel));
      nodes.push(text(M, y + 20, 40, 24, String(r + 1).padStart(2, "0"), { family: mono, size: 16, weight: 600, color: g.accentInk ?? g.accent, lineHeight: 1.2 }));
      nodes.push(text(M + 52, y + 16, labelW - 84, 30, name, t.strong(22)));
      nodes.push(text(M + 52, y + 48, labelW - 84, 24, sub, t.meta({ size: 15 })));
      cells.forEach((v, k) => {
        const cx = Math.round(gx + k * colW + colW / 2);
        const cy = y + rowH / 2;
        if (v === "o") nodes.push(ellipse(cx - 16, cy - 16, 32, 32, g.accent));
        else if (v === "c") nodes.push(ellipse(cx - 16, cy - 16, 32, 32, band ? g.panel : g.bg, { stroke: g.accent2, strokeWidth: 3 }));
      });
      nodes.push(rect(M, y + rowH - 1, CW, 1, g.line));
    });
    // Column dividers, from the header down to the last row.
    for (let k = 0; k < roles.length; k++) {
      const x = Math.round(gx + k * colW);
      nodes.push(rect(x, headY, k === 0 ? 2 : 1, gridBottom - headY, k === 0 ? g.accent2 : g.line));
    }

    // The legend.
    const ly = gridBottom + 30;
    nodes.push(ellipse(M, ly + 3, 22, 22, g.accent));
    nodes.push(text(M + 34, ly, 220, 28, "owns and decides", t.body(18)));
    nodes.push(ellipse(M + 262, ly + 3, 22, 22, g.bg, { stroke: g.accent2, strokeWidth: 3 }));
    nodes.push(text(M + 296, ly, 220, 28, "consulted first", t.body(18)));
    nodes.push(text(M + 520, ly, 480, 28, "blank: not involved, and not copied in", t.body(18)));

    nodes.push(...note(K, g, c.note));
    return { page: { name: "Responsibility grid", bg: g.bg, nodes, illustrations }, fill };
  },
};

export default {
  id: "deck-project-kickoff",
  title: "Project Kickoff",
  base: "slate",
  rank: 34,
  tags: [
    "kickoff",
    "project",
    "planning",
    "team"
  ],
  meta: {
    company: "Form & Function",
    deck: "Kickoff: the billing rebuild",
    kicker: "kickoff, billing rebuild",
    farewell: "hard hats on",
    art: {
      cover: "il-day14-forklift",
      section: "il-day54-building",
      picture: "il-day36-abacus",
      closing: "il-day17-walkie-talkie"
    }
  },
  look: {
    display: "Chivo", dw: 800,
    body: "Atkinson Hyperlegible Next", bw: 400,
    mono: "Overpass Mono",
    accentFace: "Covered By Your Grace", accentWeight: 400, accentSize: 36,
    charWidth: 0.58,
    paper: { bg: "#EDEFF1", ink: "#1A2430", muted: "#55626F", line: "#CBD2D9", panel: "#E2E6EA", panel2: "#D5DBE1", accent: "#F26A1B", accent2: "#38658C", accentInk: "#A33C05" },
    deep: { bg: "#2B3B4A", bg2: "#16202A", ink: "#F1F3F5", muted: "#A7B3BE", line: "#40505F", panel: "#344656", panel2: "#3D5162", accent: "#FF7A2E", accent2: "#8DB9DC", accentInk: "#FFA062" },
    radius: 4,
    ornament: "rules",
    peeps: ["op-peep-2", "op-peep-16", "op-peep-19", "op-peep-54", "op-peep-89"],
    scale: { cover: 118, title: 62, section: 236, statement: 80, numeral: 104, quote: 54 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "What we are\nhired to build",
        subtitle: "Why this project, what done looks like and what we are not doing, the phases, who does what, and the risks we already see.",
        presenter: "Marcus Obi, Project Lead  ·  3 November 2026",
        chips: [
          [
            "16",
            "weeks"
          ],
          [
            "3",
            "phases"
          ],
          [
            "0.5%",
            "max errors"
          ]
        ],
        art: "il-day14-forklift",
        note: "read the non-goals twice"
      }
    ],
    [
      "textPicture",
      {
        eyebrow: "Why this project",
        title: "Three reasons we cannot wait",
        points: [
          [
            "Invoices are wrong 3% of the time",
            "Every error is a credit note, a support ticket and a finance correction. Customers notice before we do."
          ],
          [
            "Finance closes the month in nine days",
            "Most of it is reconciling usage by hand. Two days is the target, and the old engine cannot get there."
          ],
          [
            "Usage pricing needs a new engine",
            "Sales has three deals waiting on it. The engine bills seats, not usage, and patching it has failed twice."
          ]
        ],
        art: "il-day36-abacus",
        note: "three deals are waiting on this"
      }
    ],
    [
      "twoColumns",
      {
        eyebrow: "Goals and non-goals",
        title: "What done looks like",
        left: {
          eyebrow: "Goals",
          head: "Invoices that are right the first time",
          lines: [
            "Usage-based billing for every plan",
            "Invoice errors under 0.5%",
            "Finance closes the month in two days"
          ],
          icon: "circle-check"
        },
        right: {
          eyebrow: "Non-goals",
          head: "What we are explicitly not doing",
          lines: [
            "No new pricing tiers this project",
            "No migration of historical invoices",
            "No changes to the customer portal"
          ],
          icon: "circle"
        },
        note: "the non-goals are the contract"
      }
    ],
    [
      "section",
      {
        n: "",
        title: "The plan",
        blurb: "Three phases over sixteen weeks, one owner per workstream, and the three risks we are already working on.",
        kicker: "how we get there",
        art: "il-day54-building",
        note: "every phase ends in staging, not on a slide"
      }
    ],
    [
      "timeline",
      {
        eyebrow: "Scope and milestones",
        title: "Three phases to launch",
        done: 0,
        steps: [
          [
            "Phase one",
            "Foundations",
            "Usage metering, the ledger, and the first end-to-end invoice in staging. Six weeks."
          ],
          [
            "Phase two",
            "The visible wins",
            "Finance dashboard, the new invoice, and ten pilot customers on the new engine. Six weeks."
          ],
          [
            "Phase three",
            "Polish and launch",
            "Every customer migrated, the old engine retired, the runbook signed off. Four weeks."
          ],
          [
            "Review",
            "The retro",
            "What we would do differently, written down before the next project starts."
          ]
        ],
        note: "phase two is where finance first sees it"
      }
    ],
    [
      "raw",
      {
        build: signature.grid,
        eyebrow: "Who does what",
        title: "Five workstreams, four roles",
        note: "one filled disc per row, never two"
      }
    ],
    [
      "threeCards",
      {
        eyebrow: "Risks we already see",
        title: "Three risks, with mitigations",
        cards: [
          [
            "alert-triangle",
            "Usage data is wrong at the source",
            "Metering bugs become invoice errors. Mitigation: shadow-bill every customer for a month before cutover."
          ],
          [
            "clock",
            "Finance is busiest at month end",
            "Our launch week collides with their close. Mitigation: launch in the second week of the month, never the first."
          ],
          [
            "user",
            "One person knows the old engine",
            "If Priya is out, nobody can read it. Mitigation: two weeks of pairing in phase one, documented."
          ]
        ],
        note: "shadow billing starts in week three"
      }
    ],
    [
      "fourCards",
      {
        eyebrow: "How we work",
        title: "Four working agreements",
        cards: [
          [
            "clock",
            "Standup at 09:15, fifteen minutes",
            "Blockers first. Anything that takes longer than a minute moves to the channel."
          ],
          [
            "presentation",
            "Demo every other Friday",
            "Working software in staging, shown by whoever built it. Finance is invited to every one."
          ],
          [
            "message",
            "Decisions in the channel, within a day",
            "If it is not in #billing-rebuild, it was not decided. A day of silence means yes."
          ],
          [
            "clipboard",
            "The plan lives in one place",
            "One document, one owner, updated every Friday. Slides are copies of it, never the source."
          ]
        ],
        note: "if it is not in the channel, it did not happen"
      }
    ],
    [
      "closing",
      {
        title: "We start Monday",
        subtitle: "Phase one begins on 9 November. The plan, the grid and the risk log live in the project space; if it is not there, ask in the channel.",
        rows: [
          [
            "message",
            "#billing-rebuild on Slack"
          ],
          [
            "mail",
            "marcus@formfunction.example"
          ],
          [
            "calendar",
            "First demo: Friday 20 November"
          ]
        ],
        cta: "Open the project plan",
        art: "il-day17-walkie-talkie",
        note: "first demo is 20 November, bring finance"
      }
    ]
  ]
};
