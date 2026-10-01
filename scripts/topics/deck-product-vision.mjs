// Product Vision: one topic deck. See scripts/gen-topic-decks.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: a horizon at dawn. Deep indigo under an aurora green, a soft
// lilac for the second voice, a pale lilac-white paper for reading. A light
// geometric sans for titles, a plain humanist sans for the reading, a thin
// hand for the kicker and the notes. Concentric rings off the top right
// corner as the ornament: the sun coming up behind everything.

import { text, rect, ellipse, icon, halo, sparkles, note, footer, ornamentDeep, type, deepGround, mixHex, inkOn, M, CW } from "../lib/deck-kit.mjs";

const signature = {
  /** The horizon: the road from now to 2029 drawn as one rising curve over
   *  a dawn-lit ground. Four milestones sit on the curve, each with its
   *  year, a verb and a line; the shipped one is solid and checked, the
   *  ones ahead are hollow, and the last is the sun itself, the largest
   *  disc on the page, in a halo. The vision sentence sits above it all. */
  horizon(K, i) {
    const g = K.deep;
    const t = type(K, g);
    const nodes = [...ornamentDeep(K, g)];
    const fill = [];

    // The curve: from the ground at the left to the sun at the right,
    // steepening as it goes. y(u) for u in [0, 1].
    const S = { x: 200, y: 840 }, E = { x: 1724, y: 392 };
    const at = (u) => ({ x: S.x + (E.x - S.x) * u, y: S.y - (S.y - E.y) * Math.pow(u, 1.7) });

    const steps = [
      { u: 0.14, r: 20, year: "2026", head: "Correlate", body: "Every deploy, config change and alert on one timeline. Shipped.", done: true },
      { u: 0.41, r: 28, year: "2027", head: "Explain", body: "The incident narrative written by the system, from the timeline it already has." },
      { u: 0.64, r: 38, year: "2028", head: "Suggest", body: "The likely fix, drafted as a change request, with the blast radius shown." },
      { u: 1.0, r: 60, year: "2029", head: "Act", body: "Reversible fixes applied on a yes. The human owns the decision, not the typing.", sun: true },
    ];
    const marks = steps.map((s) => ({ ...s, ...at(s.u) }));

    // The header: an eyebrow and the vision in one sentence.
    nodes.push(text(M, 96, 1000, 28, "The path  ·  2026 to 2029", t.eyebrow()));
    nodes.push(text(M, 132, 1000, 150, "The system will read, explain, suggest and act. The human keeps the decision.", t.display(44, { lineHeight: 1.1 })));
    fill.push({ node: nodes.length - 1, label: "Vision", hint: "The vision in one sentence" });

    // The ground: a band of dawn light under the horizon line.
    nodes.push(rect(M, 852, CW, 116, { angle: 180, stops: [[mixHex(g.bg, g.accent, 0.16), 0], [mixHex(g.bg2, g.accent, 0.03), 1]] }));
    nodes.push(rect(M, 852, CW, 2, g.accent, { opacity: 0.55 }));
    nodes.push(rect(S.x - 1, S.y - 12, 2, 24, g.accent, { opacity: 0.8 }));
    nodes.push(text(S.x - 40, 866, 80, 22, "now", t.meta({ size: 16, align: "center" })));

    // The halo behind the sun, under the trail and the discs.
    const sun = marks[marks.length - 1];
    nodes.push(...halo(sun.x, sun.y, 360, g.accent));

    // The trail: dense solid dots up to the shipped milestone, sparser
    // lilac dots for the road ahead; none where a disc sits.
    const clear = (p) => marks.every((m) => Math.hypot(p.x - m.x, p.y - m.y) > m.r + 10);
    let last = null;
    for (let k = 0; k <= 600; k++) {
      const u = k / 600;
      const p = at(u);
      const done = u <= marks[0].u;
      const gap = done ? 11 : 30;
      if (last && Math.hypot(p.x - last.x, p.y - last.y) < gap) continue;
      last = p;
      if (!clear(p)) continue;
      const d = done ? 7 : 6 + Math.round(u * 4);
      nodes.push(ellipse(Math.round(p.x - d / 2), Math.round(p.y - d / 2), d, d, done ? g.accent : g.accent2, done ? {} : { opacity: 0.75 }));
    }

    // The milestones: a disc on the curve, a label block above and to the
    // left of it (the curve is always below and to the right), and a tick
    // from the block down to the disc. The sun's label sits under it on
    // the ground side, right-aligned; its body is wider and dropped a
    // little so it runs two lines in the gap between two rings, and the
    // 2028 block stays left of the outermost ring.
    marks.forEach((m, k) => {
      const x = Math.round(m.x), y = Math.round(m.y);
      if (m.sun) nodes.push(ellipse(x - m.r, y - m.r, m.r * 2, m.r * 2, g.accent));
      else if (m.done) nodes.push(ellipse(x - m.r, y - m.r, m.r * 2, m.r * 2, g.accent));
      else nodes.push(ellipse(x - m.r, y - m.r, m.r * 2, m.r * 2, g.bg2, { stroke: g.accent2, strokeWidth: 3 }));
      if (m.done) nodes.push(icon("circle-check", x - 11, y - 11, 22, inkOn(K, g.accent)));
      if (m.sun) nodes.push(icon("sun", x - 22, y - 22, 44, inkOn(K, g.accent)));
      const bw = m.sun ? 380 : 320, bh = 156;
      const bx = m.sun ? x + 96 - bw : x + 16 - bw;
      const by = m.sun ? y + m.r + 78 : y - m.r - 28 - bh;
      const bodyY = m.sun ? by + 104 : by + 72;
      const tone = m.done || m.sun ? g.accent : g.accent2;
      const align = m.sun ? "right" : "left";
      if (m.sun) nodes.push(rect(x - 1, y + m.r + 6, 2, by - (y + m.r + 6) - 6, tone, { opacity: 0.7 }));
      else nodes.push(rect(x - 1, by + bh + 2, 2, 24, tone, { opacity: 0.7 }));
      nodes.push(text(bx, by, bw, 22, m.year, t.eyebrow({ size: 17, letterSpacing: 3, color: tone, align })));
      nodes.push(text(bx, by + 28, bw, 36, m.head, t.display(30, { align })));
      fill.push({ node: nodes.length - 1, label: `Milestone ${k + 1}`, hint: "One verb" });
      nodes.push(text(bx, bodyY, bw, 84, m.body, t.body(20, { align })));
    });

    // The legend, on the ground side under the curve.
    const lx = 1400, ly = 770;
    nodes.push(ellipse(lx, ly + 7, 10, 10, g.accent));
    nodes.push(text(lx + 22, ly, 120, 24, "shipped", t.meta({ size: 17 })));
    [0, 1, 2].forEach((k) => nodes.push(ellipse(lx + 132 + k * 16, ly + 8, 8, 8, g.accent2, { opacity: 0.75 })));
    nodes.push(text(lx + 190, ly, 120, 24, "ahead", t.meta({ size: 17 })));
    // Stars in the sky left of the sun, where no text sits.
    nodes.push(...sparkles(g.accent2, 27 + i, 6, { x: 1290, y: 70, w: 300, h: 240 }));

    nodes.push(...footer(K, g, i));
    nodes.push(...note(K, g, "each step pays for the next", true));
    return { page: { name: "Horizon", bg: deepGround(g), nodes }, fill };
  },
};

export default {
  id: "deck-product-vision",
  title: "Product Vision",
  base: "vanta",
  rank: 90,
  tags: [
    "vision",
    "product",
    "strategy",
    "future"
  ],
  meta: {
    company: "Nova Systems",
    deck: "Product vision, 2029",
    kicker: "the future we see",
    farewell: "what we build next",
    art: {
      cover: "il-day22-owl",
      section: "il-day21-lantern",
      picture: "la-best-laptop-reddit",
      closing: "la-hero-image-2"
    }
  },
  look: {
    display: "Jost", dw: 500,
    body: "Figtree", bw: 400,
    mono: null,
    accentFace: "Shadows Into Light", accentWeight: 400, accentSize: 38,
    paper: { bg: "#F6F5FC", ink: "#1A1C4F", muted: "#585B88", line: "#DAD8EE", panel: "#ECEAF8", panel2: "#E0DDF4", accent: "#2FBE88", accent2: "#8F78EE", accentInk: "#0E6E4E", accent2Ink: "#5B45C4" },
    deep: { bg: "#20236B", bg2: "#0C0E38", ink: "#F3F2FC", muted: "#B4B3DC", line: "#373B8A", panel: "#292C7C", panel2: "#343890", accent: "#5EE6B2", accent2: "#CBBCFF" },
    radius: 12,
    ornament: "arcs",
    peeps: ["op-peep-11", "op-peep-24", "op-peep-102", "op-peep-43", "op-peep-90"],
    scale: { cover: 112, title: 60, section: 220, statement: 76, numeral: 100, quote: 50 },
  },
  signature,
  slides: [
    [
      "cover",
      {
        title: "The world when\nthis product wins",
        subtitle: "Where we are going, why us and why now, what the product does in three years, and the bets underneath it.",
        presenter: "Priya Raman, Head of Product  ·  November 2026",
        chips: [
          [
            "2029",
            "horizon"
          ],
          [
            "3",
            "bets"
          ],
          [
            "1",
            "product"
          ]
        ],
        note: "drawn in pencil, on purpose"
      }
    ],
    [
      "statement",
      {
        text: "In three years, nobody on a platform team will write a dashboard by hand. The system will tell them what changed and why.",
        source: "The vision in one sentence",
        note: "one sentence, no adjectives"
      }
    ],
    [
      "textPicture",
      {
        eyebrow: "Why us, why now",
        title: "Three shifts that make it possible",
        points: [
          [
            "Every system now emits structured events",
            "Ten years ago you had to build the pipe. Today the pipe exists; the product is what listens to it."
          ],
          [
            "Models can read a trace",
            "A model that explains an incident from raw telemetry was science fiction in 2023. It is a demo today."
          ],
          [
            "Platform teams are shrinking",
            "Fewer people run more systems. The tool that removes the reading wins."
          ]
        ],
        art: "la-best-laptop-reddit"
      }
    ],
    [
      "quote",
      {
        text: "The night it wrote the incident report before I had opened my laptop, I stopped reading dashboards. I have not gone back.",
        name: "Tomas Lindqvist",
        role: "Platform lead, Halden Energy, pilot customer since May",
        note: "from the pilot, week six"
      }
    ],
    [
      "twoColumns",
      {
        eyebrow: "The product in three years",
        title: "What it does that nothing does today",
        left: {
          eyebrow: "Today",
          head: "You ask the dashboard a question",
          lines: [
            "Someone built the panel last year",
            "It shows the metric, not the cause",
            "The incident channel does the reasoning"
          ],
          icon: "alert-triangle"
        },
        right: {
          eyebrow: "2029",
          head: "The system tells you before you ask",
          lines: [
            "Every change correlated to every symptom",
            "The cause named, with the evidence",
            "The fix drafted, waiting for a yes"
          ],
          icon: "circle-check"
        },
        note: "the right column is the whole product"
      }
    ],
    [
      "raw",
      { build: signature.horizon }
    ],
    [
      "threeCards",
      {
        eyebrow: "What we must believe",
        title: "The bets under the vision",
        cards: [
          [
            "shield",
            "Customers will trust a system that shows its evidence",
            "Every claim links to the trace. If we cannot show it, we do not say it."
          ],
          [
            "bolt",
            "Explanation beats prediction",
            "Teams do not want a forecast of incidents. They want to understand the one they have."
          ],
          [
            "world",
            "Open data wins the platform",
            "Customers keep their telemetry. We sell the reading, never the lock-in."
          ]
        ],
        note: "if one falls, the roadmap changes"
      }
    ],
    [
      "closing",
      {
        title: "The invitation",
        subtitle: "This is the product we build together next. Argue with the bets before the roadmap locks in December.",
        rows: [
          [
            "mail",
            "priya@novasystems.example"
          ],
          [
            "world",
            "vision.novasystems.example"
          ],
          [
            "calendar",
            "Roadmap lock: 15 December"
          ]
        ],
        cta: "Comment on the vision",
        art: "la-hero-image-2",
        note: "the bets are the part to argue with"
      }
    ]
  ]
};
