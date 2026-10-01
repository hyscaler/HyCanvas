// Sprint Demo: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: a terminal on a warm near-black. Terminal green for everything
// that passed, a warm sand for everything that came before, a warm grey for
// the reading text. A heavy mono for every title and figure, a legible sans
// for the body, and a CRT pixel face for the kicker and the notes. The
// ornament is one enormous prompt, ">_", in a tint of the ground: show
// first, then tell.

import { text, rect, ellipse, path, footer, note, ornamentDeep, type, deepGround, estWidth, W, M, CW } from "../lib/deck-kit.mjs";

// --- the signature slide -------------------------------------------------------

/** The demo frame: one terminal window with a title bar (three dots and a
 *  path), split into two panes like a multiplexer, one per demo. Each pane
 *  runs the demo as a prompt line, names the feature in the heavy mono,
 *  lists the edge cases it survived as green check lines, and ends with
 *  the before figure struck through beside the after figure. A green
 *  status bar along the bottom carries the sprint tallies. */
const signature = {
  demoFrame(K, i, c) {
    const g = K.deep;
    const t = type(K, g);
    const mono = K.mono ?? K.display;
    const cw = K.charWidth ?? 0.56;
    // The watermark glyph would sit behind the window; keep the top rule only.
    const nodes = ornamentDeep(K, g).filter((n) => n.kind !== "text");
    const fill = [];
    const green = g.accentInk ?? g.accent;
    const sand = g.accent2Ink ?? g.accent2;
    const r = K.radius;

    // The reading grid's eyebrow baseline, kept on the deep ground.
    nodes.push(text(M, 88, 1100, 28, c.eyebrow, t.eyebrow()));

    // The window: body, title bar with square lower corners, a hairline
    // under the bar, three dots and the path.
    const wx = M, wy = 150, ww = CW, wh = 706, barH = 56;
    nodes.push(rect(wx, wy, ww, wh, g.panel, { radius: r, stroke: g.line, strokeWidth: 1.5 }));
    nodes.push(rect(wx, wy, ww, barH, g.panel2, { radius: r }));
    nodes.push(rect(wx, wy + barH - r, ww, r, g.panel2));
    nodes.push(rect(wx, wy + barH, ww, 1, g.line));
    [g.muted, sand, green].forEach((tone, k) => nodes.push(ellipse(wx + 26 + k * 28, wy + 20, 16, 16, tone)));
    nodes.push(text(wx + 120, wy + 17, ww - 240, 24, c.path, t.meta({ align: "center", size: 18 })));
    fill.push({ node: nodes.length - 1, label: "Window title", hint: "The path in the title bar" });

    // The divider between the two panes.
    nodes.push(rect(W / 2, wy + barH + 1, 1, wh - barH - 38, g.line));

    // One pane per demo. The check marks and the arrow are filled polygons,
    // not stroked paths: the server renderer fills a path and never strokes
    // one, so a stroke-only mark would vanish from every thumbnail.
    const pw = ww / 2 - 96;
    const check = (x, y) => path([[x, y + 11], [x + 3, y + 8], [x + 9, y + 14], [x + 23, y], [x + 26, y + 3], [x + 9, y + 20]], { fill: green, closed: true });
    c.panes.forEach((p, k) => {
      const px = (k ? W / 2 : wx) + 48;
      nodes.push(text(px, 244, pw, 32, `$ ${p.cmd}`, { family: mono, size: 24, weight: 500, color: green, lineHeight: 1.3 }));
      nodes.push(text(px, 290, pw, 122, p.name, t.display(54, { lineHeight: 1.1 })));
      fill.push({ node: nodes.length - 1, label: `Demo ${k + 1}`, hint: "The feature, two short lines" });
      nodes.push(rect(px, 432, pw, 1, g.line));
      p.checks.forEach((line, j) => {
        const y = 458 + j * 54;
        nodes.push(check(px + 2, y + 7));
        nodes.push(text(px + 46, y, pw - 46, 36, line, t.strong(24, { weight: 500 })));
      });
      nodes.push(rect(px, 630, pw, 1, g.line));
      // Before, struck through in sand; after, in green, larger.
      nodes.push(text(px, 654, 300, 22, "before", t.eyebrow({ size: 15, color: sand })));
      nodes.push(text(px + 380, 654, 300, 22, "after", t.eyebrow({ size: 15, color: green })));
      nodes.push(text(px, 690, 300, 66, p.before[0], t.numeral(56, { color: g.muted })));
      nodes.push(rect(px - 6, 690 + 26, Math.round(estWidth(p.before[0], 56, cw)) + 12, 5, sand, { opacity: 0.9 }));
      nodes.push(rect(px + 262, 716, 46, 4, green, { radius: 2 }));
      nodes.push(path([[px + 304, 706], [px + 324, 718], [px + 304, 730]], { fill: green, closed: true }));
      nodes.push(text(px + 380, 676, pw - 380, 92, p.after[0], t.numeral(84)));
      fill.push({ node: nodes.length - 1, label: `Demo ${k + 1} after`, hint: "The figure after the change" });
      nodes.push(text(px, 764, 340, 26, p.before[1], t.meta({ size: 17 })));
      nodes.push(text(px + 380, 764, pw - 380, 26, p.after[1], t.meta({ size: 17 })));
    });

    // The status bar: green, with the sprint tallies in the ground's ink.
    const sy = wy + wh - 38;
    nodes.push(rect(wx, sy, ww, 38, green, { radius: r }));
    nodes.push(rect(wx, sy, ww, r, green));
    nodes.push(text(wx + 24, sy + 9, 900, 22, c.statusLeft, { family: mono, size: 17, weight: 600, color: g.bg2, lineHeight: 1.2 }));
    nodes.push(text(wx + ww - 924, sy + 9, 900, 22, c.statusRight, { family: mono, size: 17, weight: 600, color: g.bg2, lineHeight: 1.2, align: "right" }));
    fill.push({ node: nodes.length - 1, label: "Sprint tallies", hint: "Stories done, carried, bugs, the date" });

    nodes.push(...note(K, g, c.note, true));
    nodes.push(...footer(K, g, i));
    return { page: { name: "Demo frame", bg: deepGround(g), nodes }, fill };
  },
};

export default {
  id: "deck-sprint-demo",
  title: "Sprint Demo",
  base: "vanta",
  rank: 62,
  tags: [
    "demo",
    "sprint",
    "engineering",
    "agile"
  ],
  meta: {
    company: "Nova Systems",
    deck: "Sprint 42 demo",
    kicker: "// show, then tell",
    farewell: "// next sprint",
    art: {
      cover: "il-day38-macintosh",
      section: "il-day41-desktop",
      picture: "il-day17-walkie-talkie",
      closing: "il-day18-floppy"
    }
  },
  look: {
    display: "JetBrains Mono", dw: 800,
    body: "Atkinson Hyperlegible Next", bw: 400,
    mono: "JetBrains Mono",
    accentFace: "VT323", accentWeight: 400, accentSize: 40,
    charWidth: 0.6,
    // Green reads on the near-black as it is; no accent ink needed on either ground.
    paper: { bg: "#151711", ink: "#EEECE4", muted: "#A5A398", line: "#2E3027", panel: "#1D1F18", panel2: "#272921", accent: "#3DF37C", accent2: "#D9C79B" },
    deep: { bg: "#0D0E0B", bg2: "#050604", ink: "#ECEAE2", muted: "#9C9A90", line: "#292B23", panel: "#161811", panel2: "#20221A", accent: "#3DF37C", accent2: "#D9C79B" },
    radius: 6,
    ornament: "watermark",
    watermark: ">_",
    peeps: ["op-peep-33", "op-peep-77", "op-peep-94", "op-peep-19", "op-peep-50"],
    scale: { cover: 90, title: 56, section: 200, statement: 70, numeral: 100, quote: 50 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "Sprint 42: the goal\nwe committed to",
        subtitle: "Two demos, the numbers under the hood, and what we pull into sprint 43 and what we park.",
        presenter: "Tomas Reyes, Engineering Lead  ·  17 October 2026",
        chips: [
          [
            "14",
            "stories done"
          ],
          [
            "2",
            "carried"
          ],
          [
            "0",
            "bugs opened"
          ]
        ],
        note: "real incidents, nothing rehearsed"
      }
    ],
    [
      "section",
      {
        n: "",
        title: "Show first",
        blurb: "Two demos on staging, against last week's real incidents. Slides only for what the terminal cannot show.",
        kicker: "// part one",
        art: "il-day41-desktop"
      }
    ],
    [
      "textPicture",
      {
        eyebrow: "Demo one",
        title: "Incident narrative, first draft",
        points: [
          [
            "The feature",
            "Open an incident and the timeline writes the first paragraph: what changed, when, and the first symptom."
          ],
          [
            "The flow",
            "Deploy at 14:02, latency alert at 14:09, narrative drafted at 14:09:30. The on-call reads instead of digging."
          ],
          [
            "Edge cases handled",
            "Overlapping deploys, missing traces, and a timeline with nothing in it all produce an honest sentence."
          ]
        ],
        art: "il-day17-walkie-talkie",
        note: "watch the paragraph appear at 14:09:30"
      }
    ],
    [
      "split",
      {
        left: {
          eyebrow: "Under the hood, before",
          head: "Eleven seconds\nfor ten thousand\ntraces.",
          lines: [
            "Every first sentence needs ten thousand traces. The row store took eleven seconds to hand them over.",
            "Eleven seconds is longer than the on-call waits before opening the dashboards anyway.",
            "One table, no partitions, and every incident querying the same hot rows at once."
          ]
        },
        right: {
          eyebrow: "Demo two",
          head: "The trace store,\nrebuilt.",
          body: "Traces now land in a columnar store partitioned by hour: two engineers, three weeks, one migration script. The old row store stays read-only until December.",
          checks: [
            [
              "bolt",
              "Ten thousand traces in 0.9 seconds"
            ],
            [
              "database",
              "Old row store still answers, read-only"
            ],
            [
              "circle-check",
              "Rehearsed twice in staging"
            ]
          ]
        },
        art: "il-day44-hdd"
      }
    ],
    [
      "raw",
      {
        build: signature.demoFrame,
        eyebrow: "What you just saw  ·  edge cases and the figure that moved",
        path: "tomas@nova: ~/sprint-42/demos",
        panes: [
          {
            cmd: "demo incident-narrative",
            name: "Incident narrative,\nfirst draft",
            checks: [
              "Two deploys overlapping the alert",
              "An incident with no traces attached",
              "A timeline with nothing on it yet"
            ],
            before: ["25 min", "on-call digging before a first summary"],
            after: ["30 s", "the on-call reads, then goes to the fix"]
          },
          {
            cmd: "demo trace-store",
            name: "The trace store,\nrebuilt",
            checks: [
              "Ten thousand traces under a second",
              "Migration ran twice in staging, once in prod",
              "Old row store still answers, read-only"
            ],
            before: ["11 s", "ten thousand traces on the row store"],
            after: ["0.9 s", "the same query on the columnar store"]
          }
        ],
        statusLeft: "[sprint-42]  0:incident-narrative  1:trace-store*",
        statusRight: "14 done  ·  2 carried  ·  0 bugs  ·  17 Oct",
        note: "figures from Tuesday's run, not a rehearsal"
      }
    ],
    [
      "figures",
      {
        eyebrow: "The numbers",
        title: "Velocity, bugs and the trend",
        stats: [
          [
            "38",
            "Points completed",
            "+4 on sprint 41",
            "Third sprint in a row above the rolling average."
          ],
          [
            "0",
            "Bugs opened",
            "−3",
            "First clean sprint since June; the trace store tests paid off."
          ],
          [
            "0.9 s",
            "Narrative draft time",
            "Target 1.0 s",
            "Down from eleven seconds on the old store."
          ],
          [
            "2",
            "Stories carried",
            "Same as last sprint",
            "Both waiting on the vendor contract for APAC."
          ]
        ],
        note: "one clean sprint is a good week, three is a trend"
      }
    ],
    [
      "quote",
      {
        text: "It wrote the paragraph I would have\nwritten at minute twenty. I read it\nat minute one and went to the fix.",
        name: "Ines Kowalczyk",
        role: "On-call, platform team. Used the draft on Tuesday's 14:09 alert",
        note: "the real alert, not a fixture"
      }
    ],
    [
      "twoColumns",
      {
        eyebrow: "Next sprint",
        title: "What we pull, what we park",
        left: {
          eyebrow: "Pull",
          head: "Narrative to ten beta customers",
          lines: [
            "Feedback form inside the incident view",
            "Two more edge cases from the demo",
            "Trace store cutover for the last region"
          ],
          icon: "circle-check"
        },
        right: {
          eyebrow: "Park",
          head: "Everything APAC until the contract signs",
          lines: [
            "Residency work stays in the backlog",
            "Mobile alerts moves to sprint 44",
            "No new services until the cutover is done"
          ],
          icon: "clock"
        },
        note: "APAC unblocks the day the contract signs"
      }
    ],
    [
      "closing",
      {
        title: "Questions",
        subtitle: "Demo recordings and the sprint report are in the channel. Retro on Monday at ten.",
        rows: [
          [
            "message",
            "#platform on Slack"
          ],
          [
            "mail",
            "tomas@novasystems.example"
          ],
          [
            "calendar",
            "Retro: 20 October, 10:00"
          ]
        ],
        cta: "Open the sprint board",
        art: "il-day18-floppy",
        note: "bring the recording to the retro"
      }
    ]
  ]
};
