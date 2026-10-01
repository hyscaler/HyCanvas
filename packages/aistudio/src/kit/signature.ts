// The kit's signature forms: the one slide in a deck built for its subject
// rather than taken from the catalog, the way every signature template
// carries one page nobody else has (the offsite's two-day grid, the pitch's
// storefront, the review's scoreboard). The outline names one of these for
// at most one page; the form draws from the page's typed fields (stats,
// columns, steps, pairs, points) and the look, in the kit's vocabulary.

import { CW, M, card, chrome, deepCard, deepGround, estWidth, fitSize, footer, halo, inkOn, isDark, linesFor, mixHex, note, ornamentPaper, sparkles, type, type KitLook } from "./look";
import { button, ellipse, icon, path, rect, text, type Prim } from "./spec";
import type { Slide } from "./layouts";

import { outlineSignatures } from "../outline";

export const kitSignatureNames = outlineSignatures;
export type KitSignature = (typeof kitSignatureNames)[number];

// --- scoreboard ------------------------------------------------------------------

export interface ScoreboardContent { eyebrow: string; title: string; stats: [string, string, string][]; lines: string[]; note?: string }

/** A deep board across the top with the figures at display scale, and
 *  under it what moved, one line per figure. */
export function scoreboard(K: KitLook, i: number, c: ScoreboardContent): Slide {
  const g = K.paper;
  const d = K.deep;
  const t = type(K, g);
  const td = type(K, d);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
  const n = Math.max(1, c.stats.length);
  const bx = M, by = bodyTop, bw = CW, bh = 360;
  nodes.push(deepCard(K, bx, by, bw, bh));
  nodes.push(...sparkles(d.accent, 31 + i, 8, { x: bx + 20, y: by + 20, w: bw - 40, h: bh - 40 }));
  const cw = bw / n;
  c.stats.forEach(([v, l, delta], k) => {
    const x = bx + k * cw;
    if (k > 0) nodes.push(rect(x, by + 40, 1, bh - 80, d.line, { decor: true }));
    const size = fitSize(v, K.scale.numeral * 1.15, cw - 64, 0.45, 0.62);
    nodes.push(text(x + 32, by + 56, cw - 64, size + 16, v, td.numeral(size, { align: "center", color: k % 2 ? (d.accent2Ink ?? d.accent2) : (d.accentInk ?? d.accent) })));
    nodes.push(text(x + 32, by + 56 + size + 30, cw - 64, 60, l, td.strong(22, { align: "center", lineHeight: 1.25 })));
    if (delta) nodes.push(button(x + cw / 2 - 90, by + bh - 64, 180, 40, delta, { fill: mixHex(d.bg, d.accent, 0.22), color: d.accentInk ?? d.accent, family: K.body, size: 16, weight: 700 }));
  });
  const lines = c.lines.slice(0, n);
  const ly = by + bh + 44;
  const lw = (CW - 24 * (n - 1)) / n;
  lines.forEach((line, k) => {
    const x = M + k * (lw + 24);
    nodes.push(rect(x, ly, 40, 4, k % 2 ? g.accent2 : g.accent, { decor: true }));
    nodes.push(text(x, ly + 24, lw - 16, 940 - ly - 84, line, t.body(21)));
  });
  nodes.push(...note(K, g, c.note));
  return { name: "Scoreboard", bg: g.bg, nodes, drawings: [] };
}

// --- before and after ----------------------------------------------------------------

export interface BeforeAfterContent { eyebrow: string; title: string; before: { head: string; lines: string[] }; after: { head: string; lines: string[] }; note?: string }

/** The old way struck through on a quiet card, the new way checked off on
 *  the deep ground, and one arrow between them. */
export function beforeAfter(K: KitLook, i: number, c: BeforeAfterContent): Slide {
  const g = K.paper;
  const d = K.deep;
  const t = type(K, g);
  const td = type(K, d);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
  const y = bodyTop;
  const h = 600;
  const colW = (CW - 120) / 2;
  const rows = Math.max(c.before.lines.length, c.after.lines.length, 1);
  const rowH = Math.min(96, Math.floor((h - 200) / rows));
  // Before: a quiet card, every line struck out in the muted ink.
  nodes.push(card(K, g, M, y, colW, h));
  nodes.push(text(M + 44, y + 44, colW - 88, 28, "Before", t.eyebrow({ color: g.muted })));
  nodes.push(text(M + 44, y + 84, colW - 88, 100, c.before.head, t.display(36, { lineHeight: 1.1, color: g.muted })));
  c.before.lines.forEach((l, k) => {
    const ly = y + 200 + k * rowH;
    nodes.push(rect(M + 44, ly + 14, 14, 3, g.muted, { decor: true }));
    nodes.push(text(M + 76, ly, colW - 120, rowH - 12, l, t.strong(22, { weight: 500, color: g.muted })));
    nodes.push(rect(M + 76, ly + 16, Math.min(colW - 120, Math.round(estWidth(l, 22, 0.5))), 2, g.muted, { opacity: 0.7, decor: true }));
  });
  // The arrow: a chevron of the accent between the columns.
  const ax = M + colW + 24, ay = y + h / 2;
  nodes.push(ellipse(ax, ay - 36, 72, 72, mixHex(g.panel, g.accent, 0.2), { panel: true }));
  nodes.push(path([[ax + 22, ay - 14], [ax + 40, ay], [ax + 22, ay + 14]], { stroke: g.accentInk ?? g.accent, strokeWidth: 5, decor: true }));
  // After: the deep card, every line checked.
  const rx = M + colW + 120;
  nodes.push(deepCard(K, rx, y, colW, h));
  nodes.push(...sparkles(d.accent, 41 + i, 5, { x: rx + colW - 240, y: y + h - 120, w: 200, h: 90 }));
  nodes.push(text(rx + 44, y + 44, colW - 88, 28, "After", td.eyebrow()));
  nodes.push(text(rx + 44, y + 84, colW - 88, 100, c.after.head, td.display(36, { lineHeight: 1.1 })));
  c.after.lines.forEach((l, k) => {
    const ly = y + 200 + k * rowH;
    nodes.push(icon("circle-check", rx + 44, ly + 2, 28, d.accent));
    nodes.push(text(rx + 88, ly, colW - 132, rowH - 12, l, td.strong(22, { weight: 500 })));
  });
  nodes.push(...note(K, g, c.note));
  return { name: "Before and after", bg: g.bg, nodes, drawings: [] };
}

// --- funnel -------------------------------------------------------------------------

export interface FunnelContent { eyebrow: string; title: string; steps: [string, string, string][]; note?: string }

/** Bands narrowing downward, each a stage with its figure and its line, the
 *  top band on the deep ground and each band under it a lighter tint. */
export function funnel(K: KitLook, i: number, c: FunnelContent): Slide {
  const g = K.paper;
  const d = K.deep;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title, { titleWidth: 1000 });
  const steps = c.steps.slice(0, 5);
  const n = Math.max(1, steps.length);
  const top = bodyTop, avail = 940 - bodyTop - 20;
  const bandH = Math.min(120, Math.floor((avail - (n - 1) * 12) / n));
  const fullW = 1040;
  steps.forEach(([label, value, detail], k) => {
    const shrink = k / Math.max(1, n);
    const w = Math.round(fullW * (1 - shrink * 0.55));
    const x = M + Math.round((fullW - w) / 2);
    const y = top + k * (bandH + 12);
    const fill = k === 0 ? deepGround(d) : mixHex(g.panel, d.bg, Math.max(0.06, 0.45 - k * 0.1));
    const dark = k === 0 || isDark(typeof fill === "string" ? fill : d.bg);
    const ink = dark ? d.ink : g.ink;
    const muted = dark ? d.muted : g.muted;
    nodes.push(rect(x, y, w, bandH, fill, { radius: Math.min(K.radius, 16), panel: true }));
    nodes.push(text(x + 36, y + (bandH - 40) / 2, w - 260, 40, label, { family: K.display, size: 28, weight: K.dw, color: ink, lineHeight: 1.1, cw: K.charWidth ?? 0.56 }));
    if (value) nodes.push(text(x + w - 220, y + (bandH - 48) / 2, 184, 48, value, { family: K.numeralFace ?? K.display, size: 40, weight: K.numeralWeight ?? K.dw, color: dark ? (d.accentInk ?? d.accent) : (g.accentInk ?? g.accent), align: "right", lineHeight: 1, cw: 0.62, name: "Figure" }));
    // The stage's line sits to the right of the funnel, on the page.
    if (detail) {
      nodes.push(rect(M + fullW + 60, y + 12, 3, bandH - 24, k === 0 ? g.accent : g.line, { decor: true }));
      nodes.push(text(M + fullW + 84, y + 8, CW - fullW - 84, bandH - 16, detail, t.body(20, { color: k === 0 ? g.ink : muted })));
    }
  });
  nodes.push(...note(K, g, c.note));
  return { name: "Funnel", bg: g.bg, nodes, drawings: [] };
}

// --- ledger -------------------------------------------------------------------------

export interface LedgerContent { eyebrow: string; title: string; rows: [string, string][]; total?: [string, string]; footnote?: string; note?: string }

/** Lines of a ledger: a label, a dotted leader, a figure set in the
 *  numeral face, and the total ruled off in the accent. */
export function ledger(K: KitLook, i: number, c: LedgerContent): Slide {
  const g = K.paper;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title, { titleWidth: 1100 });
  const rows = c.rows.slice(0, 8);
  const x = M, w = 1240;
  const rowH = rows.length > 6 ? 62 : 74;
  rows.forEach(([label, value], k) => {
    const y = bodyTop + k * rowH;
    nodes.push(text(x, y + 8, 700, rowH - 16, label, t.strong(rowH > 65 ? 24 : 21, { weight: 500 })));
    const vw = Math.min(360, Math.round(estWidth(value, 30, 0.62)) + 24);
    for (let dx = 720; dx < w - vw - 16; dx += 14) nodes.push(ellipse(x + dx, y + rowH / 2 - 2, 3, 3, g.line, { decor: true }));
    nodes.push(text(x + w - vw, y + 6, vw, rowH - 12, value, { family: K.numeralFace ?? K.display, size: rowH > 65 ? 30 : 26, weight: K.numeralWeight ?? K.dw, color: g.ink, align: "right", lineHeight: 1.2, cw: 0.62, name: "Figure" }));
  });
  if (c.total) {
    const y = bodyTop + rows.length * rowH + 16;
    nodes.push(rect(x, y, w, 3, g.accent, { decor: true }));
    nodes.push(text(x, y + 24, 700, 48, c.total[0], t.display(30)));
    nodes.push(text(x + w - 460, y + 18, 460, 60, c.total[1], t.numeral(52, { align: "right" })));
  }
  // A deep note card at right, the accountant's margin.
  const d = K.deep;
  const td = type(K, d);
  const cx = M + w + 60, cw = CW - w - 60, cy = bodyTop, ch = 420;
  nodes.push(deepCard(K, cx, cy, cw, ch));
  nodes.push(...sparkles(d.accent, 51 + i, 5, { x: cx + 20, y: cy + 20, w: cw - 40, h: 160 }));
  nodes.push(text(cx + 36, cy + 40, cw - 72, 26, c.eyebrow || "In short", td.eyebrow({ size: 16 })));
  if (c.footnote) nodes.push(text(cx + 36, cy + 84, cw - 72, ch - 120, c.footnote, td.display(fitSize(c.footnote, 32, (cw - 72) * 3.6, 0.7, K.charWidth ?? 0.56), { lineHeight: 1.2 })));
  nodes.push(...note(K, g, c.note));
  return { name: "Ledger", bg: g.bg, nodes, drawings: [] };
}

// --- sticky wall ----------------------------------------------------------------------

export interface StickyWallContent { eyebrow: string; title: string; notes: string[]; theme?: string; note?: string }

/** Points as notes on a wall: tinted squares, each turned a degree or two,
 *  set in the body face with the theme in the hand. */
export function stickyWall(K: KitLook, i: number, c: StickyWallContent): Slide {
  const g = K.paper;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title, { titleWidth: 1000 });
  const notes = c.notes.slice(0, 8);
  const cols = notes.length <= 4 ? notes.length : 4;
  const rows = Math.ceil(notes.length / cols);
  const gap = 28;
  const nw = Math.min(400, Math.floor((CW - (cols - 1) * gap) / cols));
  const nh = Math.min(300, Math.floor((940 - bodyTop - 40 - (rows - 1) * gap) / rows));
  const x0 = M + Math.round((CW - (cols * nw + (cols - 1) * gap)) / 2);
  const tints = [mixHex(g.panel, g.accent, 0.28), mixHex(g.panel, g.accent2, 0.24), mixHex(g.panel, g.sun ?? g.accent, 0.34), g.panel2];
  const rots = [-2, 1.5, -1, 2, 1, -1.5, 2, -2];
  notes.forEach((n, k) => {
    const col = k % cols, row = Math.floor(k / cols);
    const x = x0 + col * (nw + gap), y = bodyTop + 20 + row * (nh + gap);
    nodes.push(rect(x, y, nw, nh, tints[k % tints.length], { rotation: rots[k % rots.length], radius: 2, panel: true }));
    nodes.push(rect(x + nw / 2 - 40, y - 6, 80, 14, mixHex(g.bg, g.ink, 0.12), { opacity: 0.7, decor: true }));
    nodes.push(text(x + 28, y + 30, nw - 56, nh - 60, n, t.strong(nh > 220 ? 24 : 21, { weight: 500, lineHeight: 1.35 })));
  });
  if (c.theme) nodes.push(text(M + 1040, 130, CW - 1040, 60, c.theme, t.kicker({ align: "right", size: Math.round(K.accentSize * 0.85) })));
  nodes.push(...note(K, g, c.note));
  return { name: "Sticky wall", bg: g.bg, nodes, drawings: [] };
}

// --- matrix ---------------------------------------------------------------------------

export interface MatrixContent { eyebrow: string; title: string; axes?: [string, string, string, string]; quadrants: [string, string[]][]; note?: string }

/** Four quadrants on two axes, one of them on the deep ground: the one
 *  that matters. */
export function matrix(K: KitLook, i: number, c: MatrixContent): Slide {
  const g = K.paper;
  const d = K.deep;
  const t = type(K, g);
  const td = type(K, d);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title, { titleWidth: 1100 });
  const gx = M + 120, gy = bodyTop, gw = CW - 160, gh = 940 - bodyTop - 60;
  const qw = (gw - 24) / 2, qh = (gh - 24) / 2;
  const quads = c.quadrants.slice(0, 4);
  quads.forEach(([head, lines], k) => {
    const x = gx + (k % 2) * (qw + 24), y = gy + Math.floor(k / 2) * (qh + 24);
    const hot = k === 1;
    if (hot) nodes.push(deepCard(K, x, y, qw, qh));
    else nodes.push(card(K, g, x, y, qw, qh));
    const tt = hot ? td : t;
    nodes.push(text(x + 32, y + 28, qw - 64, 40, head, tt.display(28)));
    lines.slice(0, 3).forEach((l, j) => {
      const ly = y + 84 + j * Math.min(64, (qh - 100) / 3);
      nodes.push(ellipse(x + 32, ly + 8, 10, 10, hot ? d.accent : g.accent, { decor: true }));
      nodes.push(text(x + 56, ly, qw - 88, Math.min(60, (qh - 100) / 3) - 4, l, tt.body(20, { color: hot ? d.ink : g.muted })));
    });
  });
  if (c.axes) {
    const [xLow, xHigh, yLow, yHigh] = c.axes;
    nodes.push(text(gx, gy + gh + 16, qw, 26, xLow, t.eyebrow({ size: 15 })));
    nodes.push(text(gx + qw + 24, gy + gh + 16, qw, 26, xHigh, t.eyebrow({ size: 15, align: "right" })));
    nodes.push(text(M, gy + 8, 100, 60, yHigh, t.eyebrow({ size: 15, lineHeight: 1.3 })));
    nodes.push(text(M, gy + gh - 68, 100, 60, yLow, t.eyebrow({ size: 15, lineHeight: 1.3 })));
    nodes.push(rect(gx - 30, gy, 2, gh, g.line, { decor: true }));
    nodes.push(rect(gx, gy + gh + 4, gw, 2, g.line, { decor: true }));
  }
  nodes.push(...note(K, g, c.note));
  return { name: "Matrix", bg: g.bg, nodes, drawings: [] };
}

// --- run of show ------------------------------------------------------------------------

export interface RunOfShowContent { eyebrow: string; title: string; slots: [string, string, string][]; note?: string }

/** A run sheet: time-stamped blocks down the page, each tinted in turn,
 *  the first on the deep ground. */
export function runOfShow(K: KitLook, i: number, c: RunOfShowContent): Slide {
  const g = K.paper;
  const d = K.deep;
  const t = type(K, g);
  const td = type(K, d);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title, { titleWidth: 1100 });
  const slots = c.slots.slice(0, 6);
  const n = Math.max(1, slots.length);
  const gap = 10;
  const bh = Math.min(120, Math.floor((940 - bodyTop - 20 - (n - 1) * gap) / n));
  slots.forEach(([when, label, detail], k) => {
    const y = bodyTop + k * (bh + gap);
    const hot = k === 0;
    const tint = hot ? deepGround(d) : k % 2 ? mixHex(g.bg, g.accent2, 0.1) : mixHex(g.bg, g.accent, 0.1);
    nodes.push(rect(M, y, CW, bh, tint, { radius: Math.min(K.radius, 14), panel: true }));
    const tt = hot ? td : t;
    const gg = hot ? d : g;
    nodes.push(ellipse(M + 24, y + 22, 12, 12, gg.accent, { decor: true }));
    nodes.push(text(M + 52, y + 14, 150, 30, when, { family: K.mono ?? K.body, size: 22, weight: 600, color: gg.accentInk ?? gg.accent, lineHeight: 1.2, cw: 0.6 }));
    nodes.push(text(M + 220, y + 12, 720, 36, label, tt.display(26)));
    if (detail) nodes.push(text(M + 220, y + 50, CW - 260, bh - 58, detail, tt.body(bh > 90 ? 19 : 17)));
  });
  nodes.push(...note(K, g, c.note));
  return { name: "Run of show", bg: g.bg, nodes, drawings: [] };
}

// --- poll -------------------------------------------------------------------------------

export interface PollContent { eyebrow: string; title: string; bars: [string, number, string][]; footnote?: string; note?: string }

/** Horizontal bars to scale, the largest in the accent, each with its
 *  label and its figure. */
export function poll(K: KitLook, i: number, c: PollContent): Slide {
  const g = K.paper;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title, { titleWidth: 1100 });
  const bars = c.bars.slice(0, 6);
  const max = Math.max(1, ...bars.map((b) => b[1]));
  const n = Math.max(1, bars.length);
  const rowH = Math.min(110, Math.floor((940 - bodyTop - 60) / n));
  const barW = 1180;
  const top = bars.findIndex((b) => b[1] === max);
  bars.forEach(([label, v, txt], k) => {
    const y = bodyTop + k * rowH;
    nodes.push(text(M, y, 700, 32, label, t.strong(22, { weight: 500 })));
    nodes.push(rect(M, y + 42, barW, 26, g.panel, { radius: 13, panel: true }));
    const w = Math.max(26, Math.round((barW * v) / max));
    nodes.push(rect(M, y + 42, w, 26, k === top ? g.accent : mixHex(g.accent2, g.panel, 0.25), { radius: 13, decor: true }));
    nodes.push(text(M + barW + 40, y + 26, CW - barW - 40, 52, txt, t.numeral(40, { align: "right", color: k === top ? (g.accentInk ?? g.accent) : g.ink })));
  });
  if (c.footnote) nodes.push(text(M, 940 - 40, CW, 28, c.footnote, t.meta()));
  nodes.push(...note(K, g, c.note));
  return { name: "Poll", bg: g.bg, nodes, drawings: [] };
}

// --- definition -------------------------------------------------------------------------

export interface DefinitionContent { term: string; kind?: string; senses: string[]; example?: string; note?: string }

/** A dictionary entry: the term at display scale, its kind in the mono
 *  face, numbered senses, and an example in the hand. */
export function definition(K: KitLook, i: number, c: DefinitionContent): Slide {
  const g = K.paper;
  const t = type(K, g);
  const nodes: Prim[] = [...ornamentPaper(K, g), ...footer(K, g, i)];
  const cw = K.charWidth ?? 0.56;
  const size = fitSize(c.term, K.scale.statement * 1.3, 1500, 0.5, cw);
  nodes.push(text(M, 200, 1500, Math.round(size * 1.1) + 10, c.term, t.display(size, { lineHeight: 1.02, name: "Title" })));
  const ky = 200 + Math.round(size * 1.1) + 24;
  if (c.kind) nodes.push(text(M, ky, 900, 30, c.kind, t.meta({ size: 22, color: g.accentInk ?? g.accent })));
  nodes.push(rect(M, ky + 50, 120, 4, g.accent, { decor: true }));
  const senses = c.senses.slice(0, 4);
  let y = ky + 84;
  senses.forEach((s, k) => {
    const lines = Math.max(1, Math.min(3, linesFor(s, 26, 1300, 0.5)));
    const h = Math.round(26 * 1.4 * lines) + 6;
    nodes.push(text(M, y, 60, 40, `${k + 1}.`, t.numeral(28)));
    nodes.push(text(M + 70, y, 1300, h, s, t.body(26, { color: g.ink })));
    y += h + 22;
  });
  if (c.example) nodes.push(text(M + 70, Math.min(y + 12, 940 - 80), 1300, 70, `“${c.example}”`, t.kicker({ size: Math.round(K.accentSize * 0.85) })));
  nodes.push(...note(K, g, c.note));
  return { name: "Definition", bg: g.bg, nodes, drawings: [] };
}

// --- health grid -------------------------------------------------------------------------

export interface HealthGridContent { eyebrow: string; title: string; tiles: [string, string, string][]; note?: string }

/** The tone a status reads in: green for on track, amber for at risk, red
 *  for off track or blocked, the muted ink for anything else. */
export function statusTone(status: string): "good" | "warn" | "bad" | "plain" {
  const s = status.toLowerCase();
  if (/on track|done|complete|green|healthy|shipped|met|ahead|yes/.test(s)) return "good";
  if (/risk|amber|yellow|slip|watch|late|partial|behind/.test(s)) return "warn";
  if (/off track|blocked|red|missed|fail|critical|stopped|no\b/.test(s)) return "bad";
  return "plain";
}

/** Tiles in a grid, each a name and a status pill in its tone, with a line. */
export function healthGrid(K: KitLook, i: number, c: HealthGridContent): Slide {
  const g = K.paper;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
  const tiles = c.tiles.slice(0, 8);
  const cols = tiles.length <= 3 ? tiles.length : tiles.length === 4 ? 2 : tiles.length <= 6 ? 3 : 4;
  const rows = Math.ceil(tiles.length / cols);
  const gap = 24;
  const tw = (CW - (cols - 1) * gap) / cols;
  const th = Math.min(300, Math.floor((940 - bodyTop - 20 - (rows - 1) * gap) / rows));
  const tones = { good: "#2E8B57", warn: "#D08A1E", bad: "#C8372D", plain: g.muted };
  tiles.forEach(([label, status, detail], k) => {
    const x = M + (k % cols) * (tw + gap), y = bodyTop + Math.floor(k / cols) * (th + gap);
    const tone = tones[statusTone(status)];
    nodes.push(card(K, g, x, y, tw, th));
    nodes.push(rect(x, y, 6, th, tone, { radius: 0, decor: true }));
    nodes.push(text(x + 32, y + 28, tw - 64, 40, label, t.display(th > 200 ? 28 : 24)));
    const pw = Math.min(tw - 64, Math.round(estWidth(status, 15, 0.6)) + 40);
    nodes.push(button(x + 32, y + (th > 200 ? 80 : 70), pw, 32, status, { fill: mixHex(g.panel, tone, 0.18), color: tone, family: K.body, size: 15, weight: 700, upper: true, letterSpacing: 1 }));
    if (detail && th > 150) nodes.push(text(x + 32, y + (th > 200 ? 132 : 116), tw - 64, th - (th > 200 ? 150 : 130), detail, t.body(19)));
  });
  nodes.push(...note(K, g, c.note));
  return { name: "Health grid", bg: g.bg, nodes, drawings: [] };
}

export const SIGNATURES = { scoreboard, beforeAfter, funnel, ledger, stickyWall, matrix, runOfShow, poll, definition, healthGrid };
// Unused-import guard for helpers shared with the layouts module.
void halo; void inkOn;
