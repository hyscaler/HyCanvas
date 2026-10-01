// The presentation kit library: six looks and sixteen layouts, and the
// function that turns a look plus a slide plan into a template spec for
// scripts/build-templates.mjs.
//
// A look is one visual system: its faces, an accent face for one kicker
// line, a palette on paper and on a deep gradient ground, a corner radius,
// an ornament, drawings from the bundled packs and drawn portraits. A layout
// is one slide, hand-set slot by slot, that takes its content from a plan
// and its style from the look. The kits (scripts/gen-deck-kits.mjs) are the
// six looks over every layout with sample content; the topic decks
// (scripts/gen-topic-decks.mjs) are a look over a chosen sequence of layouts
// with their own copy; the single slides are one layout each.
//
// Every layout follows the same rules, which are what make a deck read as
// finished rather than assembled: two grounds with a rhythm between them,
// one grid held on every slide, depth by layering on the deep pages, a halo
// that lights the subject, sparkle as texture where no text sits, several
// voices of type each with one job, a warm accent on a cool ground, cards
// whose chrome carries information, and no empty slot anywhere.

export const W = 1920;
export const H = 1080;
export const M = 96;
export const CW = W - 2 * M;

// --- looks -------------------------------------------------------------------

/** Every colour a look needs on each of its two grounds. `paper` pages carry
 *  the reading slides; `deep` pages carry the cover, sections, the quote and
 *  the closing, on a gradient between `bg` and `bg2`. A dark look's paper is
 *  dark too, one shade lighter than deep. `accentInk` on a ground, when set,
 *  is the accent for text there (a saturated accent that vibrates on its
 *  ground keeps a calmer sibling for type). `art` names the drawings from
 *  the bundled packs the layouts place; `peeps` the portraits. */
export const LOOKS = {
  atlas: {
    id: "kit-atlas",
    title: "Atlas Corporate Kit",
    tags: ["kit", "corporate", "annual report", "investor", "serif", "navy", "gold"],
    styleTags: ["professional", "classic", "elegant"],
    rank: 10,
    company: "Halcyon Capital",
    deck: "Annual review FY2026",
    kicker: "The year in review",
    farewell: "Until next year",
    display: "Playfair Display", dw: 700, body: "Source Sans 3", bw: 400, mono: null,
    accentFace: "Cormorant Garamond", accentWeight: 600, accentSize: 40,
    paper: { bg: "#F8F5EE", ink: "#14213D", muted: "#5A627A", line: "#DCD6C8", panel: "#EFEBE1", panel2: "#E4DED0", accent: "#C9992A", accent2: "#3E6FCC" },
    deep: { bg: "#182752", bg2: "#0C1330", ink: "#F8F5EE", muted: "#B4BCD0", line: "#2E3E6A", panel: "#21335F", panel2: "#2A3F73", accent: "#E8B94A", accent2: "#7FA6E8" },
    radius: 8,
    ornament: "rules",
    art: { cover: "la-success-illustration", section: "la-building", picture: "la-woman-working-1", closing: "la-working-2" },
    peeps: ["op-peep-84", "op-peep-86", "op-peep-105", "op-peep-53", "op-peep-23"],
    scale: { cover: 116, title: 62, section: 236, statement: 80, numeral: 104, quote: 54 },
  },
  vanta: {
    id: "kit-vanta",
    title: "Vanta Tech Kit",
    tags: ["kit", "tech", "product", "engineering", "dark", "mono", "gradient"],
    styleTags: ["modern", "bold", "dark"],
    rank: 11,
    company: "Nova Systems",
    deck: "Platform review Q3",
    kicker: "// platform review, q3",
    farewell: "// end of transmission",
    display: "Space Grotesk", dw: 700, body: "IBM Plex Sans", bw: 400, mono: "IBM Plex Mono",
    accentFace: "IBM Plex Mono", accentWeight: 500, accentSize: 30,
    paper: { bg: "#0F1526", bg2: "#0A0E1B", ink: "#F1F5F9", muted: "#93A0B8", line: "#243049", panel: "#161E33", panel2: "#1E2842", accent: "#C8F542", accent2: "#8F7BFF" },
    deep: { bg: "#0A0F1F", bg2: "#04060E", ink: "#F1F5F9", muted: "#93A0B8", line: "#1E2840", panel: "#121A2E", panel2: "#1A2440", accent: "#C8F542", accent2: "#8F7BFF" },
    radius: 14,
    ornament: "glow",
    art: { cover: "la-ai-robot-3", section: "il-111-coding", picture: "la-woman-working-2", closing: "la-free-svg-illustrations-robots" },
    peeps: ["op-peep-72", "op-peep-9", "op-peep-56", "op-peep-41", "op-peep-55"],
    scale: { cover: 114, title: 60, section: 220, statement: 76, numeral: 100, quote: 50 },
  },
  folio: {
    id: "kit-folio",
    title: "Folio Editorial Kit",
    tags: ["kit", "editorial", "strategy", "serif", "cream", "magazine", "illustrated"],
    styleTags: ["editorial", "elegant", "warm"],
    rank: 12,
    company: "Meridian Studio",
    deck: "Brand strategy 2027",
    kicker: "Notes from the studio",
    farewell: "Thanks for reading",
    display: "Fraunces", dw: 600, body: "Inter", bw: 400, mono: null,
    accentFace: "Caveat", accentWeight: 600, accentSize: 44,
    paper: { bg: "#F5EFE4", ink: "#1C1A17", muted: "#6B655C", line: "#DACFBE", panel: "#EDE4D4", panel2: "#E3D8C3", accent: "#E0492B", accent2: "#2C6B58", sun: "#F4C15D" },
    deep: { bg: "#221E1A", bg2: "#100E0C", ink: "#F5EFE4", muted: "#B0A798", line: "#3E3831", panel: "#2C2723", panel2: "#38322C", accent: "#F26A48", accent2: "#8CC7AE", sun: "#F4C15D" },
    radius: 0,
    ornament: "hairlines",
    art: { cover: "la-guy-with-glasses", section: "il-day73-writing-tool", picture: "la-doodle", closing: "la-coffee" },
    peeps: ["op-peep-58", "op-peep-47", "op-peep-73", "op-peep-84", "op-peep-86"],
    scale: { cover: 120, title: 66, section: 260, statement: 84, numeral: 108, quote: 56 },
  },
  pulse: {
    id: "kit-pulse",
    title: "Pulse Startup Kit",
    tags: ["kit", "startup", "pitch", "launch", "bold", "coral", "cobalt"],
    styleTags: ["bold", "modern", "playful"],
    rank: 13,
    company: "Loop",
    deck: "Seed round 2026",
    kicker: "Seed round",
    farewell: "Let's build it",
    display: "Sora", dw: 800, body: "Manrope", bw: 500, mono: null,
    accentFace: "Bricolage Grotesque", accentWeight: 800, accentSize: 36,
    paper: { bg: "#FFFFFF", ink: "#0B0B14", muted: "#5B5B70", line: "#E4E4EE", panel: "#F3F3F9", panel2: "#E9E9F4", accent: "#FF4D2E", accent2: "#2B2BFF", lime: "#B9F542" },
    deep: { bg: "#2B2BFF", bg2: "#6A2BFF", ink: "#FFFFFF", muted: "#CFCFFF", line: "#5050FF", panel: "#3A3AFF", panel2: "#4A48FF", accent: "#FF4D2E", accent2: "#B9F542", accentInk: "#B9F542", lime: "#B9F542" },
    radius: 24,
    ornament: "blocks",
    art: { cover: "la-free-svg-illustration-rocket", section: "il-day20-rocket", picture: "la-hero-image-2", closing: "la-scooter" },
    peeps: ["op-peep-105", "op-peep-53", "op-peep-23", "op-peep-72", "op-peep-9"],
    scale: { cover: 122, title: 68, section: 250, statement: 82, numeral: 112, quote: 54 },
  },
  terra: {
    id: "kit-terra",
    title: "Terra Community Kit",
    tags: ["kit", "sustainability", "nonprofit", "community", "warm", "organic", "illustrated"],
    styleTags: ["warm", "friendly", "organic"],
    rank: 14,
    company: "Fernwood Collective",
    deck: "Impact report 2026",
    kicker: "Our year together",
    farewell: "See you out there",
    display: "Outfit", dw: 700, body: "Nunito Sans", bw: 400, mono: null,
    accentFace: "Caveat", accentWeight: 600, accentSize: 46,
    paper: { bg: "#F8F0E3", ink: "#2F2A25", muted: "#786C5F", line: "#DDD0BB", panel: "#EFE4D0", panel2: "#E5D8BF", accent: "#E0703F", accent2: "#5F8F5A", sun: "#F2C063" },
    deep: { bg: "#2F4A36", bg2: "#1D3124", ink: "#F8F0E3", muted: "#BBC9B4", line: "#456249", panel: "#3A5A40", panel2: "#466B4C", accent: "#F2905E", accent2: "#A9D2A0", sun: "#F2C063" },
    radius: 28,
    ornament: "blobs",
    art: { cover: "il-day96-camping", section: "il-day53-farm", picture: "la-house-illustrations", closing: "la-scooter" },
    peeps: ["op-peep-56", "op-peep-41", "op-peep-55", "op-peep-58", "op-peep-47"],
    scale: { cover: 118, title: 64, section: 240, statement: 80, numeral: 108, quote: 54 },
  },
  slate: {
    id: "kit-slate",
    title: "Slate Minimal Kit",
    tags: ["kit", "agency", "portfolio", "proposal", "minimal", "swiss", "monochrome"],
    styleTags: ["minimal", "modern", "clean"],
    rank: 15,
    company: "Form & Function",
    deck: "Studio proposal",
    kicker: "Studio proposal, 2026",
    farewell: "Let's make something",
    display: "Archivo", dw: 700, body: "Archivo", bw: 400, mono: null,
    accentFace: "Space Mono", accentWeight: 400, accentSize: 26,
    paper: { bg: "#FFFFFF", ink: "#111111", muted: "#6B6B6B", line: "#E2E2E2", panel: "#F3F3F3", panel2: "#E9E9E9", accent: "#2F6BFF", accent2: "#111111" },
    deep: { bg: "#181818", bg2: "#070707", ink: "#FFFFFF", muted: "#A0A0A0", line: "#2E2E2E", panel: "#1F1F1F", panel2: "#2A2A2A", accent: "#4D82FF", accent2: "#FFFFFF" },
    radius: 0,
    ornament: "crosshairs",
    art: { cover: "la-working-1", section: "il-day10-canvas-stand", picture: "la-desk-illustration-2", closing: "la-flat-character-illustrations" },
    peeps: ["op-peep-73", "op-peep-84", "op-peep-86", "op-peep-105", "op-peep-53"],
    scale: { cover: 118, title: 60, section: 236, statement: 78, numeral: 104, quote: 52 },
  },
};

export const KITS = Object.values(LOOKS);

// --- primitives --------------------------------------------------------------

export const text = (x, y, w, h, t, o = {}) => ({ kind: "text", x, y, w, h, text: t, ...o });
export const rect = (x, y, w, h, fill, o = {}) => ({ kind: "rect", x, y, w, h, fill, ...o });
export const ellipse = (x, y, w, h, fill, o = {}) => ({ kind: "ellipse", x, y, w, h, fill, ...o });
export const button = (x, y, w, h, label, o = {}) => ({ kind: "button", x, y, w, h, label, ...o });
export const icon = (name, x, y, size, color) => ({ kind: "icon", icon: name, x, y, w: size, h: size, color });
/** A picture slot: a shape the editor fills when a photo is dropped on it. */
export const photo = (x, y, w, h, fill, o = {}) =>
  o.shape === "ellipse" ? { kind: "ellipse", name: "Photo", x, y, w, h, fill } : { kind: "rect", name: "Photo", x, y, w, h, fill, ...(o.radius ? { radius: o.radius } : {}) };
/** A stroked or filled path for a raw slide: points as [x, y] or
 *  { x, y, cIn, cOut } in page space. */
export const path = (points, o = {}) => ({ kind: "path", points, ...o });
/** A drawing from the bundled packs, fitted and centered in the box. */
export const art = (asset, x, y, w, h, o = {}) => ({ asset, x, y, w, h, ...(asset.startsWith("il-") ? { cleanCard: true } : {}), ...o });

export function mixHex(a, b, t) {
  const pa = a.replace("#", ""), pb = b.replace("#", "");
  const ch = (i) => Math.round(parseInt(pa.slice(i, i + 2), 16) * (1 - t) + parseInt(pb.slice(i, i + 2), 16) * t);
  return "#" + [0, 2, 4].map((i) => ch(i).toString(16).padStart(2, "0")).join("");
}

/** Relative luminance below a mid grey. */
export function isDark(hex) {
  const h = hex.replace("#", "");
  const c = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
  return 0.2126 * c(0) + 0.7152 * c(2) + 0.0722 * c(4) < 0.4;
}

/** The ink that reads on a fill: the look's light ink on a dark fill, its
 *  dark ink on a light one. A dark look's paper ink is light too, so the
 *  dark ink falls back to its deepest ground. */
export const inkOn = (K, fill) => {
  const light = isDark(K.deep.ink) ? K.paper.ink : K.deep.ink;
  const dark = isDark(K.paper.ink) ? K.paper.ink : K.deep.bg2;
  return isDark(fill) ? light : dark;
};

/** Type roles for a look on a ground. Each returns the text options only;
 *  the caller supplies the box. */
export function type(K, g) {
  return {
    display: (size, o = {}) => ({ family: K.display, size, weight: K.dw, color: g.ink, lineHeight: 1.06, ...o }),
    body: (size, o = {}) => ({ family: K.body, size, weight: K.bw, color: g.muted, lineHeight: 1.4, ...o }),
    strong: (size, o = {}) => ({ family: K.body, size, weight: K.strongWeight ?? 600, color: g.ink, lineHeight: 1.3, ...o }),
    eyebrow: (o = {}) => ({ family: K.mono ?? K.body, size: 20, weight: 600, color: g.accentInk ?? g.accent, letterSpacing: 4, upper: true, lineHeight: 1.2, ...o }),
    meta: (o = {}) => ({ family: K.mono ?? K.body, size: 18, weight: 500, color: g.muted, lineHeight: 1.3, ...o }),
    numeral: (size, o = {}) => ({ family: K.numeralFace ?? K.display, size, weight: K.numeralWeight ?? K.dw, color: g.accentInk ?? g.accent, lineHeight: 1, ...o }),
    /** The kicker line in the look's accent face: the one voice that is
     *  neither the display nor the body. */
    kicker: (o = {}) => ({ family: K.accentFace, size: K.accentSize, weight: K.accentWeight, color: g.accentInk ?? g.accent, lineHeight: 1.2, ...o }),
  };
}

export const pageNo = (i, total) => `${String(i + 1).padStart(2, "0")} / ${total}`;

/** Estimated width of a line of display type: a conservative average
 *  advance, so a heavy face still fits where the estimate says it does. */
export const estWidth = (str, size, f = 0.56) => str.length * size * f;

/** The size at which every line of `str` (split on newlines) fits `width`,
 *  never below `floor` of the asked size. */
export function fitSize(str, size, width, floor = 0.6, f = 0.56) {
  const longest = Math.max(...str.split("\n").map((l) => estWidth(l, size, f)));
  if (longest <= width) return size;
  return Math.max(size * floor, Math.round(size * width / longest));
}

/** Lines a run of text takes at a size in a width. */
export const linesFor = (str, size, width, f = 0.56) => str.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(estWidth(l, size, f) / width)), 0);

/** The deep pages' ground: a gradient from bg to bg2, darker toward the
 *  bottom right. */
export const deepGround = (g) => ({ angle: 160, stops: [[g.bg, 0], [g.bg2, 1]] });

// --- ornaments ---------------------------------------------------------------

/** Two concentric discs of the accent behind a hero drawing, the way a flyer
 *  lights its subject. */
export function halo(cx, cy, size, color) {
  return [
    ellipse(cx - size / 2, cy - size / 2, size, size, color, { opacity: 0.12, bleed: true }),
    ellipse(cx - size * 0.4, cy - size * 0.4, size * 0.8, size * 0.8, color, { opacity: 0.16, bleed: true }),
  ];
}

/** A scatter of small dots at varied opacity, deterministic per seed. */
export function sparkles(color, seed, n = 7, box = { x: 1180, y: 0, w: W - 1180, h: H - 120 }) {
  let s = seed * 9301 + 49297;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const out = [];
  for (let k = 0; k < n; k++) {
    const d = 4 + Math.round(rnd() * 5);
    out.push(ellipse(Math.round(box.x + rnd() * (box.w - d)), Math.round(box.y + rnd() * (box.h - d)), d, d, color, { opacity: 0.35 + Math.round(rnd() * 45) / 100 }));
  }
  return out;
}

/** Small rotated strips in the look's second colours, the confetti a bold
 *  look throws around its hero. */
export function confetti(colors, seed, n = 6, box = { x: 0, y: 0, w: W, h: H }) {
  let s = seed * 7919 + 104729;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const out = [];
  for (let k = 0; k < n; k++) {
    const w = 22 + Math.round(rnd() * 26), h = 8 + Math.round(rnd() * 6);
    out.push(rect(Math.round(box.x + rnd() * (box.w - w)), Math.round(box.y + rnd() * (box.h - h)), w, h, colors[k % colors.length], { rotation: Math.round(-40 + rnd() * 80), radius: 3 }));
  }
  return out;
}

/** A square rotated 45 degrees about its top-left corner and placed off the
 *  page so that exactly one edge crosses the top right corner: the visible
 *  part is the triangle (W - t, 0), (W, 0), (W, t). */
function cornerTriangle(color, t, opacity) {
  const e = Math.round(t * 0.4);
  const side = Math.round((t + 2 * e) * Math.SQRT2);
  return rect(W + e, -t - 3 * e, side, side, color, { rotation: 45, opacity, bleed: true });
}

function crosshairs(color, opacity) {
  const out = [];
  for (const [cx, cy] of [[48, 48], [W - 48, 48], [48, H - 48], [W - 48, H - 48]]) {
    out.push(rect(cx - 12, cy - 1, 24, 2, color, { opacity }), rect(cx - 1, cy - 12, 2, 24, color, { opacity }));
  }
  return out;
}

/** The look's signature marks on a deep page (cover, section, closing). */
export function ornamentDeep(K, g, opts = {}) {
  switch (K.ornament) {
    case "rules":
      return [rect(40, 40, W - 80, H - 80, undefined, { stroke: g.accent, strokeWidth: 1.5, opacity: 0.7 }), ...sparkles(g.accent, 3, 8, { x: 1100, y: 60, w: 760, h: 860 })];
    case "glow":
      return [
        ellipse(1380, -420, 1100, 1100, { angle: 135, stops: [[g.accent2, 0], [g.bg2, 1]], radial: true }, { opacity: 0.6, bleed: true }),
        ellipse(-380, 620, 900, 900, { angle: 135, stops: [[g.accent, 0], [g.bg2, 1]], radial: true }, { opacity: 0.26, bleed: true }),
        ...[320, 640, 960, 1280, 1600].map((x) => rect(x, 0, 1, H, g.ink, { opacity: 0.06 })),
        ...[270, 540, 810].map((y) => rect(0, y, W, 1, g.ink, { opacity: 0.06 })),
        ...sparkles(g.accent, 5, 6),
        ...sparkles(g.accent2, 6, 5),
      ];
    case "hairlines":
      return [
        ellipse(1560, -180, 520, 520, g.sun, { bleed: true, opacity: 0.9 }),
        rect(M, 64, CW, 2, g.ink), rect(M, H - 66, CW, 2, g.ink),
        ...(opts.mark ? [] : [rect(M, 84, 14, 14, g.accent)]),
      ];
    case "blocks":
      return [];
    case "blobs":
      return [
        ellipse(1480, -260, 760, 760, g.accent2, { opacity: 0.4, bleed: true }),
        ellipse(-200, 720, 560, 560, g.accent, { opacity: 0.35, bleed: true }),
        ellipse(1720, 720, 300, 300, g.sun, { opacity: 0.6, bleed: true }),
        ...sparkles(g.ink, 9, 7),
      ];
    case "crosshairs":
      return [
        ellipse(1180, -300, 1200, 1200, { angle: 135, stops: [[g.accent, 0], [g.bg2, 1]], radial: true }, { opacity: 0.35, bleed: true }),
        ...crosshairs(g.ink, 0.7),
      ];
    case "watermark":
      // One enormous glyph in a tint of the ground, bottom right: the
      // editorial deck's monogram.
      return [text(1160, 420, 760, 700, K.watermark ?? "&", { family: K.display, size: 620, weight: 500, color: mixHex(g.bg, g.ink, 0.08), align: "right", lineHeight: 1, bleed: true }), rect(M, 64, CW, 2, g.line)];
    case "sun":
      return [ellipse(1620, -120, 300, 300, g.sun, { bleed: true, opacity: 0.95 }), ...sparkles(g.sun, 13, 7, { x: 1100, y: 0, w: 820, h: 700 })];
    case "ridges":
      // Soft ridgelines along the bottom, a moon and two layers of stars.
      return [
        ellipse(-300, 860, 1100, 700, mixHex(g.bg, g.bg2, 0.6), { bleed: true }),
        ellipse(500, 900, 1300, 700, mixHex(g.bg, g.ink, 0.06), { bleed: true }),
        ellipse(1400, 880, 1100, 700, mixHex(g.bg, g.bg2, 0.6), { bleed: true }),
        ellipse(1500, 80, 120, 120, g.accent, { opacity: 0.9 }), ellipse(1470, 60, 120, 120, g.bg, { opacity: 0.85 }),
        ...sparkles(g.accent, 7, 10, { x: 1100, y: 0, w: 820, h: 620 }), ...sparkles(g.ink, 11, 8, { x: 1100, y: 0, w: 820, h: 620 }),
      ];
    case "arcs":
      // Concentric rings off the top right corner.
      return [1400, 1100, 800, 500].map((d, k) => ellipse(1920 - d / 2 - 120, -d / 2 + 80, d, d, undefined, { stroke: g.accent, strokeWidth: 2, opacity: 0.22 + k * 0.08, bleed: true }));
    case "dots": {
      // A dot grid over the right third, fading nothing: texture, not pattern.
      const out = [];
      for (let r = 0; r < 9; r++) for (let c = 0; c < 7; c++) out.push(ellipse(1320 + c * 88, 96 + r * 88, 6, 6, g.ink, { opacity: 0.16 }));
      return [...out, ...sparkles(g.accent, 17, 5, { x: 1180, y: 60, w: 680, h: 820 })];
    }
    case "stripes":
      // Three diagonal bands in tints of the accent, behind everything.
      return [0, 1, 2].map((k) => rect(1180 + k * 190, -300, 90, 1700, g.accent, { rotation: 24, opacity: 0.1 + k * 0.05, bleed: true }));
    case "orbs":
      // Floating discs in the two accents, the bold look's weather.
      return [
        ellipse(1500, 120, 260, 260, g.accent, { opacity: 0.9 }), ellipse(1700, 420, 140, 140, g.accent2, { opacity: 0.9 }),
        ellipse(1380, 760, 90, 90, g.accent2, { opacity: 0.7 }), ellipse(1040, 40, 110, 110, g.accent, { opacity: 0.35 }),
        ...sparkles(g.ink, 19, 6),
      ];
    case "corner":
      // One triangle of the accent in the top right corner. Rotation is about
      // a node's top-left corner, so the square is placed off the page such
      // that the one edge crossing the corner runs from (1460, 0) to (1920, 460).
      return [cornerTriangle(g.accent, 460, 0.92), ...sparkles(g.ink, 23, 6, { x: 1150, y: 540, w: 700, h: 330 })];
    default:
      return [];
  }
}

/** The look's quieter marks on a reading page. */
export function ornamentPaper(K, g) {
  switch (K.ornament) {
    case "glow":
      return [
        ellipse(1500, -520, 1000, 1000, { angle: 135, stops: [[g.accent2, 0], [g.bg2 ?? g.bg, 1]], radial: true }, { opacity: 0.3, bleed: true }),
        ...[320, 640, 960, 1280, 1600].map((x) => rect(x, 0, 1, H, g.ink, { opacity: 0.045 })),
      ];
    case "hairlines":
      return [rect(M, 64, CW, 2, g.ink), ellipse(1770, -110, 220, 220, g.sun, { bleed: true })];
    case "crosshairs":
      return crosshairs(g.line, 1);
    case "blobs":
      return [ellipse(1700, -180, 380, 380, g.accent2, { opacity: 0.22, bleed: true })];
    case "blocks":
      return [rect(W - 14, 0, 14, H, g.accent2)];
    case "rules":
      return [rect(M, 76, 56, 3, g.accent)];
    case "watermark":
      return [text(1160, 420, 760, 700, K.watermark ?? "&", { family: K.display, size: 620, weight: 500, color: mixHex(g.bg, g.ink, 0.05), align: "right", lineHeight: 1, bleed: true }), rect(M, 64, CW, 2, g.line)];
    case "sun":
      return [ellipse(1740, -140, 260, 260, g.sun, { bleed: true, opacity: 0.9 })];
    case "ridges":
      return [ellipse(1720, -160, 340, 340, mixHex(g.bg, g.accent, 0.18), { bleed: true })];
    case "arcs":
      return [760, 520].map((d, k) => ellipse(1920 - d / 2 - 120, -d / 2 + 60, d, d, undefined, { stroke: g.accent, strokeWidth: 2, opacity: 0.18 + k * 0.08, bleed: true }));
    case "dots": {
      const out = [];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 6; c++) out.push(ellipse(1360 + c * 80, 40 + r * 80, 5, 5, g.ink, { opacity: 0.14 }));
      return out;
    }
    case "stripes":
      return [rect(1700, -300, 60, 1700, g.accent, { rotation: 24, opacity: 0.08, bleed: true })];
    case "orbs":
      return [ellipse(1760, -80, 200, 200, g.accent, { opacity: 0.85, bleed: true }), ellipse(1660, 140, 60, 60, g.accent2, { opacity: 0.8 })];
    case "corner":
      return [cornerTriangle(g.accent, 300, 0.9)];
    default:
      return [];
  }
}

// --- chrome ------------------------------------------------------------------

/** Eyebrow, title and footer of a reading page; returns the nodes and the y
 *  the body starts at. */
export function chrome(K, g, i, eyebrow, title, opts = {}) {
  const t = type(K, g);
  const width = opts.titleWidth ?? 1240;
  const asked = opts.titleSize ?? K.scale.title;
  // A title that does not fit one line steps down to four fifths; one that
  // still does not fit wraps to two lines at that size, and the body starts
  // lower. The copy is never clipped and never runs into the body.
  const cw = K.charWidth ?? 0.56;
  let size = fitSize(title, asked, width, 0.8, cw);
  let lines = opts.titleLines ?? 1;
  if (lines === 1 && estWidth(title, size, cw) > width) { size = Math.round(asked * 0.82); lines = 2; }
  const titleY = K.ornament === "hairlines" ? 132 : 124;
  const nodes = [
    ...ornamentPaper(K, g),
    text(M, titleY - 36, 1200, 28, eyebrow, t.eyebrow()),
    text(M, titleY, width, Math.round(size * 1.1 * lines) + 8, title, t.display(size)),
    ...footer(K, g, i),
  ];
  return { nodes, bodyTop: titleY + Math.round(size * 1.1 * lines) + 52 };
}

export function footer(K, g, i) {
  const t = type(K, g);
  const y = K.ornament === "hairlines" ? H - 50 : 992;
  return [
    ...(K.ornament === "hairlines" ? [] : [rect(M, 968, CW, 1, g.line)]),
    text(M, y, 900, 26, `${K.company}  ·  ${K.deck}`, t.meta()),
    ...(K.total > 1 ? [text(W - M - 240, y, 240, 26, pageNo(i, K.total), t.meta({ align: "right" }))] : []),
  ];
}

/** A slide's hand note in the accent face: bottom right on a reading page
 *  (above the footer rule), under the picture on a deep page. */
export function note(K, g, str, deep = false, at = null) {
  if (!str) return [];
  const t = type(K, g);
  const sz = Math.round(K.accentSize * (deep ? 0.85 : 0.8));
  const cw = K.charWidth ?? 0.56;
  if (at) {
    const aw = at.w ?? 720;
    const al = Math.min(2, linesFor(str, at.size ?? sz, aw, cw));
    return [text(at.x, at.y, aw, Math.round((at.size ?? sz) * 1.25 * al), str, t.kicker({ align: at.align ?? "center", size: at.size ?? sz }))];
  }
  const w = deep ? 720 : 760;
  const lines = Math.min(2, linesFor(str, sz, w, cw));
  const h = Math.round(sz * 1.25 * lines);
  return deep
    ? [text(1140, 872 + 52 - h, w, h, str, t.kicker({ align: "center", size: sz }))]
    : [text(W - M - w, 908 + 48 - h, w, h, str, t.kicker({ align: "right", size: sz }))];
}

/** A card: the look's panel with a hairline stroke, in the look's radius. */
export const card = (K, g, x, y, w, h, o = {}) => rect(x, y, w, h, o.fill ?? g.panel, { radius: K.radius, stroke: o.stroke ?? g.line, strokeWidth: o.strokeWidth ?? 1.5, ...(o.opacity ? { opacity: o.opacity } : {}) });

/** The company mark, top-left of an impact page. */
export function mark(K, g, y = M) {
  const t = type(K, g);
  return [rect(M, y, 22, 22, g.accent, { radius: K.radius ? 6 : 0 }), text(M + 36, y - 3, 700, 30, K.company, t.strong(22))];
}

// --- layouts -----------------------------------------------------------------
// Each takes the look (with deck meta merged in), the page index, and the
// content for the slide; every content field has the kit's sample as its
// default, so a layout with no content is the kit's own slide.

const SAMPLE = {
  cover: {
    title: "Built for the\nlong run",
    subtitle: "A year of steady growth, and the plan that carries it into the next decade.",
    presenter: "Dana Whitfield, Managing Partner  ·  14 October 2026",
    presenterName: "Dana Whitfield",
    when: "14 October 2026",
    where: "Studio, level 4",
    chips: [["99.98%", "uptime"], ["4.6 / day", "deploys"], ["−38%", "p95 latency"]],
    year: "2026",
  },
  agenda: {
    eyebrow: "Agenda", title: "What we will cover today",
    items: [
      ["Where we stand", "Results, retention and the numbers behind them", "10 min"],
      ["What we learned", "Three findings that change the plan", "15 min"],
      ["The plan for next year", "Priorities, sequencing and owners", "20 min"],
      ["What it takes", "Budget, hiring and the risks we carry", "10 min"],
      ["Decisions we need", "Three questions for this room", "5 min"],
    ],
    card: { eyebrow: "Today", big: "14 Oct", meta: [["Time", "09:30 to 10:30"], ["Room", "Boardroom, level 4"], ["Host", "Dana Whitfield"], ["Notes", "Shared after the session"]] },
  },
  section: { n: "02", title: "What we learned", blurb: "Three findings from the year that change how we plan the next one." },
  statement: { text: "Growth that we can explain is the only kind we want to keep.", source: "Dana Whitfield, in the FY2026 letter to partners" },
  textPicture: {
    eyebrow: "Where we stand", title: "Three things the year proved",
    points: [
      ["Retention leads growth", "Net revenue retention held above 118% in every quarter, before any new logo."],
      ["The mid-market is ours", "Deals between 200 and 2,000 seats closed twice as fast as a year ago."],
      ["Partners now bring a third of pipeline", "Referred deals close at higher values and churn less."],
    ],
  },
  twoColumns: {
    eyebrow: "What we learned", title: "Before and after the change",
    left: { eyebrow: "Before", head: "Every team ran its own playbook", lines: ["Four onboarding flows, none shared", "Handoffs lost a day at every step", "Nobody owned the number"], icon: "alert-triangle" },
    right: { eyebrow: "After", head: "One playbook, one owner", lines: ["A single flow every team adopts", "Handoffs measured and cut to hours", "One dashboard, one accountable lead"], icon: "circle-check" },
  },
  threeCards: {
    eyebrow: "The plan", title: "Three priorities for the year",
    cards: [
      ["flag", "Win the mid-market", "Double the segment team and ship the two integrations every deal asks for."],
      ["shield", "Earn the enterprise", "Certifications, regional residency and a support tier that answers in an hour."],
      ["sparkles", "Make the product sell itself", "A free tier that grows into paid on its own, measured weekly."],
    ],
  },
  figures: {
    eyebrow: "Results", title: "The year in four numbers",
    stats: [
      ["$48.2M", "Annual recurring revenue", "+31% year over year", "Up from $36.8M, with expansion ahead of new business for the first time."],
      ["118%", "Net revenue retention", "+6 pts", "Held above target in every quarter; enterprise accounts led."],
      ["1,240", "Customers", "+280 net new", "Mid-market grew fastest; churn fell to 4.1% on the year."],
      ["19", "Months of runway", "Plan holds", "Before the round, at the current burn and the current plan."],
    ],
  },
  chart: {
    eyebrow: "Results", title: "Revenue by quarter",
    takeaway: "Expansion overtook new business in Q2 and has led every quarter since.",
    chartType: "barGrouped",
    categories: ["Q1", "Q2", "Q3", "Q4"],
    series: [{ name: "New business", values: [2.1, 2.4, 2.6, 3.0] }, { name: "Expansion", values: [1.8, 2.7, 3.4, 4.2] }],
    calls: [["$4.2M", "Expansion revenue in Q4, a record"], ["58%", "Share of Q4 growth from existing customers"], ["3 of 4", "Quarters where expansion led"]],
  },
  timeline: {
    eyebrow: "The plan", title: "The road to next October", done: 2,
    steps: [
      ["Q1", "Foundations", "Segment team hired, the two integrations shipped, pricing page rebuilt."],
      ["Q2", "Enterprise ready", "Certifications complete, EU residency live, one-hour support tier launched."],
      ["Q3", "Self-serve growth", "Free tier public, conversion measured weekly, first paid upgrades on their own."],
      ["Q4", "Scale what works", "Double down on the channel that grew, cut the ones that did not."],
    ],
  },
  process: {
    eyebrow: "How it works", title: "From first call to live",
    steps: [
      ["Discover", "A 45-minute call maps your workflow and the numbers you care about."],
      ["Pilot", "One team, two weeks, your real data. We measure against the baseline."],
      ["Roll out", "Every team onboarded in waves, with a named lead on each side."],
      ["Review", "A quarterly session on the numbers, and the plan for the next one."],
    ],
  },
  table: {
    eyebrow: "Options", title: "How the plans compare",
    cols: ["", "Starter", "Team", "Enterprise"],
    rows: [
      ["Seats included", "5", "25", "Unlimited"],
      ["Shared workspaces", "yes", "yes", "yes"],
      ["Brand kits", "no", "yes", "yes"],
      ["Single sign-on", "no", "no", "yes"],
      ["Support response", "2 days", "1 day", "1 hour"],
    ],
  },
  team: {
    eyebrow: "Who we are", title: "The people behind the plan",
    people: [
      ["Dana Whitfield", "Managing Partner", "Twenty years across three funds; leads the portfolio."],
      ["Marcus Obi", "Chief Operating Officer", "Built the operating model every team now runs on."],
      ["Priya Raman", "Head of Product", "Owns the roadmap and the free tier that feeds it."],
      ["Elena Sato", "Head of Customers", "Retention, expansion and the partners who bring both."],
    ],
  },
  quote: { text: "They did not sell us software. They showed us the number we were losing every week, and then made it stop.", name: "Rowan Achebe", role: "Chief Financial Officer, Brightline Logistics" },
  pricing: {
    eyebrow: "Options", title: "Pick the plan that fits",
    tiers: [
      ["Starter", "$29", "per seat, per month", ["5 seats", "Shared workspaces", "Community support", "Export to PDF"], false],
      ["Team", "$59", "per seat, per month", ["25 seats", "Brand kits and templates", "Priority support", "Version history"], true],
      ["Enterprise", "Custom", "annual agreement", ["Unlimited seats", "Single sign-on", "One-hour response", "Dedicated success lead"], false],
    ],
    hotLabel: "Most chosen", hotCta: "Start with Team", ctaPrefix: "Choose ",
  },
  closing: {
    title: "Thank you",
    subtitle: "Questions now, or any time this week. The deck and the model are in the shared folder.",
    rows: [["mail", "dana@halcyon.example"], ["world", "halcyon.example"], ["phone", "+1 415 555 0142"]],
    cta: "Book a follow-up",
  },
};

const withDefaults = (name, c) => ({ ...SAMPLE[name], ...(c ?? {}) });

export function cover(K, i, c0) {
  const c = withDefaults("cover", c0);
  const g = K.deep;
  const t = type(K, g);
  const fill = [];
  const nodes = [...ornamentDeep(K, g, { mark: true })];
  const illustrations = [];
  const centered = K.ornament === "hairlines";
  nodes.push(...mark(K, g));
  fill.push({ node: nodes.length - 1, label: "Company", hint: "Your company or team name" });
  const textW = 1000;
  const coverSize = fitSize(c.title, K.scale.cover, centered ? 1500 : textW, 0.6, K.charWidth ?? 0.56);
  const coverLines = c.title.split("\n").length;
  const titleH = Math.round(coverSize * 1.05 * coverLines) + 10;
  if (centered) {
    // The flyer's composition: the drawing in its halo above a centered title.
    nodes.push(...halo(W / 2, 330, 400, g.accent));
    illustrations.push(art(c.art ?? K.art.cover, W / 2 - 170, 190, 340, 280));
    nodes.push(text(M, 500, CW, 56, K.kicker, t.kicker({ align: "center" })));
    nodes.push(text(M, 560, CW, titleH, c.title, t.display(coverSize, { lineHeight: 1.02, align: "center" })));
    fill.push({ node: nodes.length - 1, label: "Title", hint: "Two short lines" });
    nodes.push(text(W / 2 - 500, 560 + titleH + 24, 1000, 80, c.subtitle, t.body(26, { align: "center" })));
    fill.push({ node: nodes.length - 1, label: "Subtitle", hint: "One sentence on what the deck covers" });
    // A meta row with dividers, the way an event flyer lists when and where.
    const rowY = 900;
    const cols = [["Presented by", c.presenterName], ["When", c.when], ["Where", c.where]];
    cols.forEach(([l, v], k) => {
      const x = W / 2 - 660 + k * 440;
      nodes.push(text(x, rowY, 440, 24, l, t.eyebrow({ align: "center", size: 15 })));
      nodes.push(text(x, rowY + 30, 440, 34, v, t.strong(24, { align: "center" })));
      if (k > 0) nodes.push(rect(x - 1, rowY + 4, 1, 60, g.line));
    });
    fill.push({ node: nodes.length - 4, label: "Presenter", hint: "Who presents" });
    if (K.total > 1) nodes.push(text(W - M - 240, H - 50, 240, 28, pageNo(i, K.total), t.meta({ align: "right" })));
    nodes.push(...note(K, g, c.note, true, { x: W / 2 - 360, y: 800, w: 720 }));
    return { page: { name: "Cover", bg: deepGround(g), nodes, illustrations }, fill };
  }
  nodes.push(text(M, 372, textW, Math.round(K.accentSize * 1.3), K.kicker, t.kicker()));
  nodes.push(text(M, 446, textW, titleH, c.title, t.display(coverSize, { lineHeight: 1.02 })));
  fill.push({ node: nodes.length - 1, label: "Title", hint: "Two short lines" });
  const subLines = Math.max(2, linesFor(c.subtitle, 28, 900, K.charWidth ?? 0.56));
  nodes.push(text(M, 446 + titleH + 30, 900, subLines * 40, c.subtitle, t.body(28)));
  fill.push({ node: nodes.length - 1, label: "Subtitle", hint: "One sentence on what the deck covers" });
  const presenterLine = c0?.presenter ?? (c0?.presenterName ? [c0.presenterName, c0.when].filter(Boolean).join("  ·  ") : c.presenter);
  nodes.push(text(M, 940, 900, 28, presenterLine, t.meta()));
  fill.push({ node: nodes.length - 1, label: "Presenter and date", hint: "Who presents, and when" });
  if (K.total > 1) nodes.push(text(W - M - 240, 940, 240, 28, pageNo(i, K.total), t.meta({ align: "right" })));
  // The hero: a full-colour drawing in a halo, per look. Chips of figures
  // under the subtitle for the glow look, or for any look that asks.
  const coverArt = c.art ?? K.art.cover;
  const chips = c0?.chips ?? (K.ornament === "glow" ? c.chips : null);
  if (chips) {
    chips.forEach(([n, l], k) => {
      const x = M + k * 300;
      nodes.push(rect(x, 848, 276, 64, g.panel, { radius: K.radius, stroke: g.line, strokeWidth: 1.5 }));
      nodes.push(text(x + 20, 860, 130, 40, n, t.numeral(26, { family: K.mono ?? K.numeralFace ?? K.display })));
      nodes.push(text(x + 150, 868, 110, 26, l, t.meta({ size: 16 })));
    });
  }
  switch (K.ornament) {
    case "blocks":
      nodes.push(rect(1272, 0, 648, H, g.accent, { bleed: true }));
      nodes.push(ellipse(1316, 260, 560, 560, g.ink, { opacity: 0.18 }));
      nodes.push(...confetti([g.lime, g.ink, g.bg], 4, 8, { x: 1290, y: 80, w: 610, h: 920 }));
      nodes.push(text(1330, 96, 500, 48, c.year, t.display(40, { align: "right" })));
      illustrations.push(art(coverArt, 1336, 300, 520, 480));
      break;
    case "glow":
      nodes.push(...halo(1500, 470, 640, g.accent));
      illustrations.push(art(coverArt, 1230, 200, 540, 540));
      break;
    case "blobs":
      nodes.push(ellipse(1180, 200, 660, 660, g.panel2));
      nodes.push(...halo(1510, 530, 700, g.sun));
      illustrations.push(art(coverArt, 1230, 240, 560, 580));
      break;
    case "crosshairs":
      nodes.push(rect(1176, 0, 744, H, g.panel, { bleed: true }));
      nodes.push(rect(1176, 0, 4, H, g.accent));
      nodes.push(...halo(1548, 540, 620, g.accent));
      illustrations.push(art(coverArt, 1260, 260, 580, 560));
      break;
    default:
      nodes.push(...halo(1500, 520, 700, g.accent));
      illustrations.push(art(coverArt, 1210, 230, 580, 580));
      break;
  }
  nodes.push(...note(K, g, c.note, true));
  return { page: { name: "Cover", bg: deepGround(g), nodes, illustrations }, fill };
}

export function agenda(K, i, c0) {
  const c = withDefaults("agenda", c0);
  const g = K.paper;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
  const rowH = 118;
  const y0 = bodyTop;
  c.items.forEach(([h, s, d], k) => {
    const y = y0 + k * rowH;
    nodes.push(text(M, y + 6, 96, 60, String(k + 1).padStart(2, "0"), t.numeral(44)));
    nodes.push(text(M + 120, y + 4, 900, 44, h, t.display(34)));
    nodes.push(text(M + 120, y + 50, 900, 30, s, t.body(21)));
    nodes.push(button(M + 1040, y + 8, 160, 34, d, { fill: mixHex(g.panel, g.accent, 0.16), color: g.accentInk ?? g.accent, family: K.body, size: 15, weight: 700 }));
    nodes.push(rect(M, y + rowH - 12, 1204, 1, g.line));
  });
  // The session card, on the look's deep ground.
  const d = K.deep;
  const td = type(K, d);
  const cx = 1396, cy = bodyTop, cw = 428, ch = 560;
  nodes.push(rect(cx, cy, cw, ch, deepGround(d), { radius: K.radius }));
  nodes.push(rect(cx, cy, cw, 6, d.accent, { radius: 0 }));
  nodes.push(text(cx + 40, cy + 40, cw - 80, 28, c.card.eyebrow, td.eyebrow()));
  nodes.push(text(cx + 40, cy + 80, cw - 80, 120, c.card.big, td.display(76)));
  c.card.meta.forEach(([l, v], k) => {
    const my = cy + 236 + k * 74;
    nodes.push(text(cx + 40, my, 120, 26, l, td.meta()));
    nodes.push(text(cx + 40, my + 28, cw - 80, 30, v, td.strong(22)));
    if (k < c.card.meta.length - 1) nodes.push(rect(cx + 40, my + 64, cw - 80, 1, d.line));
  });
  nodes.push(...note(K, g, c.note));
  return { page: { name: "Agenda", bg: g.bg, nodes } };
}

export function section(K, i, c0) {
  const c = withDefaults("section", c0);
  const g = K.deep;
  const t = type(K, g);
  const nodes = [...ornamentDeep(K, g)];
  const illustrations = [];
  const drawing = c.art ?? K.art.section;
  if (K.ornament === "blocks") {
    nodes.push(rect(0, 0, 360, H, g.accent, { bleed: true }));
    nodes.push(text(48, 300, 300, 260, c.n, t.display(K.scale.section, { color: g.ink, align: "left" })));
    nodes.push(text(460, 340, 1000, 50, K.kicker, t.kicker()));
    nodes.push(text(460, 400, 1000, 240, c.title, t.display(96, { lineHeight: 1.04 })));
    nodes.push(text(460, 680, 900, 90, c.blurb, t.body(28)));
    nodes.push(...confetti([g.lime, g.accent, g.ink], 8, 6, { x: 1380, y: 120, w: 480, h: 840 }));
    illustrations.push(art(drawing, 1400, 300, 440, 440));
  } else {
    // No numeral when the plan passes an empty n: the rule and title move up.
    const top = c.n ? 236 + K.scale.section + 20 : 330;
    if (c.n) nodes.push(text(M, 236, 800, K.scale.section + 20, c.n, t.numeral(K.scale.section)));
    nodes.push(rect(M, top, 120, 4, g.accent));
    const tl = Math.max(1, Math.min(2, linesFor(c.title, 96, 1100, K.charWidth ?? 0.56)));
    nodes.push(text(M, top + 28, 1100, Math.round(96 * 1.04 * tl) + 12, c.title, t.display(96, { lineHeight: 1.04 })));
    nodes.push(text(M, top + 28 + Math.round(96 * 1.04 * tl) + 32, 900, 90, c.blurb, t.body(28)));
    nodes.push(...halo(1520, 560, 560, g.accent));
    illustrations.push(c.wide ? art(drawing, 1200, 380, 640, 400) : art(drawing, 1300, 340, 440, 440));
    nodes.push(text(M, 180, 1000, 50, c.kicker ?? K.kicker, t.kicker()));
  }
  nodes.push(...footer(K, g, i));
  nodes.push(...note(K, g, c.note, true));
  return { page: { name: "Section", bg: deepGround(g), nodes, illustrations } };
}

export function statement(K, i, c0) {
  const c = withDefaults("statement", c0);
  const g = K.paper;
  const t = type(K, g);
  const nodes = [...ornamentPaper(K, g), ...footer(K, g, i)];
  const kh = Math.round(K.accentSize * 1.3);
  nodes.push(text(M, 236, 1000, kh, K.kicker, t.kicker()));
  nodes.push(rect(M, 236 + kh + 14, 120, 6, g.accent));
  const y = 236 + kh + 60;
  // Long copy steps the size down until it holds in three lines.
  let size = K.scale.statement;
  while (size > K.scale.statement * 0.6 && linesFor(c.text, size, 1560, K.charWidth ?? 0.56) > 3) size -= 4;
  nodes.push(text(M, y, 1560, Math.round(size * 1.12 * 3) + 10, c.text, t.display(size, { lineHeight: 1.1 })));
  nodes.push(text(M, y + Math.round(size * 1.12 * 3) + 50, 1000, 32, c.source, t.meta()));
  nodes.push(...note(K, g, c.note));
  return { page: { name: "Statement", bg: g.bg, nodes } };
}

export function textPicture(K, i, c0) {
  const c = withDefaults("textPicture", c0);
  const g = K.paper;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title, { titleWidth: 960 });
  c.points.forEach(([h, s], k) => {
    const y = bodyTop + 24 + k * 178;
    nodes.push(ellipse(M, y + 4, 34, 34, mixHex(g.panel, g.accent, 0.18)));
    nodes.push(text(M, y + 4, 34, 34, String(k + 1), { family: K.display, size: 17, weight: K.dw, color: g.accentInk ?? g.accent, align: "center", vAlign: "middle", lineHeight: 1 }));
    nodes.push(text(M + 56, y, 840, 44, h, t.display(32)));
    nodes.push(text(M + 56, y + 52, 840, 70, s, t.body(22)));
  });
  // The picture slot: a tinted shape (drop a photo on it) with a drawing on it.
  nodes.push(photo(1080, 196, 744, 690, { angle: 160, stops: [[mixHex(g.panel, g.accent2, 0.22), 0], [g.panel, 1]] }, { radius: K.radius * 1.5 }));
  nodes.push(...halo(1452, 541, 500, g.accent));
  const illustrations = [art(c.art ?? K.art.picture, 1160, 270, 584, 540)];
  nodes.push(...note(K, g, c.note));
  return { page: { name: "Text and picture", bg: g.bg, nodes, illustrations } };
}

export function twoColumns(K, i, c0) {
  const c = withDefaults("twoColumns", c0);
  const g = K.paper;
  const d = K.deep;
  const t = type(K, g);
  const td = type(K, d);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
  const colW = (CW - 32) / 2;
  const y = bodyTop;
  const h = 600;
  const cols = [
    { x: M, g, ty: t, ...c.left },
    { x: M + colW + 32, g: d, ty: td, ...c.right },
  ];
  cols.forEach((col) => {
    if (col.g === g) nodes.push(card(K, g, col.x, y, colW, h));
    else nodes.push(rect(col.x, y, colW, h, deepGround(d), { radius: K.radius }));
    nodes.push(icon(col.icon, col.x + colW - 88, y + 44, 40, col.g.accentInk ?? col.g.accent));
    nodes.push(text(col.x + 48, y + 48, colW - 160, 28, col.eyebrow, col.ty.eyebrow()));
    nodes.push(text(col.x + 48, y + 92, colW - 96, 112, col.head, col.ty.display(40, { lineHeight: 1.1 })));
    col.lines.forEach((l, k) => {
      const ly = y + 260 + k * 100;
      nodes.push(rect(col.x + 48, ly, colW - 96, 1, col.g.line));
      nodes.push(text(col.x + 48, ly + 24, colW - 96, 40, l, col.ty.strong(24)));
    });
  });
  nodes.push(...note(K, g, c.note));
  return { page: { name: "Two columns", bg: g.bg, nodes } };
}

export function threeCards(K, i, c0) {
  const c = withDefaults("threeCards", c0);
  const g = K.paper;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
  const cw = (CW - 48) / 3;
  const y = bodyTop;
  const h = 580;
  const tones = [g.accent, g.accent2, g.accent];
  c.cards.forEach(([ic, head, body], k) => {
    const x = M + k * (cw + 24);
    nodes.push(card(K, g, x, y, cw, h));
    nodes.push(rect(x, y, cw, 6, tones[k], { radius: 0 }));
    nodes.push(ellipse(x + 40, y + 48, 80, 80, mixHex(g.panel, tones[k], 0.2)));
    nodes.push(icon(ic, x + 60, y + 68, 40, k % 2 ? (g.accent2Ink ?? g.accent2) : (g.accentInk ?? g.accent)));
    nodes.push(text(x + 40, y + 164, cw - 80, 100, head, t.display(34, { lineHeight: 1.1 })));
    nodes.push(text(x + 40, y + 276, cw - 80, 160, body, t.body(22)));
    nodes.push(rect(x + 40, y + h - 84, cw - 80, 1, g.line));
    nodes.push(text(x + 40, y + h - 60, 120, 28, String(k + 1).padStart(2, "0"), t.meta()));
  });
  nodes.push(...note(K, g, c.note));
  return { page: { name: "Three cards", bg: g.bg, nodes } };
}

export function figures(K, i, c0) {
  const c = withDefaults("figures", c0);
  const g = K.paper;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
  const cw = (CW - 72) / 4;
  const y = bodyTop;
  const h = 560;
  c.stats.forEach(([n, l, d, note], k) => {
    const x = M + k * (cw + 24);
    const tone = k % 2 ? g.accent2 : g.accent;
    nodes.push(card(K, g, x, y, cw, h));
    nodes.push(rect(x, y, cw, 6, tone, { radius: 0 }));
    nodes.push(text(x + 36, y + 56, cw - 72, K.scale.numeral + 16, n, t.numeral(K.scale.numeral * (n.length > 5 ? 0.8 : 1), { color: k % 2 ? (g.accent2Ink ?? g.accent2) : (g.accentInk ?? g.accent) })));
    nodes.push(text(x + 36, y + 196, cw - 72, 34, l, t.strong(24)));
    const toneInk = k % 2 ? (g.accent2Ink ?? g.accent2) : (g.accentInk ?? g.accent);
    nodes.push(button(x + 36, y + 250, 190, 40, d, { fill: mixHex(g.panel, tone, 0.18), color: toneInk, family: K.body, size: 17, weight: 700 }));
    nodes.push(text(x + 36, y + 320, cw - 72, 140, note, t.body(20)));
  });
  nodes.push(...note(K, g, c.note));
  return { page: { name: "Figures", bg: g.bg, nodes } };
}

export function chart(K, i, c0) {
  const c = withDefaults("chart", c0);
  const g = K.paper;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title, { titleWidth: 1100 });
  const long = linesFor(c.takeaway, 24, 1100, K.charWidth ?? 0.56) > 1;
  nodes.push(text(M, bodyTop - 24, 1100, long ? 70 : 36, c.takeaway, t.body(24)));
  const cx = M, cy = bodyTop + (long ? 64 : 40), cw = 1140, ch = long ? 560 : 580;
  // Chart text draws in a fixed dark ink, so a dark look sets its chart on a
  // light card; a light look lets it sit on the page.
  const dark = isDark(g.bg);
  if (dark) nodes.push(rect(cx - 32, cy - 24, cw + 64, ch + 48, "#F3F5F9", { radius: K.radius }));
  const palette = [dark ? "#1F2A44" : g.accent2, dark && !isDark(g.accent) ? g.accent2 : g.accent, dark ? "#6B7A99" : mixHex(g.accent, g.accent2, 0.5)];
  nodes.push({
    kind: "chart", x: cx, y: cy, w: cw, h: ch, chartType: c.chartType, fontSize: 18,
    categories: c.categories,
    series: c.series.map((s, k) => ({ name: s.name, values: s.values, color: s.color ?? palette[k % palette.length] })),
  });
  const rx = 1320, rw = 504;
  c.calls.forEach(([n, l], k) => {
    const y = bodyTop + 20 + k * 180;
    nodes.push(text(rx, y, rw, 80, n, t.numeral(64)));
    nodes.push(text(rx, y + 88, rw, 60, l, t.body(22)));
    if (k < c.calls.length - 1) nodes.push(rect(rx, y + 152, rw, 1, g.line));
  });
  nodes.push(...note(K, g, c.note));
  return { page: { name: "Chart", bg: g.bg, nodes } };
}

export function timeline(K, i, c0) {
  const c = withDefaults("timeline", c0);
  const g = K.paper;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
  const y = bodyTop + 170;
  const n = c.steps.length;
  nodes.push(rect(M, y + 13, CW, 3, g.line));
  if (c.done > 0) nodes.push(rect(M, y + 13, Math.round((CW * (c.done - 0.5)) / n), 3, g.accent));
  const cw = CW / n;
  c.steps.forEach(([q, h, s], k) => {
    const x = M + k * cw;
    const done = k < c.done;
    nodes.push(ellipse(x, y, 30, 30, done ? g.accent : g.bg, done ? {} : { stroke: g.accent, strokeWidth: 3 }));
    nodes.push(text(x, y - 60, 300, 28, q, t.eyebrow()));
    const two = linesFor(h, 32, cw - 48, K.charWidth ?? 0.56) > 1;
    nodes.push(text(x, y + 64, cw - 48, two ? 80 : 44, h, t.display(32, { lineHeight: 1.1 })));
    nodes.push(text(x, y + (two ? 152 : 116), cw - 48, 120, s, t.body(21)));
  });
  nodes.push(...note(K, g, c.note));
  return { page: { name: "Timeline", bg: g.bg, nodes } };
}

export function process(K, i, c0) {
  const c = withDefaults("process", c0);
  const g = K.paper;
  const d = K.deep;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
  const n = c.steps.length;
  const cw = (CW - (n - 1) * 40) / n;
  const y = bodyTop + 30;
  c.steps.forEach(([h, s], k) => {
    const x = M + k * (cw + 40);
    const fillC = k === 0 ? g.accent : d.bg;
    nodes.push(ellipse(x, y, 88, 88, fillC));
    nodes.push(text(x, y, 88, 88, String(k + 1), { family: K.display, size: 34, weight: K.dw, color: inkOn(K, fillC), align: "center", vAlign: "middle", lineHeight: 1 }));
    if (k < n - 1) nodes.push(rect(x + 104, y + 43, cw - 104 + 24, 2, g.line));
    nodes.push(text(x, y + 132, cw, 44, h, t.display(32)));
    nodes.push(text(x, y + 186, cw - 24, 150, s, t.body(21)));
  });
  nodes.push(...note(K, g, c.note));
  return { page: { name: "Process", bg: g.bg, nodes } };
}

export function table(K, i, c0) {
  const c = withDefaults("table", c0);
  const g = K.paper;
  const d = K.deep;
  const t = type(K, g);
  const td = type(K, d);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
  const x0 = M, y0 = bodyTop;
  const firstW = 600;
  const colW = (CW - firstW) / (c.cols.length - 1);
  const headH = 76, rowH = 96;
  nodes.push(rect(x0, y0, CW, headH, deepGround(d), { radius: K.radius ? Math.min(K.radius, 12) : 0 }));
  c.cols.forEach((col, k) => {
    if (!k) return;
    nodes.push(text(x0 + firstW + (k - 1) * colW, y0 + 22, colW, 32, col, td.strong(22, { align: "center" })));
  });
  c.rows.forEach((r, k) => {
    const y = y0 + headH + k * rowH;
    if (k % 2 === 1) nodes.push(rect(x0, y, CW, rowH, g.panel));
    nodes.push(text(x0 + 32, y + 30, firstW - 64, 36, r[0], t.strong(24)));
    r.slice(1).forEach((v, col) => {
      const cx = x0 + firstW + col * colW;
      if (v === "yes") nodes.push(icon("circle-check", cx + colW / 2 - 16, y + 32, 32, g.accent));
      else if (v === "no") nodes.push(icon("circle", cx + colW / 2 - 16, y + 32, 32, g.line));
      else if (linesFor(v, 24, colW - 24, K.charWidth ?? 0.56) > 1) nodes.push(text(cx + 12, y + 18, colW - 24, 60, v, t.strong(19, { align: "center", color: g.muted, lineHeight: 1.25 })));
      else nodes.push(text(cx, y + 30, colW, 36, v, t.strong(24, { align: "center", color: g.muted })));
    });
    nodes.push(rect(x0, y + rowH - 1, CW, 1, g.line));
  });
  nodes.push(...note(K, g, c.note));
  return { page: { name: "Comparison table", bg: g.bg, nodes } };
}

export function team(K, i, c0) {
  const c = withDefaults("team", c0);
  const g = K.paper;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
  const n = c.people.length;
  const cw = (CW - (n - 1) * 24) / n;
  // The block (portrait, name, role, bio) is about 440 tall; centre it in
  // the body so the lower half of the page is not left empty.
  const y = bodyTop + Math.max(20, Math.round((940 - bodyTop - 440) / 2));
  const illustrations = [];
  c.people.forEach(([name, r, b], k) => {
    const x = M + k * (cw + 24);
    const tone = k % 2 ? g.accent2 : g.accent;
    const px = x + (cw - 220) / 2;
    // A portrait slot: a tinted circle (drop a photo on it) with a drawn peep.
    nodes.push(photo(px, y, 220, 220, mixHex(g.panel, tone, 0.22), { shape: "ellipse" }));
    const peeps = c.peeps ?? K.peeps;
    illustrations.push(art(peeps[k % peeps.length], px + 30, y + 22, 160, 176));
    nodes.push(text(x, y + 252, cw, 40, name, t.display(30, { align: "center" })));
    nodes.push(text(x, y + 298, cw, 28, r, t.eyebrow({ align: "center", size: 17, color: k % 2 ? (g.accent2Ink ?? g.accent2) : (g.accentInk ?? g.accent) })));
    nodes.push(text(x + 24, y + 344, cw - 48, 96, b, t.body(21, { align: "center" })));
  });
  nodes.push(...note(K, g, c.note));
  return { page: { name: "Team", bg: g.bg, nodes, illustrations } };
}

export function quote(K, i, c0) {
  const c = withDefaults("quote", c0);
  const g = K.deep;
  const t = type(K, g);
  const nodes = [...ornamentDeep(K, g), ...footer(K, g, i)];
  nodes.push(text(M, 180, 260, 260, "“", t.numeral(280, { lineHeight: 1 })));
  const qh = Math.round(K.scale.quote * 1.3 * 3) + 10;
  const qw = K.ornament === "dots" || K.ornament === "watermark" ? 1100 : 1400;
  nodes.push(text(M + 20, 400, qw, qh, c.text, t.display(K.scale.quote, { lineHeight: 1.26, weight: K.display === "Fraunces" ? 400 : K.dw })));
  const ay = 400 + qh + 60;
  nodes.push(photo(M + 20, ay, 84, 84, g.panel2, { shape: "ellipse" }));
  const illustrations = [art(K.peeps[4 % K.peeps.length], M + 32, ay + 8, 60, 68)];
  nodes.push(text(M + 128, ay + 8, 800, 32, c.name, t.strong(24)));
  nodes.push(text(M + 128, ay + 44, 800, 28, c.role, t.body(20)));
  nodes.push(...note(K, g, c.note, true));
  return { page: { name: "Quote", bg: deepGround(g), nodes, illustrations } };
}

export function pricing(K, i, c0) {
  const c = withDefaults("pricing", c0);
  const g = K.paper;
  const d = K.deep;
  const t = type(K, g);
  const td = type(K, d);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
  const cw = (CW - 64) / 3;
  const y = bodyTop;
  const h = 620;
  c.tiers.forEach(([name, price, per, feats, hot], k) => {
    const x = M + k * (cw + 32);
    const gg = hot ? d : g;
    const tt = hot ? td : t;
    if (hot) nodes.push(rect(x, y - 16, cw, h + 32, deepGround(d), { radius: K.radius }));
    else nodes.push(card(K, g, x, y, cw, h, { fill: g.bg }));
    const top = hot ? y - 16 : y;
    if (hot) nodes.push(button(x + cw - 200, top + 28, 160, 36, c.hotLabel, { fill: gg.accent, color: inkOn(K, gg.accent), family: K.body, size: 15, weight: 700, upper: true, letterSpacing: 1 }));
    nodes.push(text(x + 40, top + 40, cw - 80, 28, name, tt.eyebrow()));
    nodes.push(text(x + 40, top + 84, cw - 80, 90, price, tt.display(72)));
    nodes.push(text(x + 40, top + 180, cw - 80, 28, per, tt.body(20)));
    nodes.push(rect(x + 40, top + 232, cw - 80, 1, gg.line));
    feats.forEach((f, j) => {
      const fy = top + 264 + j * 56;
      nodes.push(icon("circle-check", x + 40, fy, 26, gg.accent));
      nodes.push(text(x + 84, fy - 2, cw - 124, 32, f, tt.strong(22, { weight: 500 })));
    });
    const btnFill = hot ? gg.accent : d.bg;
    nodes.push(button(x + 40, y + h - 100, cw - 80, 60, hot ? c.hotCta : c.ctaPrefix + name, { fill: btnFill, color: inkOn(K, btnFill), family: K.body, size: 20, weight: 700, radius: K.radius ? Math.min(K.radius, 30) : 0 }));
  });
  nodes.push(...note(K, g, c.note));
  return { page: { name: "Pricing", bg: g.bg, nodes } };
}

export function closing(K, i, c0) {
  const c = withDefaults("closing", c0);
  const g = K.deep;
  const t = type(K, g);
  const nodes = [...ornamentDeep(K, g, { mark: true })];
  const illustrations = [];
  const fill = [];
  const drawing = c.art ?? K.art.closing;
  if (K.ornament === "blocks") {
    nodes.push(rect(1272, 0, 648, H, g.accent, { bleed: true }));
    nodes.push(ellipse(1316, 240, 560, 560, g.ink, { opacity: 0.18 }));
    nodes.push(...confetti([g.lime, g.ink, g.bg], 12, 8, { x: 1290, y: 80, w: 610, h: 920 }));
    illustrations.push(art(drawing, 1336, 280, 520, 480));
  } else {
    nodes.push(...halo(1520, 520, 640, g.accent));
    illustrations.push(art(drawing, 1250, 250, 540, 540));
  }
  nodes.push(...mark(K, g));
  nodes.push(text(M, 236, 1000, Math.round(K.accentSize * 1.3), K.farewell, t.kicker()));
  const closeLines = c.title.split("\n").length;
  const closeSize = fitSize(c.title, K.scale.cover, 1100, 0.6, K.charWidth ?? 0.56);
  const closeH = Math.round(closeSize * 1.1 * closeLines) + 10;
  nodes.push(text(M, 300, 1100, closeH, c.title, t.display(closeSize, { lineHeight: 1.04 })));
  nodes.push(text(M, 300 + closeH + 34, 940, 120, c.subtitle, t.body(28)));
  const labels = ["Email", "Website", "Phone"];
  c.rows.forEach(([ic, v], k) => {
    const y = 700 + k * 62;
    nodes.push(icon(ic, M, y + 2, 28, g.accent));
    nodes.push(text(M + 48, y, 800, 34, v, t.strong(24, { weight: 500 })));
    fill.push({ node: nodes.length - 1, label: labels[k] ?? "Contact", hint: "Contact detail" });
  });
  nodes.push(button(M, 910, 340, 64, c.cta, { fill: g.accent, color: inkOn(K, g.accent), family: K.body, size: 22, weight: 700, radius: K.radius ? Math.min(K.radius, 32) : 0 }));
  if (K.total > 1) nodes.push(text(W - M - 240, 940, 240, 28, pageNo(i, K.total), t.meta({ align: "right" })));
  nodes.push(...note(K, g, c.note, true));
  return { page: { name: "Closing", bg: deepGround(g), nodes, illustrations }, fill };
}

/** One figure, as large as the page allows, on the deep ground: the slide
 *  a presenter pauses on. */
export function bigStat(K, i, c0) {
  const c = { eyebrow: "Revenue impact", value: "$1.2M", caption: "Added in net-new annual revenue from the redesigned checkout.", delta: "+38% on Q1", ...(c0 ?? {}) };
  const g = K.deep;
  const t = type(K, g);
  const nodes = [...ornamentDeep(K, g), ...footer(K, g, i)];
  const fill = [];
  nodes.push(...halo(W / 2, 470, 760, g.accent));
  nodes.push(text(M, 236, CW, 28, c.eyebrow, t.eyebrow({ align: "center" })));
  fill.push({ node: nodes.length - 1, label: "Eyebrow", hint: "What the figure measures" });
  const size = c.value.length > 6 ? 220 : 300;
  nodes.push(text(M, 300, CW, size + 20, c.value, t.numeral(size, { align: "center" })));
  fill.push({ node: nodes.length - 1, label: "Figure", hint: "The one number" });
  nodes.push(text(W / 2 - 600, 300 + size + 50, 1200, 90, c.caption, t.body(30, { align: "center", color: g.ink })));
  fill.push({ node: nodes.length - 1, label: "Caption", hint: "One sentence on what it means" });
  nodes.push(button(W / 2 - 130, 300 + size + 170, 260, 48, c.delta, { fill: mixHex(g.bg, g.accent, 0.22), color: g.accentInk ?? g.accent, family: K.body, size: 19, weight: 700 }));
  fill.push({ node: nodes.length - 1, label: "Comparison", hint: "Against what" });
  fill[fill.length - 1].node = `${fill[fill.length - 1].node}-label`;
  return { page: { name: "Big figure", bg: deepGround(g), nodes }, fill };
}

/** Three horizon columns (now, next, later), each a stack of items with a
 *  title and a line: the roadmap slide. */
export function columns(K, i, c0) {
  const c = {
    eyebrow: "Product roadmap", title: "The road ahead",
    intro: "Every bet, sorted by horizon. Dates may shift as we learn; the direction will not.",
    cols: [
      ["Now", "Shipping this quarter", [["Realtime co-editing", "Multiplayer cursors, comments and presence in every doc."], ["Mobile quick capture", "Send notes and tasks to any project from your phone."], ["Granular permissions", "Role-based access, down to a single page."]]],
      ["Next", "In design", [["Workflow automations", "Trigger actions when a task changes status or owner."], ["Public API v2", "Webhooks, typed SDKs and saner rate limits."], ["Template gallery", "Start any project from a community template."]]],
      ["Later", "Exploring", [["AI meeting recaps", "Summaries and action items, filed to the timeline."], ["Offline mode", "Full editing without a connection; sync on return."], ["Desktop apps", "Fast, focused native clients for macOS and Windows."]]],
    ],
    ...(c0 ?? {}),
  };
  const g = K.paper;
  const d = K.deep;
  const t = type(K, g);
  const td = type(K, d);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title, { titleWidth: 1000 });
  nodes.push(text(M + 1040, 130, CW - 1040, 80, c.intro, t.body(21)));
  const n = c.cols.length;
  const cw = (CW - (n - 1) * 24) / n;
  const y = bodyTop;
  const h = 640;
  c.cols.forEach(([head, sub, items], k) => {
    const x = M + k * (cw + 24);
    const hot = k === 0;
    if (hot) nodes.push(rect(x, y, cw, h, deepGround(d), { radius: K.radius }));
    else nodes.push(card(K, g, x, y, cw, h));
    const tt = hot ? td : t;
    const gg = hot ? d : g;
    nodes.push(text(x + 36, y + 36, cw - 72, 44, head, tt.display(34)));
    nodes.push(text(x + 36, y + 84, cw - 72, 26, sub, tt.eyebrow({ size: 15, letterSpacing: 3 })));
    nodes.push(rect(x + 36, y + 128, cw - 72, 1, gg.line));
    items.forEach(([it, line], j) => {
      const iy = y + 156 + j * 156;
      nodes.push(ellipse(x + 36, iy + 8, 12, 12, gg.accent));
      nodes.push(text(x + 64, iy, cw - 100, 34, it, tt.strong(24)));
      nodes.push(text(x + 64, iy + 40, cw - 100, 80, line, tt.body(19)));
    });
  });
  nodes.push(...note(K, g, c.note));
  return { page: { name: "Roadmap", bg: g.bg, nodes } };
}

/** A day's schedule: a timeline of slots down the left, an after-hours
 *  card on the deep ground at right with a drawing in a halo. From the
 *  offsite deck. */
export function schedule(K, i, c0) {
  const c = {
    eyebrow: "Day one  ·  Wednesday", title: "Maps out, laptops shut.",
    slots: [["08:30", "Check-in", "Badges, maps and the good espresso."], ["10:00", "The plan", "Ten slides, zero spreadsheets."], ["12:30", "Lunch", "One table, everyone."], ["14:00", "Workshops", "Pick one of three tracks."], ["16:30", "The walk", "Gentle loop or the summit."], ["19:00", "Dinner", "Off the grill, by the fire."]],
    after: { eyebrow: "After hours", head: "Night one ends\naround the fire.", note: "bring a hoodie, trust us" },
    ...(c0 ?? {}),
  };
  const g = K.paper;
  const d = K.deep;
  const t = type(K, g);
  const td = type(K, d);
  const { nodes } = chrome(K, g, i, c.eyebrow, c.title, { titleWidth: 940 });
  nodes.push(rect(M + 10, 332, 4, 520, g.line, { radius: 2 }));
  c.slots.forEach(([tm, h, sub], k) => {
    const y = 322 + k * 104;
    nodes.push(ellipse(M + 2, y, 20, 20, k % 3 === 2 ? g.accent2 : g.accent));
    nodes.push(text(M + 56, y - 2, 150, 28, tm, { family: K.mono ?? K.body, size: 22, weight: 600, color: g.accentInk ?? g.accent, lineHeight: 1.2 }));
    nodes.push(text(M + 220, y - 6, 620, 32, h, t.display(27)));
    nodes.push(text(M + 220, y + 32, 620, 56, sub, t.body(20)));
  });
  const cx = 1120, cy = 268, cw = 660, ch = 650;
  nodes.push(rect(cx, cy, cw, ch, deepGround(d), { radius: K.radius }));
  nodes.push(...sparkles(d.accent, 20 + i, 6, { x: cx + 20, y: cy + 20, w: cw - 40, h: 300 }));
  nodes.push(text(cx + 60, cy + 56, 540, 24, c.after.eyebrow, td.eyebrow({ size: 19, letterSpacing: 3 })));
  nodes.push(text(cx + 60, cy + 92, 540, 84, c.after.head, td.display(34)));
  nodes.push(...halo(cx + cw / 2, cy + 440, 360, d.accent));
  const illustrations = [art(c.art ?? K.art.section, cx + 150, cy + 280, 360, 300)];
  if (c.after.note) nodes.push(text(cx + 60, cy + 560, 540, 44, c.after.note, td.kicker({ align: "center", size: Math.round(K.accentSize * 0.8) })));
  return { page: { name: "Schedule", bg: g.bg, nodes, illustrations } };
}

/** A checklist in two columns with a legend, and a picture slot with a
 *  drawing at right. From the offsite deck. */
export function checklist(K, i, c0) {
  const c = {
    eyebrow: "Before you leave", title: "The pack list",
    items: [["Layers for the weather", true], ["Shoes that can get muddy", true], ["A water bottle", true], ["Swimsuit, for the brave", false], ["A hoodie for the evening", true], ["A torch", false], ["Chargers", true], ["A book or a deck of cards", false]],
    legend: ["must bring", "nice to have"],
    ...(c0 ?? {}),
  };
  const g = K.paper;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title, { titleWidth: 900 });
  c.items.forEach(([label, must], k) => {
    const col = k % 2, row = Math.floor(k / 2);
    const x = M + col * 560, y = bodyTop + 20 + row * 92;
    nodes.push(icon(must ? "circle-check" : "circle", x, y + 2, 34, must ? (g.accentInk ?? g.accent) : g.line));
    nodes.push(text(x + 54, y, 480, 40, label, t.strong(24)));
  });
  const ly = bodyTop + 20 + Math.ceil(c.items.length / 2) * 92 + 20;
  nodes.push(rect(M, ly, 1080, 1, g.line));
  nodes.push(icon("circle-check", M, ly + 26, 22, g.accent));
  nodes.push(text(M + 34, ly + 22, 300, 28, c.legend[0], t.body(18)));
  nodes.push(icon("circle", M + 260, ly + 26, 22, g.line));
  nodes.push(text(M + 294, ly + 22, 300, 28, c.legend[1], t.body(18)));
  nodes.push(photo(1300, 268, 480, 600, { angle: 160, stops: [[mixHex(g.panel, g.accent2, 0.22), 0], [g.panel, 1]] }, { radius: K.radius }));
  nodes.push(...halo(1540, 540, 400, g.accent));
  const illustrations = [art(c.art ?? K.art.picture, 1360, 320, 360, 420)];
  nodes.push(...note(K, g, c.note));
  return { page: { name: "Checklist", bg: g.bg, nodes, illustrations } };
}

/** Facts with icons down the left, a large picture slot with a drawing at
 *  right, and an intro line. From the offsite deck's lodge slide. */
export function facts(K, i, c0) {
  const c = {
    eyebrow: "Where we're staying", title: "The lodge",
    intro: "A timber lodge at altitude with a lake, a library, a long porch and no reason to check messages.",
    items: [["map-pin", "Two hours from the office", "By shuttle, door to door"], ["bed", "Sixteen cabins", "Assignments land the Friday before"], ["home", "A hall that seats sixty", "Sessions, meals and demos"], ["sun", "Highs of 18, lows of 4", "Layers. Really."]],
    ...(c0 ?? {}),
  };
  const g = K.paper;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title, { titleWidth: 900 });
  nodes.push(text(M, bodyTop - 20, 820, 90, c.intro, t.body(26)));
  c.items.forEach(([ic, h, sub], k) => {
    const y = bodyTop + 100 + k * 118;
    nodes.push(ellipse(M, y, 56, 56, mixHex(g.panel, g.accent, 0.18)));
    nodes.push(icon(ic, M + 14, y + 14, 28, g.accentInk ?? g.accent));
    nodes.push(text(M + 80, y - 2, 740, 34, h, t.display(26)));
    nodes.push(text(M + 80, y + 34, 740, 30, sub, t.body(20)));
  });
  nodes.push(photo(1080, 268, 700, 610, { angle: 160, stops: [[mixHex(g.panel, g.accent2, 0.22), 0], [g.panel, 1]] }, { radius: K.radius }));
  nodes.push(...halo(1430, 545, 500, g.accent));
  const illustrations = [art(c.art ?? K.art.picture, 1190, 320, 480, 420)];
  nodes.push(...note(K, g, c.note));
  return { page: { name: "Facts", bg: g.bg, nodes, illustrations } };
}

/** A split slide: the problem on a deep panel at left, the answer on paper
 *  at right with checks, a drawing in a halo. From the main-street pitch. */
export function split(K, i, c0) {
  const c = {
    left: { eyebrow: "The problem", head: "Selling online is\nstill built for\nbig brands.", lines: ["Most small shops still cannot take an order online.", "Store builders demand weeks of setup and fees.", "Marketplaces skim a third and keep the customer."] },
    right: { eyebrow: "Our solution", head: "Storefronts that\nbuild themselves.", body: "We read a shop's socials and point of sale, then assemble a ready-to-sell storefront with payments and delivery included.", checks: [["bolt", "Live in one afternoon"], ["coin", "No commission, one flat fee"], ["user", "You own every customer"]] },
    ...(c0 ?? {}),
  };
  const g = K.paper;
  const d = K.deep;
  const t = type(K, g);
  const td = type(K, d);
  const nodes = [
    rect(0, 0, 900, H, deepGround(d), { bleed: true }),
    ...sparkles(d.accent, 21 + i, 6, { x: 40, y: 40, w: 820, h: 400 }),
    text(M, 130, 700, 28, c.left.eyebrow, td.eyebrow()),
    text(M, 184, 720, 240, c.left.head, td.display(58, { lineHeight: 1.08 })),
    ...c.left.lines.flatMap((line, k) => [rect(M, 470 + k * 100, 12, 12, d.accent, { radius: 3 }), text(M + 32, 460 + k * 100, 660, 70, line, td.body(24))]),
    rect(900, 0, 6, H, g.accent, { bleed: true }),
    text(980, 130, 800, 28, c.right.eyebrow, t.eyebrow()),
    text(980, 184, 820, 160, c.right.head, t.display(58, { lineHeight: 1.08 })),
    text(980, 370, 800, 110, c.right.body, t.body(24)),
    ...c.right.checks.flatMap(([ic, line], k) => [ellipse(980, 520 + k * 76, 44, 44, mixHex(g.panel, g.accent, 0.2)), icon(ic, 990, 530 + k * 76, 24, g.accent), text(1044, 526 + k * 76, 700, 34, line, t.strong(24))]),
    ...halo(1560, 800, 300, g.accent),
    ...footer(K, g, i).slice(1),
  ];
  const illustrations = [art(c.art ?? K.art.picture, 1440, 690, 240, 220)];
  return { page: { name: "Split", bg: g.bg, nodes, illustrations } };
}

/** Four cards in a two by two grid, each with an icon, a heading and a line.
 *  From the offsite deck's agreements. */
export function fourCards(K, i, c0) {
  const c = {
    eyebrow: "How we do this", title: "Four agreements for the week",
    cards: [["clock", "Be on time", "Sessions start when they say; nobody waits well."], ["microphone", "Everyone speaks", "Each session ends with a round."], ["device-mobile", "Phones down in sessions", "Notes on paper; photos of the board at the end."], ["heart", "Kind by default", "Demos are brave. Questions are curious."]],
    ...(c0 ?? {}),
  };
  const g = K.paper;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
  c.cards.forEach(([ic, h, sub], k) => {
    const x = M + (k % 2) * 876, y = bodyTop + Math.floor(k / 2) * 300;
    const tone = k % 2 ? g.accent2 : g.accent;
    nodes.push(card(K, g, x, y, 852, 264));
    nodes.push(ellipse(x + 40, y + 40, 72, 72, mixHex(g.panel, tone, 0.2)));
    nodes.push(icon(ic, x + 58, y + 58, 36, k % 2 ? (g.accent2Ink ?? g.accent2) : (g.accentInk ?? g.accent)));
    nodes.push(text(x + 140, y + 44, 672, 40, h, t.display(30)));
    nodes.push(text(x + 140, y + 96, 672, 120, sub, t.body(22)));
  });
  nodes.push(...note(K, g, c.note));
  return { page: { name: "Four cards", bg: g.bg, nodes } };
}

/** A slide the deck script built itself, with these primitives. */
export const raw = (K, i, c) => (typeof c.build === "function" ? c.build(K, i, c) : { page: c.page, fill: c.fill ?? [] });

export const LAYOUTS = { cover, agenda, section, statement, textPicture, twoColumns, threeCards, figures, chart, timeline, process, table, team, quote, pricing, closing, bigStat, columns, schedule, checklist, facts, split, fourCards, raw };

// --- assembly ------------------------------------------------------------------

/** A template spec from a look and a slide plan. `plan.slides` is a list of
 *  `[layoutName, content]`; deck meta (company, deck, kicker, farewell, art,
 *  peeps) on the plan overrides the look's. */
export function buildSpec(look0, plan) {
  // A plan may override any part of its look: palettes, faces, the
  // ornament, drawings, portraits, scale.
  const o = plan.look ?? {};
  // A palette override that sets its own accent starts clean: the base's
  // accent inks and reserved colours (sun, lime) do not leak through.
  const mergePalette = (b, ov) => {
    if (!ov) return b;
    const out = { ...b, ...ov };
    if (ov.accent) for (const k of ["accentInk", "accent2Ink", "sun", "lime"]) if (!(k in ov)) delete out[k];
    return out;
  };
  const look = { ...look0, ...o, paper: mergePalette(look0.paper, o.paper), deep: mergePalette(look0.deep, o.deep), art: { ...look0.art, ...(o.art ?? {}) }, scale: { ...look0.scale, ...(o.scale ?? {}) } };
  const K = { ...look, ...(plan.meta ?? {}), art: { ...look.art, ...(plan.meta?.art ?? {}) }, total: plan.slides.length };
  const pages = [];
  const fillable = [];
  plan.slides.forEach(([name, content], i) => {
    const layout = LAYOUTS[name];
    if (!layout) throw new Error(`${plan.id}: unknown layout ${name}`);
    const { page, fill } = layout(K, i, content);
    if (content?.pageName) page.name = content.pageName;
    pages.push(page);
    for (const f of fill ?? []) fillable.push({ node: `p${i}-n${f.node}`, kind: "text", label: f.label, hint: f.hint });
  });
  return {
    id: plan.id,
    title: plan.title,
    categories: plan.categories ?? ["presentations", "business"],
    tags: plan.tags,
    styleTags: plan.styleTags ?? look.styleTags,
    size: [W, H],
    typography: [
      { role: "heading", family: K.display, weight: K.dw },
      { role: "body", family: K.body, weight: K.bw },
      { role: "accent", family: K.accentFace, weight: K.accentWeight },
      ...(K.mono ? [{ role: "label", family: K.mono, weight: 500 }] : []),
    ],
    pages,
    fillable,
    version: plan.version ?? 1,
    created: plan.created ?? "2026-09-29T00:00:00.000Z",
    ...(plan.updated ? { updated: plan.updated } : {}),
    rank: plan.rank ?? 100,
  };
}

/** Node count of a spec, drawings included. */
export const specNodes = (spec) => spec.pages.reduce((n, p) => n + p.nodes.length + (p.illustrations?.length ?? 0), 0);
