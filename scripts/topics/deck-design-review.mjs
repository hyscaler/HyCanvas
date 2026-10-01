// Design Review: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: a critique wall. Pure white paper, near-black ink, one violet
// for everything that asks for attention, and a pencil grey for the second
// voice. A tight neutral grotesk for titles, a plain grotesk for reading, a
// mono for the eyebrows and labels the way a wall of printouts carries its
// ticket numbers, and a fine pen for the hand notes. A dot grid as the
// ornament: the canvas every screen was drawn on. Generous white space; the
// wall is for looking, not for decoration.

import { text, rect, ellipse, button, icon, path, type, chrome, note, mixHex, inkOn, M, CW } from "../lib/deck-kit.mjs";

// --- the signature slide -------------------------------------------------------

/** The flow strip: four screen frames in a row (a rounded window with a
 *  title bar, a wireframe of the screen inside), joined by short arrows,
 *  each with its name and a caption below and the one decision it embodies
 *  as a chip. The frames are picture slots: drop the real screens on them. */
const signature = {
  flow(K, i, c) {
    const g = K.paper;
    const t = type(K, g);
    const accentInk = g.accentInk ?? g.accent;
    const mono = K.mono ?? K.body;
    const TITLE = c.title ?? "The user's path, screen by screen";
    const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow ?? "The flow", TITLE);
    const fill = [];
    fill.push({ node: nodes.findIndex((n) => n.kind === "text" && n.text === TITLE), label: "Title", hint: "What the strip walks through" });

    const screens = c.screens;
    const n = screens.length;
    const fw = 348, gap = (CW - n * fw) / (n - 1);
    const fy = bodyTop + 40, fh = 300, barH = 34;
    const wire = mixHex(g.panel2, g.ink, 0.12);       // a wireframe line
    const wireSoft = g.panel2;                          // a softer one
    const tint = mixHex(g.panel, g.accent, 0.14);      // the selected state
    const chipFill = mixHex(g.panel, g.accent, 0.16);

    // The wireframe inside a screen, by the screen's role.
    const sketch = (kind, x, by) => {
      const out = [];
      const line = (lx, ly, lw, lh = 10, c = wire) => rect(lx, ly, lw, lh, c, { radius: lh / 2 });
      out.push(line(x + 28, by + 24, kind === "preview" ? 180 : 150, 12, wire));
      switch (kind) {
        case "connect": {
          // Three sources; the first chosen, the others waiting.
          [0, 1, 2].forEach((r) => {
            const y = by + 56 + r * 52;
            out.push(rect(x + 28, y, fw - 56, 44, r === 0 ? tint : g.panel, { radius: 8, stroke: r === 0 ? g.accent : g.line, strokeWidth: 1.5 }));
            out.push(ellipse(x + 44, y + 13, 18, 18, r === 0 ? g.accent : g.bg, r === 0 ? {} : { stroke: wire, strokeWidth: 2 }));
            out.push(line(x + 76, y + 17, r === 0 ? 132 : 100, 10, r === 0 ? mixHex(wire, g.ink, 0.3) : wireSoft));
          });
          out.push(button(x + 28, by + 220, 124, 26, "Connect", { fill: g.accent, color: inkOn(K, g.accent), family: K.body, size: 13, weight: 700 }));
          break;
        }
        case "import": {
          // One file, a progress bar with a real estimate, a way out.
          out.push(rect(x + 28, by + 56, fw - 56, 64, g.panel, { radius: 8, stroke: g.line, strokeWidth: 1.5 }));
          out.push(icon("file-text", x + 46, by + 72, 32, g.muted));
          out.push(line(x + 96, by + 70, 150, 10));
          out.push(line(x + 96, by + 90, 96, 8, wireSoft));
          out.push(rect(x + 28, by + 146, fw - 56, 14, wireSoft, { radius: 7 }));
          out.push(rect(x + 28, by + 146, Math.round((fw - 56) * 0.62), 14, g.accent, { radius: 7 }));
          out.push(text(x + 28, by + 172, 292, 22, "62%  ·  about 4 min left", { family: mono, size: 14, weight: 500, color: accentInk, lineHeight: 1.2 }));
          out.push(rect(x + 28, by + 216, 172, 26, g.bg, { radius: 13, stroke: wire, strokeWidth: 1.5 }));
          out.push(line(x + 52, by + 224, 124, 10, wireSoft));
          break;
        }
        case "preview": {
          // The first report, drawn from their data: the moment.
          out.push(rect(x + 28, by + 56, fw - 56, 176, g.panel, { radius: 8, stroke: g.line, strokeWidth: 1.5 }));
          out.push(line(x + 48, by + 74, 110, 8, wireSoft));
          const hs = [48, 72, 60, 96, 128];
          hs.forEach((h, j) => out.push(rect(x + 62 + j * 48, by + 212 - h, 34, h, j === 4 ? g.accent : mixHex(wireSoft, g.accent, 0.35), { radius: 4 })));
          out.push(rect(x + 48, by + 212, 252, 1, wire));
          break;
        }
        case "invite": {
          // One teammate, and a link that opens on the report.
          out.push(ellipse(x + 28, by + 58, 56, 56, mixHex(g.panel, g.accent, 0.2)));
          out.push(icon("user", x + 42, by + 72, 28, accentInk));
          out.push(rect(x + 100, by + 64, fw - 128, 44, g.bg, { radius: 8, stroke: wire, strokeWidth: 1.5 }));
          out.push(line(x + 116, by + 81, 120, 10, wireSoft));
          out.push(rect(x + 28, by + 132, fw - 56, 64, g.panel, { radius: 8, stroke: g.line, strokeWidth: 1.5 }));
          [16, 26, 36].forEach((h, j) => out.push(rect(x + 46 + j * 12, by + 180 - h, 8, h, j === 2 ? g.accent : mixHex(wireSoft, g.accent, 0.35), { radius: 2 })));
          out.push(line(x + 96, by + 148, 150, 10));
          out.push(line(x + 96, by + 168, 90, 8, wireSoft));
          out.push(icon("link", x + fw - 60, by + 150, 22, accentInk));
          out.push(button(x + 28, by + 216, 124, 26, "Invite", { fill: g.accent, color: inkOn(K, g.accent), family: K.body, size: 13, weight: 700 }));
          break;
        }
      }
      return out;
    };

    screens.forEach(({ head, body, chip, kind }, k) => {
      const x = M + k * (fw + gap);
      // The window: a picture slot with an ink outline and a title bar.
      nodes.push({ kind: "rect", name: "Photo", x, y: fy, w: fw, h: fh, fill: g.bg, radius: 14, stroke: g.ink, strokeWidth: 2 });
      nodes.push(rect(x + 1, fy + 1, fw - 2, barH, wireSoft, { radius: 13 }));
      nodes.push(rect(x + 1, fy + 1 + barH / 2, fw - 2, barH / 2, wireSoft));
      nodes.push(rect(x + 1, fy + barH, fw - 2, 1, g.line));
      [0, 1, 2].forEach((d) => nodes.push(ellipse(x + 16 + d * 14, fy + 14, 8, 8, wire)));
      nodes.push(rect(x + 68, fy + 10, fw - 68 - 60, 16, g.bg, { radius: 8 }));
      nodes.push(text(x + fw - 54, fy + 8, 40, 20, String(k + 1).padStart(2, "0"), { family: mono, size: 14, weight: 600, color: accentInk, align: "right", lineHeight: 1.2 }));
      nodes.push(...sketch(kind, x, fy + barH));
      // The arrow to the next screen: filled geometry, since the server
      // renderer fills a path and does not stroke one.
      if (k < n - 1) {
        const cy = fy + fh / 2, x1 = x + fw + 16, x2 = x + fw + gap - 16;
        nodes.push(rect(x1, cy - 1, x2 - x1 - 10, 2, g.ink));
        nodes.push(path([[x2 - 16, cy - 9], [x2, cy], [x2 - 16, cy + 9]], { fill: g.ink, closed: true }));
      }
      // The caption: a name, a line, and the decision as a chip.
      const hy = fy + fh + 30;
      nodes.push(text(x, hy, fw, 36, head, t.display(28)));
      fill.push({ node: nodes.length - 1, label: `Screen ${k + 1}`, hint: "The screen's name" });
      nodes.push(text(x, hy + 44, fw, 112, body, t.body(19)));
      const cw = Math.min(fw, Math.round(chip.length * 15 * 0.62) + 44);
      nodes.push(button(x, hy + 180, cw, 40, chip, { fill: chipFill, color: accentInk, family: mono, size: 15, weight: 600 }));
      fill.push({ node: `${nodes.length - 1}-label`, label: `Decision ${k + 1}`, hint: "The one decision this screen embodies" });
    });

    // The legend, bottom left, clear of the note.
    nodes.push(button(M, 912, 118, 30, "decision", { fill: chipFill, color: accentInk, family: mono, size: 13, weight: 600 }));
    nodes.push(text(M + 134, 915, 420, 24, "one chip per screen: what it commits to", t.meta({ size: 16 })));

    nodes.push(...note(K, g, c.note));
    return { page: { name: "Flow strip", bg: g.bg, nodes }, fill };
  },
};

export default {
  id: "deck-design-review",
  title: "Design Review",
  base: "slate",
  rank: 60,
  tags: [
    "design",
    "review",
    "critique",
    "ux"
  ],
  meta: {
    company: "Form & Function",
    deck: "Design review: onboarding",
    kicker: "design review, onboarding flow",
    farewell: "see you at the next round",
    art: {
      cover: "il-day94-ui-ux",
      section: "la-conversation-illustration",
      picture: "la-website-builder",
      closing: "la-waitng-illustration"
    }
  },
  look: {
    display: "Inter Tight", dw: 600,
    body: "Public Sans", bw: 400,
    mono: "Geist Mono",
    accentFace: "Nanum Pen Script", accentWeight: 400, accentSize: 42,
    charWidth: 0.5,
    paper: { bg: "#FFFFFF", ink: "#17151F", muted: "#5C5968", line: "#E4E2EA", panel: "#F6F5F9", panel2: "#ECEAF1", accent: "#6D28D9", accent2: "#6E6A84", accentInk: "#5B21B6", accent2Ink: "#4E4A63" },
    deep: { bg: "#1E1A2B", bg2: "#0F0D18", ink: "#F7F6FA", muted: "#B5B0C6", line: "#363047", panel: "#29243A", panel2: "#342E47", accent: "#A78BFA", accent2: "#D6D2E4", accentInk: "#C4B5FD" },
    radius: 12,
    ornament: "dots",
    peeps: ["op-peep-3", "op-peep-20", "op-peep-32", "op-peep-100", "op-peep-24"],
    scale: { cover: 112, title: 60, section: 236, statement: 78, numeral: 104, quote: 52 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "The problem\nthis design answers",
        subtitle: "Eleven days to first value today. This flow aims for three. The room's judgment on three open questions.",
        presenter: "Aisha Bello, Product Design  ·  22 October 2026",
        chips: [["11 days", "today"], ["3 days", "target"], ["3", "questions"]],
        note: "critique the flow, not the pixels"
      }
    ],
    [
      "figures",
      {
        eyebrow: "The problem",
        title: "What the numbers say",
        stats: [
          [
            "11 days",
            "To first value, today",
            "Median, Q3",
            "From signup to the first report a user opens. Most of it is spent connecting sources nobody asked for yet."
          ],
          [
            "41%",
            "Wizard completion",
            "12 users tested",
            "Six steps before any value. Users could not say what step three was for, and half of them stopped there."
          ],
          [
            "78%",
            "Preview completion",
            "12 users tested",
            "Value on screen two. Every participant could say what the product does before setup began."
          ],
          [
            "3 days",
            "Target, first value",
            "This flow's bet",
            "One source, one import, one report, one teammate. Everything else waits until the report exists."
          ]
        ],
        note: "twelve users, one script, two rounds"
      }
    ],
    [
      "raw",
      {
        build: signature.flow,
        eyebrow: "The flow",
        title: "The user's path, screen by screen",
        screens: [
          {
            kind: "connect",
            head: "Connect",
            body: "One screen, one source. The other integrations wait until the first import has succeeded.",
            chip: "One source at a time"
          },
          {
            kind: "import",
            head: "Import",
            body: "Progress with a real estimate. Large files stream; the user can leave and come back.",
            chip: "Leave and come back"
          },
          {
            kind: "preview",
            head: "Preview",
            body: "The first report drawn from their data, before any setup. This is the moment we are designing for.",
            chip: "Preview before setup"
          },
          {
            kind: "invite",
            head: "Invite",
            body: "One teammate, one click, and a link that opens on the preview, not on a blank workspace.",
            chip: "Invite from the preview"
          }
        ],
        note: "the prototype walks this exact order"
      }
    ],
    [
      "threeCards",
      {
        eyebrow: "Key decisions",
        title: "The three choices that shaped it",
        cards: [
          [
            "bolt",
            "Preview before setup",
            "The report comes first; configuration comes after the user has seen the value. Rejected: a setup wizard."
          ],
          [
            "layout-list",
            "One source at a time",
            "Connecting five sources on day one is where users quit. Rejected: the integrations grid."
          ],
          [
            "user",
            "Invite from the preview",
            "The invite link lands on the report. Rejected: an invite step in the wizard."
          ]
        ],
        note: "each of these cost us a feature request"
      }
    ],
    [
      "twoColumns",
      {
        eyebrow: "Alternatives",
        title: "What we rejected, and why",
        left: {
          eyebrow: "Rejected",
          head: "The setup wizard",
          lines: [
            "Six steps before any value",
            "Tested at 41% completion",
            "Users could not tell what step three was for"
          ],
          icon: "alert-triangle"
        },
        right: {
          eyebrow: "Chosen",
          head: "Preview first",
          lines: [
            "Value on screen two",
            "Tested at 78% completion",
            "Every participant understood what the product does"
          ],
          icon: "circle-check"
        },
        note: "same tasks, same users, six weeks apart"
      }
    ],
    [
      "section",
      {
        n: "",
        title: "Three open questions",
        blurb: "Decided on three things, open on three. The flow does not go to build until the room has answered these.",
        kicker: "the part we cannot decide alone",
        art: "la-conversation-illustration",
        note: "each one has a default; argue with it"
      }
    ],
    [
      "threeCards",
      {
        eyebrow: "Open questions",
        title: "Where we want the room's judgment",
        cards: [
          [
            "message",
            "What if the import fails?",
            "The preview needs data. Do we show a sample report, or hold the user on the import screen with help?"
          ],
          [
            "clock",
            "How long is too long?",
            "Streaming imports can take an hour. Do we let the user leave, and what brings them back?"
          ],
          [
            "user",
            "Invite before value?",
            "Some teams want to invite first. Do we allow it, and does it dilute the preview moment?"
          ]
        ],
        note: "tell us which, and why we are wrong"
      }
    ],
    [
      "closing",
      {
        title: "Next iteration",
        subtitle: "Decisions from this room by Friday; the flow goes to build on Monday. Prototype and research notes are in the design folder.",
        rows: [
          [
            "mail",
            "aisha@formfunction.example"
          ],
          [
            "world",
            "design.formfunction.example/onboarding"
          ],
          [
            "calendar",
            "Build starts: 27 October"
          ]
        ],
        cta: "Open the prototype",
        art: "la-waitng-illustration",
        note: "silence by Friday ships the default"
      }
    ]
  ]
};
