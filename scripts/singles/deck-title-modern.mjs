// Presentation Title: one single-slide template, the title slide of a quarterly review. See scripts/gen-single-slides.mjs.
// base: the library look it starts from; look: overrides on that look;
// slides: [layout, content] in order; a raw slide carries a build function.
//
// The look: graphite and ice blue. A cool grey paper with a deep graphite
// gradient, ice blue for every rule, numeral and kicker, a warm amber held
// back for the deltas and the second card on the reading pages. A clean
// geometric sans for titles and figures, a quiet sans for reading, a mono
// for the eyebrows and labels, and a thin ballpoint hand for the notes: a
// corporate deck with a pulse, which is the trace on its cover.

import { text, rect, ellipse, path, art, halo, note, mark, type, deepGround, ornamentDeep, pageNo, fitSize, W, M, CW } from "../lib/deck-kit.mjs";

const SKY = "#2C8FD6";
const AMBER = "#E39A3B";

// --- the signature slide -------------------------------------------------------

/** The pulse cover: the title block at left and the drawing lit in its halo
 *  at right, as any cover, and under both the quarter itself: thirteen
 *  weeks of bookings drawn as one trace across the whole width, filled
 *  under, its peak ringed and figured, the months ticked on the baseline.
 *  A status pill with a live dot names the quarter top right. */
const signature = {
  pulse(K, i, c) {
    const g = K.deep;
    const t = type(K, g);
    // Keep the glow's lights and its grid; drop the sparkle that would land
    // in the trace band or on the note.
    const nodes = ornamentDeep(K, g).filter((n) => !(n.kind === "ellipse" && n.w <= 9 && n.y > 690));
    const fill = [];
    const illustrations = [];

    nodes.push(...mark(K, g));
    fill.push({ node: nodes.length - 1, label: "Company", hint: "Your company or team name" });

    // Top right: the quarter as a status pill with a live dot.
    nodes.push(rect(1620, 88, 204, 40, g.panel, { radius: 20, stroke: g.line, strokeWidth: 1.5 }));
    nodes.push(ellipse(1636, 98, 20, 20, g.accent, { opacity: 0.22 }));
    nodes.push(ellipse(1641, 103, 10, 10, g.accent));
    nodes.push(text(1668, 98, 148, 22, c.tag ?? "Q3  ·  2026", t.eyebrow({ size: 16, letterSpacing: 3 })));
    fill.push({ node: nodes.length - 1, label: "Quarter", hint: "The period this deck reviews" });

    // The title block, on the cover's baselines.
    nodes.push(text(M, 296, 1000, 60, K.kicker, t.kicker()));
    const size = fitSize(c.title, K.scale.cover, 1000, 0.6, K.charWidth ?? 0.56);
    const lines = c.title.split("\n").length;
    const titleH = Math.round(size * 1.05 * lines) + 10;
    nodes.push(text(M, 362, 1000, titleH, c.title, t.display(size, { lineHeight: 1.02 })));
    fill.push({ node: nodes.length - 1, label: "Title", hint: "Two short lines" });
    nodes.push(text(M, 362 + titleH + 26, 900, 80, c.subtitle, t.body(28)));
    fill.push({ node: nodes.length - 1, label: "Subtitle", hint: "One sentence on what the deck covers" });

    // The hero: the drawing in its halo, top right.
    nodes.push(...halo(1500, 424, 620, g.accent));
    illustrations.push(art(c.art ?? K.art.cover, 1230, 164, 540, 520));

    // The pulse: thirteen weeks of bookings as one trace across the page,
    // filled under, with a soft wider stroke as its glow.
    const weeks = c.weeks ?? [0.14, 0.24, 0.18, 0.3, 0.38, 0.32, 0.44, 0.52, 0.46, 0.6, 0.76, 1, 0.82];
    const bx = M, bw = CW, top = 786, base = 905;
    const px = (k) => Math.round(bx + (k * bw) / (weeks.length - 1));
    const py = (v) => Math.round(base - v * (base - top));
    const pts = weeks.map((v, k) => [px(k), py(v)]);
    nodes.push(path([[pts[0][0], base], ...pts, [pts[pts.length - 1][0], base]], { fill: g.accent, closed: true, opacity: 0.14 }));
    nodes.push(path(pts, { stroke: g.accent, strokeWidth: 9, opacity: 0.2 }));
    nodes.push(path(pts, { stroke: g.accent, strokeWidth: 3 }));
    nodes.push(rect(bx, base, bw, 1, g.line));
    nodes.push(text(bx, 760, 700, 22, c.bandLabel ?? "Weekly bookings  ·  thirteen weeks", t.eyebrow({ size: 15, letterSpacing: 3 })));
    // The peak, ringed, with its figure set just left of it.
    const peak = weeks.indexOf(Math.max(...weeks));
    const [kx, ky] = pts[peak];
    nodes.push(ellipse(kx - 16, ky - 16, 32, 32, g.accent, { opacity: 0.25 }));
    nodes.push(ellipse(kx - 7, ky - 7, 14, 14, g.accent));
    nodes.push(text(kx - 140, ky - 26, 116, 20, c.peakLabel ?? "$1.6M", { family: K.mono ?? K.body, size: 15, weight: 600, color: g.ink, align: "right", lineHeight: 1.2 }));
    // Month ticks on the baseline.
    const months = c.months ?? ["Jul", "Aug", "Sep"];
    months.forEach((m, k) => {
      const x = Math.round(bx + (k * bw) / months.length);
      nodes.push(rect(x, base - 6, 1, 12, g.line));
      nodes.push(text(x + 12, base + 6, 200, 20, m, { family: K.mono ?? K.body, size: 14, weight: 500, color: g.muted, upper: true, letterSpacing: 2, lineHeight: 1.2 }));
    });

    nodes.push(text(M, 940, 900, 28, c.presenter, t.meta()));
    fill.push({ node: nodes.length - 1, label: "Presenter and date", hint: "Who presents, and when" });
    if (K.total > 1) nodes.push(text(W - M - 240, 940, 240, 28, pageNo(i, K.total), t.meta({ align: "right" })));
    // The hand note, under the drawing and above the trace.
    nodes.push(...note(K, g, c.note, true, { x: 1140, y: 688, w: 720, align: "center" }));
    return { page: { name: "Cover", bg: deepGround(g), nodes, illustrations }, fill };
  },
};

export default {
  id: "deck-title-modern",
  title: "Presentation Title",
  base: "slate",
  rank: 5,
  tags: [
    "slide",
    "title",
    "minimal",
    "corporate"
  ],
  styleTags: [
    "minimal",
    "modern",
    "corporate"
  ],
  meta: {
    company: "Northwind Labs",
    deck: "Quarterly review 2026",
    kicker: "quarterly review",
    farewell: "see you in January",
    art: {
      cover: "la-monitor",
      section: "il-day66-travel",
      picture: "il-day11-blackboard",
      closing: "il-day79-coffee"
    }
  },
  look: {
    display: "Plus Jakarta Sans", dw: 800,
    body: "Onest", bw: 400,
    mono: "Geist Mono",
    accentFace: "Reenie Beanie", accentWeight: 400, accentSize: 46,
    charWidth: 0.58,
    paper: { bg: "#F3F5F8", bg2: "#E4E9EF", ink: "#1B1F26", muted: "#5B6470", line: "#D6DCE4", panel: "#E9EDF2", panel2: "#DDE3EA", accent: SKY, accentInk: "#1A6FAE", accent2: AMBER, accent2Ink: "#9A5F10" },
    deep: { bg: "#2A2F37", bg2: "#14171C", ink: "#F3F5F8", muted: "#A5AEBA", line: "#3D444F", panel: "#333944", panel2: "#3E4552", accent: "#9AD6FF", accent2: "#CFE7F7" },
    radius: 10,
    ornament: "glow",
    peeps: ["op-peep-2", "op-peep-16", "op-peep-19", "op-peep-28", "op-peep-11"],
    scale: { cover: 116, title: 60, section: 236, statement: 78, numeral: 104, quote: 52 },
  },
  signature,
  slides: [
[
      "raw",
      {
        build: signature.pulse,
        title: "Building\nwhat's next",
        subtitle: "A clear look at progress, priorities, and the road ahead.",
        presenter: "Dana Cole, Chief Operating Officer  ·  9 October 2026",
        tag: "Q3  ·  2026",
        note: "thirteen weeks, one line"
      }
    ],
  ]
};
