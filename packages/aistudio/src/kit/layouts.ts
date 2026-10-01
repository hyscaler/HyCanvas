// The kit's layouts: one slide each, hand-set slot by slot, taking content
// from the outline and style from the look. Ported from the presentation
// template library so a generated deck is built from the same forms as the
// signature templates: two grounds with a rhythm between them, one grid on
// every slide, depth by layering on the deep pages, a halo that lights the
// subject, sparkle where no text sits, several voices of type each with one
// job, a warm accent on a cool ground, cards whose chrome carries
// information, and no empty slot anywhere.
//
// Every layout returns primitives in page space at 1920 by 1080; the
// compiler (spec.ts) makes nodes of them and scales to the deck's page.

import {
  CW, H, M, W, card, chrome, confetti, confettiColors, deepCard, deepGround, estWidth, fitSize, footer, halo, inkOn, isDark, linesFor, mark, mixHex, note, ornamentDeep, ornamentPaper, pageNo, peepFor, sparkles, type,
  type KitLook,
} from "./look";
import { button, drawing, ellipse, icon, photo, rect, text, type DrawingPrim, type Prim, type SpecFill } from "./spec";

export interface Slide { name: string; bg: SpecFill; nodes: Prim[]; drawings: DrawingPrim[] }

/** A picture slot's picture: the placeholder the image pipeline fills, or
 *  nothing, in which case the slot carries a drawing in a halo. */
export interface PictureIntent { placeholderId: string; prompt: string }

const numeralLabel = (K: KitLook, g: ReturnType<typeof paperOf>, size: number) => ({ family: K.display, size, weight: K.dw, color: g.accentInk ?? g.accent, align: "center" as const, vAlign: "middle" as const, lineHeight: 1, fixed: true, cw: 0.6 });
const paperOf = (K: KitLook) => K.paper;

// --- cover ---------------------------------------------------------------------

export interface CoverContent {
  title: string;
  subtitle?: string;
  presenter?: string;
  presenterName?: string;
  when?: string;
  where?: string;
  chips?: [string, string][];
  tag?: string;
  art?: string;
  note?: string;
}

export function cover(K: KitLook, i: number, c: CoverContent): Slide {
  const g = K.deep;
  const t = type(K, g);
  const nodes: Prim[] = [...ornamentDeep(K, g, { mark: true })];
  const drawings: DrawingPrim[] = [];
  const centered = K.ornament === "hairlines";
  nodes.push(...mark(K, g));
  const textW = 1000;
  const cw = K.charWidth ?? 0.56;
  const coverSize = fitSize(c.title, K.scale.cover, centered ? 1500 : textW, 0.6, cw);
  const coverLines = c.title.split("\n").length;
  const titleH = Math.round(coverSize * 1.05 * coverLines) + 10;
  const subtitle = c.subtitle ?? "";
  if (centered) {
    nodes.push(...halo(W / 2, 330, 400, g.accent));
    if (c.art) drawings.push(drawing(c.art, W / 2 - 170, 190, 340, 280));
    if (K.kicker) nodes.push(text(M, 500, CW, 56, K.kicker, t.kicker({ align: "center" })));
    nodes.push(text(M, 560, CW, titleH, c.title, t.display(coverSize, { lineHeight: 1.02, align: "center", name: "Title" })));
    if (subtitle) nodes.push(text(W / 2 - 500, 560 + titleH + 24, 1000, 80, subtitle, t.body(26, { align: "center", color: g.muted })));
    const cols: [string, string][] = [];
    if (c.presenterName) cols.push(["Presented by", c.presenterName]);
    if (c.when) cols.push(["When", c.when]);
    if (c.where) cols.push(["Where", c.where]);
    const rowY = 900;
    const x0 = W / 2 - (cols.length * 440) / 2;
    cols.forEach(([l, v], k) => {
      const x = x0 + k * 440;
      nodes.push(text(x, rowY, 440, 24, l, t.eyebrow({ align: "center", size: 15 })));
      nodes.push(text(x, rowY + 30, 440, 34, v, t.strong(24, { align: "center" })));
      if (k > 0) nodes.push(rect(x - 1, rowY + 4, 1, 60, g.line, { decor: true }));
    });
    if (K.total > 1) nodes.push(text(W - M - 240, H - 50, 240, 28, pageNo(i, K.total), t.meta({ align: "right", name: "Page number", fixed: true })));
    nodes.push(...note(K, g, c.note, true, { x: W / 2 - 360, y: 800, w: 720 }));
    return { name: "Cover", bg: deepGround(g), nodes, drawings };
  }
  // The cover's construction follows the ornament family, so the deck's
  // silhouettes differ across styles: words beside a lit drawing (the
  // default), a typographic page with the drawing small (watermark), a band
  // along the foot carrying the facts (stripes, corner, orbs), or the words
  // high and the drawing low on the ornament's horizon (sun, ridges, dots,
  // arcs, rules).
  const construction: "typographic" | "band" | "stacked" | "split" =
    K.ornament === "watermark" ? "typographic" :
    K.ornament === "stripes" || K.ornament === "corner" || K.ornament === "orbs" ? "band" :
    K.ornament === "sun" || K.ornament === "ridges" || K.ornament === "dots" || K.ornament === "arcs" || K.ornament === "rules" ? "stacked" : "split";
  const presenterLine = c.presenter ?? [c.presenterName, c.when].filter(Boolean).join("  ·  ");
  const chips = (x0: number, y0: number) => {
    (c.chips ?? []).slice(0, 3).forEach(([n, l], k) => {
      const x = x0 + k * 300;
      nodes.push(rect(x, y0, 276, 64, g.panel, { radius: K.radius, stroke: g.line, strokeWidth: 1.5, panel: true }));
      nodes.push(text(x + 20, y0 + 12, 130, 40, n, t.numeral(26, { family: K.mono ?? K.numeralFace ?? K.display })));
      nodes.push(text(x + 150, y0 + 20, 110, 26, l, t.meta({ size: 16 })));
    });
  };
  const wordsAt = (top: number, width: number, size: number) => {
    const lines = c.title.split("\n").length;
    const th = Math.round(size * 1.05 * lines) + 10;
    if (K.kicker) nodes.push(text(M, top, width, Math.round(K.accentSize * 1.3), K.kicker, t.kicker()));
    const ty = top + Math.round(K.accentSize * 1.3) + 16;
    nodes.push(text(M, ty, width, th, c.title, t.display(size, { lineHeight: 1.02, name: "Title" })));
    let y = ty + th + 30;
    if (subtitle) {
      const subLines = Math.max(1, Math.min(3, linesFor(subtitle, 28, Math.min(width, 900), 0.5)));
      nodes.push(text(M, y, Math.min(width, 900), subLines * 40, subtitle, t.body(28)));
      y += subLines * 40;
    }
    return y;
  };
  if (construction === "typographic") {
    const size = fitSize(c.title, K.scale.cover * 1.18, 1500, 0.5, cw);
    const after = wordsAt(236, 1500, size);
    if (presenterLine) nodes.push(text(M, 940, 900, 28, presenterLine, t.meta()));
    if (K.total > 1) nodes.push(text(W - M - 240, 940, 240, 28, pageNo(i, K.total), t.meta({ align: "right", name: "Page number", fixed: true })));
    chips(M, Math.max(after + 24, 760));
    nodes.push(...halo(1640, 800, 280, g.accent));
    if (c.art) drawings.push(drawing(c.art, 1520, 680, 240, 240));
    nodes.push(...note(K, g, c.note, true, { x: 1040, y: 700, w: 440, align: "right" }));
    return { name: "Cover", bg: deepGround(g), nodes, drawings };
  }
  if (construction === "band") {
    nodes.push(rect(0, 772, W, H - 772, g.panel, { decor: true }));
    nodes.push(rect(0, 772, W, 2, g.line, { decor: true }));
    wordsAt(236, textW, coverSize);
    if (presenterLine) nodes.push(text(M, c.chips?.length ? 908 : 880, 900, 28, presenterLine, t.meta()));
    if (K.total > 1) nodes.push(text(W - M - 240, c.chips?.length ? 908 : 880, 240, 28, pageNo(i, K.total), t.meta({ align: "right", name: "Page number", fixed: true })));
    chips(M, 808);
    // Under the corner triangle's edge (it runs from (1460, 0) to (1920, 460))
    // the drawing sits lower and further left; elsewhere it fills the corner.
    if (K.ornament === "corner") {
      nodes.push(...halo(1390, 470, 560, g.accent));
      if (c.art) drawings.push(drawing(c.art, 1150, 230, 480, 480));
    } else {
      nodes.push(...halo(1500, 400, 600, g.accent));
      if (c.art) drawings.push(drawing(c.art, 1240, 150, 520, 500));
    }
    nodes.push(...note(K, g, c.note, true, { x: 1100, y: 830, w: 720, align: "right" }));
    return { name: "Cover", bg: deepGround(g), nodes, drawings };
  }
  if (construction === "stacked") {
    const after = wordsAt(180, textW, coverSize);
    if (presenterLine) nodes.push(text(M, 940, 900, 28, presenterLine, t.meta()));
    if (K.total > 1) nodes.push(text(W - M - 240, 940, 240, 28, pageNo(i, K.total), t.meta({ align: "right", name: "Page number", fixed: true })));
    // The aside follows the words, in the left column, clear of the sun or
    // moon the ornament hangs in the top right; the chips move under it.
    const asideNodes = note(K, g, c.note, true, { x: M, y: after + 24, w: 760, align: "left" });
    nodes.push(...asideNodes);
    chips(M, Math.max(after + 24 + (asideNodes.length ? 112 : 0), 848));
    // The drawing sits low on the ornament's horizon and clear of the footer line.
    nodes.push(...halo(1480, 650, 560, g.accent));
    if (c.art) drawings.push(drawing(c.art, 1220, 400, 520, 500));
    return { name: "Cover", bg: deepGround(g), nodes, drawings };
  }
  if (K.kicker) nodes.push(text(M, 372, textW, Math.round(K.accentSize * 1.3), K.kicker, t.kicker()));
  nodes.push(text(M, 446, textW, titleH, c.title, t.display(coverSize, { lineHeight: 1.02, name: "Title" })));
  let y = 446 + titleH + 30;
  if (subtitle) {
    const subLines = Math.max(1, Math.min(3, linesFor(subtitle, 28, 900, 0.5)));
    nodes.push(text(M, y, 900, subLines * 40, subtitle, t.body(28)));
    y += subLines * 40;
  }
  if (presenterLine) nodes.push(text(M, 940, 900, 28, presenterLine, t.meta()));
  if (K.total > 1) nodes.push(text(W - M - 240, 940, 240, 28, pageNo(i, K.total), t.meta({ align: "right", name: "Page number", fixed: true })));
  chips(M, 848);
  switch (K.ornament) {
    case "blocks":
      nodes.push(rect(1272, 0, 648, H, g.accent, { decor: true }));
      nodes.push(ellipse(1316, 260, 560, 560, g.ink, { opacity: 0.18, decor: true }));
      nodes.push(...confetti(confettiColors(g), 4, 8, { x: 1290, y: 80, w: 610, h: 920 }));
      if (c.tag) nodes.push(text(1330, 96, 500, 48, c.tag, t.display(40, { align: "right", color: inkOn(K, g.accent) })));
      if (c.art) drawings.push(drawing(c.art, 1336, 300, 520, 480));
      break;
    case "glow":
      nodes.push(...halo(1500, 470, 640, g.accent));
      if (c.art) drawings.push(drawing(c.art, 1230, 200, 540, 540));
      break;
    case "blobs":
      nodes.push(ellipse(1180, 200, 660, 660, g.panel2, { decor: true }));
      nodes.push(...halo(1510, 530, 700, g.sun ?? g.accent));
      if (c.art) drawings.push(drawing(c.art, 1230, 240, 560, 580));
      break;
    case "crosshairs":
      nodes.push(rect(1176, 0, 744, H, g.panel, { decor: true }));
      nodes.push(rect(1176, 0, 4, H, g.accent, { decor: true }));
      nodes.push(...halo(1548, 540, 620, g.accent));
      if (c.art) drawings.push(drawing(c.art, 1260, 260, 580, 560));
      break;
    default:
      nodes.push(...halo(1500, 520, 700, g.accent));
      if (c.art) drawings.push(drawing(c.art, 1210, 230, 580, 580));
      break;
  }
  nodes.push(...note(K, g, c.note, true));
  return { name: "Cover", bg: deepGround(g), nodes, drawings };
}

// --- agenda --------------------------------------------------------------------

export interface AgendaContent {
  eyebrow: string;
  title: string;
  /** Heading, line under it, and a short tag (a duration, a page) per item. */
  items: [string, string, string][];
  card: { eyebrow: string; big: string; meta: [string, string][] };
  note?: string;
}

export function agenda(K: KitLook, i: number, c: AgendaContent): Slide {
  const g = K.paper;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
  const n = c.items.length;
  const rowH = n > 5 ? 96 : 118;
  c.items.forEach(([h, s, d], k) => {
    const y = bodyTop + k * rowH;
    nodes.push(text(M, y + 6, 96, 60, String(k + 1).padStart(2, "0"), t.numeral(rowH > 100 ? 44 : 36)));
    nodes.push(text(M + 120, y + 4, 900, s ? 44 : rowH - 28, h, t.display(rowH > 100 ? 34 : 28, s ? {} : { lineHeight: 1.1 })));
    if (s) nodes.push(text(M + 120, y + (rowH > 100 ? 50 : 42), 900, 30, s, t.body(rowH > 100 ? 21 : 18)));
    if (d) nodes.push(button(M + 1040, y + 8, 160, 34, d, { fill: mixHex(g.panel, g.accent, 0.16), color: g.accentInk ?? g.accent, family: K.body, size: 15, weight: 700 }));
    nodes.push(rect(M, y + rowH - 12, 1204, 1, g.line, { decor: true }));
  });
  const d = K.deep;
  const td = type(K, d);
  const cx = 1396, cy = bodyTop, cw = 428, ch = Math.max(360, Math.min(560, n * rowH - 12));
  nodes.push(deepCard(K, cx, cy, cw, ch));
  nodes.push(rect(cx, cy, cw, 6, d.accent, { decor: true }));
  nodes.push(text(cx + 40, cy + 40, cw - 80, 28, c.card.eyebrow, td.eyebrow()));
  nodes.push(text(cx + 40, cy + 80, cw - 80, 120, c.card.big, td.display(fitSize(c.card.big, 76, cw - 80, 0.5, K.charWidth ?? 0.56))));
  c.card.meta.forEach(([l, v], k) => {
    const my = cy + 236 + k * 74;
    if (my + 64 > cy + ch) return;
    nodes.push(text(cx + 40, my, 200, 26, l, td.meta()));
    nodes.push(text(cx + 40, my + 28, cw - 80, 30, v, td.strong(22)));
    if (k < c.card.meta.length - 1) nodes.push(rect(cx + 40, my + 64, cw - 80, 1, d.line, { decor: true }));
  });
  nodes.push(...note(K, g, c.note));
  return { name: "Agenda", bg: g.bg, nodes, drawings: [] };
}

// --- section -------------------------------------------------------------------

export interface SectionContent { n?: string; title: string; blurb?: string; art?: string; kicker?: string; wide?: boolean; note?: string }

export function section(K: KitLook, i: number, c: SectionContent): Slide {
  const g = K.deep;
  const t = type(K, g);
  const nodes: Prim[] = [...ornamentDeep(K, g)];
  const drawings: DrawingPrim[] = [];
  const cw = K.charWidth ?? 0.56;
  if (K.ornament === "blocks") {
    nodes.push(rect(0, 0, 360, H, g.accent, { decor: true }));
    if (c.n) nodes.push(text(48, 300, 300, 260, c.n, t.display(K.scale.section, { color: inkOn(K, g.accent), align: "left", name: "Section number", fixed: true })));
    const kicker = c.kicker ?? K.kicker;
    if (kicker) nodes.push(text(460, 340, 1000, 50, kicker, t.kicker()));
    const tl = Math.max(1, Math.min(2, linesFor(c.title, 96, 1000, cw)));
    nodes.push(text(460, 400, 1000, Math.round(96 * 1.04 * tl) + 12, c.title, t.display(96, { lineHeight: 1.04, name: "Title" })));
    if (c.blurb) nodes.push(text(460, 400 + Math.round(96 * 1.04 * tl) + 40, 900, 90, c.blurb, t.body(28)));
    nodes.push(...confetti([g.lime ?? g.accent2, g.accent, g.ink], 8, 6, { x: 1380, y: 120, w: 480, h: 840 }));
    if (c.art) drawings.push(drawing(c.art, 1400, 300, 440, 440));
  } else {
    const top = c.n ? 236 + K.scale.section + 20 : 330;
    if (c.n) nodes.push(text(M, 236, 800, K.scale.section + 20, c.n, t.numeral(K.scale.section, { name: "Section number", fixed: true })));
    nodes.push(rect(M, top, 120, 4, g.accent, { decor: true }));
    const tl = Math.max(1, Math.min(2, linesFor(c.title, 96, 1100, cw)));
    nodes.push(text(M, top + 28, 1100, Math.round(96 * 1.04 * tl) + 12, c.title, t.display(96, { lineHeight: 1.04, name: "Title" })));
    if (c.blurb) nodes.push(text(M, top + 28 + Math.round(96 * 1.04 * tl) + 32, 900, 90, c.blurb, t.body(28)));
    nodes.push(...halo(1520, 560, 560, g.accent));
    if (c.art) drawings.push(c.wide ? drawing(c.art, 1200, 380, 640, 400) : drawing(c.art, 1300, 340, 440, 440));
    const kicker = c.kicker ?? K.kicker;
    if (kicker) nodes.push(text(M, 180, 1000, 50, kicker, t.kicker()));
  }
  nodes.push(...footer(K, g, i));
  nodes.push(...note(K, g, c.note, true));
  return { name: "Section", bg: deepGround(g), nodes, drawings };
}

// --- statement -----------------------------------------------------------------

export interface StatementContent { text: string; source?: string; kicker?: string; note?: string }

export function statement(K: KitLook, i: number, c: StatementContent): Slide {
  const g = K.paper;
  const t = type(K, g);
  const nodes: Prim[] = [...ornamentPaper(K, g), ...footer(K, g, i)];
  const kh = Math.round(K.accentSize * 1.3);
  const kicker = c.kicker ?? K.kicker;
  if (kicker) nodes.push(text(M, 236, 1000, kh, kicker, t.kicker()));
  nodes.push(rect(M, 236 + kh + 14, 120, 6, g.accent, { decor: true }));
  const y = 236 + kh + 60;
  let size = K.scale.statement;
  const cw = K.charWidth ?? 0.56;
  while (size > K.scale.statement * 0.6 && linesFor(c.text, size, 1560, cw) > 3) size -= 4;
  const lines = Math.max(1, Math.min(3, linesFor(c.text, size, 1560, cw)));
  nodes.push(text(M, y, 1560, Math.round(size * 1.12 * lines) + 10, c.text, t.display(size, { lineHeight: 1.1, name: "Statement" })));
  if (c.source) nodes.push(text(M, y + Math.round(size * 1.12 * lines) + 50, 1200, 60, c.source, t.body(24)));
  nodes.push(...note(K, g, c.note));
  return { name: "Statement", bg: g.bg, nodes, drawings: [] };
}

// --- text and picture ----------------------------------------------------------

export interface TextPictureContent {
  eyebrow: string;
  title: string;
  /** Heading and a line under it, per point. */
  points: [string, string][];
  art?: string;
  picture?: PictureIntent | null;
  note?: string;
}

/** The picture slot of a reading page: the placeholder the pipeline fills,
 *  else a tinted shape with a drawing in a halo on it. */
function pictureSlot(K: KitLook, g: KitLook["paper"], box: { x: number; y: number; w: number; h: number }, art: string | undefined, picture: PictureIntent | null | undefined, haloSize: number, artBox: { x: number; y: number; w: number; h: number }, radius: number): { nodes: Prim[]; drawings: DrawingPrim[] } {
  const tint: SpecFill = { angle: 160, stops: [[mixHex(g.panel, g.accent2, 0.22), 0], [g.panel, 1]] };
  if (picture) return { nodes: [photo(box.x, box.y, box.w, box.h, tint, { radius, placeholderId: picture.placeholderId, prompt: picture.prompt })], drawings: [] };
  const nodes: Prim[] = [photo(box.x, box.y, box.w, box.h, tint, { radius }), ...halo(box.x + box.w / 2, box.y + box.h / 2, haloSize, g.accent)];
  return { nodes, drawings: art ? [drawing(art, artBox.x, artBox.y, artBox.w, artBox.h)] : [] };
}

export function textPicture(K: KitLook, i: number, c: TextPictureContent): Slide {
  const g = K.paper;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title, { titleWidth: 960 });
  const n = c.points.length;
  const step = n <= 3 ? 178 : 150;
  c.points.forEach(([h, s], k) => {
    const y = bodyTop + 24 + k * step;
    nodes.push(ellipse(M, y + 4, 34, 34, mixHex(g.panel, g.accent, 0.18), { panel: true }));
    nodes.push(text(M, y + 4, 34, 34, String(k + 1), numeralLabel(K, g, 17)));
    if (s) {
      nodes.push(text(M + 56, y, 840, 44, h, t.display(n <= 3 ? 32 : 28)));
      nodes.push(text(M + 56, y + (n <= 3 ? 52 : 44), 840, n <= 3 ? 70 : 60, s, t.body(n <= 3 ? 22 : 20)));
    } else if (h.length <= 48) {
      nodes.push(text(M + 56, y, 840, step - 40, h, t.display(n <= 3 ? 30 : 26, { lineHeight: 1.15 })));
    } else {
      // A long point with no line is a sentence, not a heading: the body
      // face, strong, holds three lines where the display face held two.
      nodes.push(text(M + 56, y, 840, step - 30, h, t.strong(n <= 3 ? 24 : 22, { weight: 500, lineHeight: 1.3 })));
    }
  });
  const slot = pictureSlot(K, g, { x: 1080, y: 196, w: 744, h: 690 }, c.art, c.picture, 500, { x: 1160, y: 270, w: 584, h: 540 }, K.radius * 1.5);
  nodes.push(...slot.nodes);
  nodes.push(...note(K, g, c.note));
  return { name: "Text and picture", bg: g.bg, nodes, drawings: slot.drawings };
}

// --- two columns ---------------------------------------------------------------

export interface ColumnContent { eyebrow: string; head: string; lines: string[]; icon?: string }
export interface TwoColumnsContent { eyebrow: string; title: string; left: ColumnContent; right: ColumnContent; note?: string }

export function twoColumns(K: KitLook, i: number, c: TwoColumnsContent): Slide {
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
    else nodes.push(deepCard(K, col.x, y, colW, h));
    if (col.icon) nodes.push(icon(col.icon, col.x + colW - 88, y + 44, 40, col.g.accentInk ?? col.g.accent));
    nodes.push(text(col.x + 48, y + 48, colW - 160, 28, col.eyebrow, col.ty.eyebrow()));
    nodes.push(text(col.x + 48, y + 92, colW - 96, 112, col.head, col.ty.display(40, { lineHeight: 1.1 })));
    const rows = col.lines.slice(0, 4);
    const rowH = rows.length > 3 ? 82 : 100;
    rows.forEach((l, k) => {
      const ly = y + 260 + k * rowH;
      nodes.push(rect(col.x + 48, ly, colW - 96, 1, col.g.line, { decor: true }));
      nodes.push(text(col.x + 48, ly + 20, colW - 96, rowH - 28, l, col.ty.strong(rows.length > 3 ? 22 : 24)));
    });
  });
  nodes.push(...note(K, g, c.note));
  return { name: "Two columns", bg: g.bg, nodes, drawings: [] };
}

// --- three cards ---------------------------------------------------------------

export interface ThreeCardsContent { eyebrow: string; title: string; cards: [string, string, string][]; note?: string }

export function threeCards(K: KitLook, i: number, c: ThreeCardsContent): Slide {
  const g = K.paper;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
  const n = Math.max(1, c.cards.length);
  const cw = (CW - 24 * (n - 1)) / n;
  const y = bodyTop;
  const h = 580;
  const tones = [g.accent, g.accent2, g.accent];
  c.cards.forEach(([ic, head, body], k) => {
    const x = M + k * (cw + 24);
    const toneInk = k % 2 ? (g.accent2Ink ?? g.accent2) : (g.accentInk ?? g.accent);
    nodes.push(card(K, g, x, y, cw, h));
    nodes.push(rect(x, y, cw, 6, tones[k % 3], { decor: true }));
    nodes.push(ellipse(x + 40, y + 48, 80, 80, mixHex(g.panel, tones[k % 3], 0.2), { panel: true }));
    if (ic) nodes.push(icon(ic, x + 60, y + 68, 40, toneInk));
    else nodes.push(text(x + 40, y + 48, 80, 80, String(k + 1).padStart(2, "0"), numeralLabel(K, g, 26)));
    nodes.push(text(x + 40, y + 164, cw - 80, 100, head, t.display(34, { lineHeight: 1.1 })));
    nodes.push(text(x + 40, y + 276, cw - 80, 200, body, t.body(22)));
    nodes.push(rect(x + 40, y + h - 84, cw - 80, 1, g.line, { decor: true }));
    nodes.push(text(x + 40, y + h - 60, 120, 28, String(k + 1).padStart(2, "0"), t.meta()));
  });
  nodes.push(...note(K, g, c.note));
  return { name: "Three cards", bg: g.bg, nodes, drawings: [] };
}

// --- figures -------------------------------------------------------------------

export interface FiguresContent { eyebrow: string; title: string; stats: [string, string, string, string][]; note?: string }

export function figures(K: KitLook, i: number, c: FiguresContent): Slide {
  const g = K.paper;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
  const n = Math.max(1, c.stats.length);
  const cw = (CW - 24 * (n - 1)) / n;
  const hasNote = c.stats.some((s) => s[3]);
  const hasDelta = c.stats.some((s) => s[2]);
  const h = hasNote ? 560 : hasDelta ? 340 : 280;
  const y = bodyTop + (hasNote ? 0 : Math.round((940 - bodyTop - h) / 2) - 40);
  const cwChar = K.charWidth ?? 0.56;
  c.stats.forEach(([nStr, l, d, nt], k) => {
    const x = M + k * (cw + 24);
    const tone = k % 2 ? g.accent2 : g.accent;
    const toneInk = k % 2 ? (g.accent2Ink ?? g.accent2) : (g.accentInk ?? g.accent);
    nodes.push(card(K, g, x, y, cw, h));
    nodes.push(rect(x, y, cw, 6, tone, { decor: true }));
    const size = fitSize(nStr, K.scale.numeral * (nStr.length > 5 ? 0.8 : 1), cw - 72, 0.5, 0.62);
    nodes.push(text(x + 36, y + 56, cw - 72, K.scale.numeral + 16, nStr, t.numeral(size, { color: toneInk })));
    nodes.push(text(x + 36, y + 188, cw - 72, 64, l, t.strong(22, { lineHeight: 1.25 })));
    if (d) nodes.push(button(x + 36, y + 264, Math.min(cw - 72, Math.max(150, Math.round(estWidth(d, 17, cwChar) + 48))), 40, d, { fill: mixHex(g.panel, tone, 0.18), color: toneInk, family: K.body, size: 17, weight: 700 }));
    if (nt) nodes.push(text(x + 36, y + 328, cw - 72, h - 348, nt, t.body(20)));
  });
  nodes.push(...note(K, g, c.note));
  return { name: "Figures", bg: g.bg, nodes, drawings: [] };
}

// --- chart ---------------------------------------------------------------------

export interface ChartContent {
  eyebrow: string; title: string; takeaway?: string;
  chartType: string; categories: string[]; series: { name: string; values: number[]; color?: string }[];
  /** A figure and its line, or a line alone. */
  calls: [string | null, string][];
  note?: string;
}

export function chart(K: KitLook, i: number, c: ChartContent): Slide {
  const g = K.paper;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title, { titleWidth: 1100 });
  const takeaway = c.takeaway ?? "";
  const long = takeaway ? linesFor(takeaway, 24, 1100, 0.5) > 1 : false;
  if (takeaway) nodes.push(text(M, bodyTop - 24, 1100, long ? 70 : 36, takeaway, t.body(24)));
  const cx = M, cy = bodyTop + (takeaway ? (long ? 64 : 40) : 0), cw = c.calls.length ? 1140 : CW, ch = long ? 560 : 580;
  const dark = isDark(g.bg);
  if (dark) nodes.push(rect(cx - 32, cy - 24, cw + 64, ch + 48, "#F3F5F9", { radius: K.radius, panel: true }));
  const palette = [dark ? "#1F2A44" : g.accent2, dark && !isDark(g.accent) ? g.accent2 : g.accent, dark ? "#6B7A99" : mixHex(g.accent, g.accent2, 0.5)];
  nodes.push({
    kind: "chart", x: cx, y: cy, w: cw, h: ch, chartType: c.chartType, fontSize: 18,
    categories: c.categories,
    series: c.series.map((s, k) => ({ name: s.name, values: s.values, color: s.color ?? palette[k % palette.length] })),
  });
  const rx = 1320, rw = 504;
  const calls = c.calls.slice(0, 3);
  const step = calls.length > 2 ? 180 : 220;
  calls.forEach(([n, l], k) => {
    const y = bodyTop + 20 + k * step;
    if (n) {
      nodes.push(text(rx, y, rw, 80, n, t.numeral(fitSize(n, 64, rw, 0.5, 0.62))));
      nodes.push(text(rx, y + 88, rw, 66, l, t.body(22)));
    } else {
      nodes.push(ellipse(rx, y + 10, 14, 14, g.accent, { decor: true }));
      nodes.push(text(rx + 32, y, rw - 32, 140, l, t.strong(24, { weight: 500 })));
    }
    if (k < calls.length - 1) nodes.push(rect(rx, y + step - 28, rw, 1, g.line, { decor: true }));
  });
  nodes.push(...note(K, g, c.note));
  return { name: "Chart", bg: g.bg, nodes, drawings: [] };
}

// --- timeline ------------------------------------------------------------------

export interface TimelineContent { eyebrow: string; title: string; steps: [string, string, string][]; done?: number; note?: string }

export function timeline(K: KitLook, i: number, c: TimelineContent): Slide {
  const g = K.paper;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
  const y = bodyTop + 170;
  const n = Math.max(1, c.steps.length);
  const done = c.done ?? 0;
  nodes.push(rect(M, y + 13, CW, 3, g.line, { decor: true }));
  if (done > 0) nodes.push(rect(M, y + 13, Math.round((CW * (done - 0.5)) / n), 3, g.accent, { decor: true }));
  const cw = CW / n;
  const cwChar = K.charWidth ?? 0.56;
  c.steps.forEach(([q, h, s], k) => {
    const x = M + k * cw;
    const isDone = k < done;
    nodes.push(ellipse(x, y, 30, 30, isDone ? g.accent : g.bg, { decor: true, ...(isDone ? {} : { stroke: g.accent, strokeWidth: 3 }) }));
    if (q) nodes.push(text(x, y - 60, cw - 24, 28, q, t.eyebrow()));
    const two = linesFor(h, 32, cw - 48, cwChar) > 1;
    nodes.push(text(x, y + 64, cw - 48, two ? 80 : 44, h, t.display(n > 4 ? 28 : 32, { lineHeight: 1.1 })));
    if (s) nodes.push(text(x, y + (two ? 152 : 116), cw - 48, 160, s, t.body(21)));
  });
  nodes.push(...note(K, g, c.note));
  return { name: "Timeline", bg: g.bg, nodes, drawings: [] };
}

// --- process -------------------------------------------------------------------

export interface ProcessContent { eyebrow: string; title: string; steps: [string, string][]; note?: string }

export function process(K: KitLook, i: number, c: ProcessContent): Slide {
  const g = K.paper;
  const d = K.deep;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
  const n = Math.max(1, c.steps.length);
  const cw = (CW - (n - 1) * 40) / n;
  const y = bodyTop + 30;
  c.steps.forEach(([h, s], k) => {
    const x = M + k * (cw + 40);
    const fillC = k === 0 ? g.accent : d.bg;
    nodes.push(ellipse(x, y, 88, 88, fillC, { panel: true }));
    nodes.push(text(x, y, 88, 88, String(k + 1), { family: K.display, size: 34, weight: K.dw, color: inkOn(K, fillC), align: "center", vAlign: "middle", lineHeight: 1, fixed: true }));
    if (k < n - 1) nodes.push(rect(x + 104, y + 43, cw - 104 + 24, 2, g.line, { decor: true }));
    nodes.push(text(x, y + 132, cw, 44, h, t.display(n > 4 ? 28 : 32)));
    if (s) nodes.push(text(x, y + 186, cw - 24, 200, s, t.body(21)));
  });
  nodes.push(...note(K, g, c.note));
  return { name: "Process", bg: g.bg, nodes, drawings: [] };
}

// --- table ---------------------------------------------------------------------

export interface TableContent { eyebrow: string; title: string; cols: string[]; rows: string[][]; note?: string }

export function table(K: KitLook, i: number, c: TableContent): Slide {
  const g = K.paper;
  const d = K.deep;
  const t = type(K, g);
  const td = type(K, d);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
  const x0 = M, y0 = bodyTop;
  const cols = c.cols.length ? c.cols : [""];
  const firstW = cols.length > 3 ? 480 : 600;
  const colW = cols.length > 1 ? (CW - firstW) / (cols.length - 1) : CW;
  const rows = c.rows.slice(0, 8);
  const headH = 76, rowH = rows.length > 6 ? 72 : 96;
  nodes.push(rect(x0, y0, CW, headH, deepGround(d), { radius: K.radius ? Math.min(K.radius, 12) : 0, panel: true }));
  if (cols[0]) nodes.push(text(x0 + 32, y0 + 22, firstW - 64, 32, cols[0], td.strong(22)));
  cols.forEach((col, k) => {
    if (!k) return;
    nodes.push(text(x0 + firstW + (k - 1) * colW, y0 + 22, colW, 32, col, td.strong(22, { align: "center" })));
  });
  rows.forEach((r, k) => {
    const y = y0 + headH + k * rowH;
    if (k % 2 === 1) nodes.push(rect(x0, y, CW, rowH, g.panel, { panel: true }));
    nodes.push(text(x0 + 32, y + (rowH - 36) / 2, firstW - 64, 36, r[0] ?? "", t.strong(rowH > 80 ? 24 : 21)));
    r.slice(1, cols.length).forEach((v, col) => {
      const cx = x0 + firstW + col * colW;
      const lv = v.trim().toLowerCase();
      if (lv === "yes" || lv === "✓") nodes.push(icon("circle-check", cx + colW / 2 - 16, y + (rowH - 32) / 2, 32, g.accent));
      else if (lv === "no" || lv === "✗" || lv === "-") nodes.push(icon("circle", cx + colW / 2 - 16, y + (rowH - 32) / 2, 32, g.line));
      else if (linesFor(v, 24, colW - 24, 0.52) > 1) nodes.push(text(cx + 12, y + 14, colW - 24, rowH - 28, v, t.strong(19, { align: "center", color: g.muted, lineHeight: 1.25 })));
      else nodes.push(text(cx, y + (rowH - 36) / 2, colW, 36, v, t.strong(rowH > 80 ? 24 : 21, { align: "center", color: g.muted })));
    });
    nodes.push(rect(x0, y + rowH - 1, CW, 1, g.line, { decor: true }));
  });
  nodes.push(...note(K, g, c.note));
  return { name: "Comparison table", bg: g.bg, nodes, drawings: [] };
}

// --- team ----------------------------------------------------------------------

export interface TeamContent { eyebrow: string; title: string; people: [string, string, string][]; note?: string }

export function team(K: KitLook, i: number, c: TeamContent): Slide {
  const g = K.paper;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
  const n = Math.max(1, c.people.length);
  const cw = (CW - (n - 1) * 24) / n;
  const hasBio = c.people.some((p) => p[2]);
  const blockH = hasBio ? 440 : 330;
  const y = bodyTop + Math.max(20, Math.round((940 - bodyTop - blockH) / 2));
  const drawings: DrawingPrim[] = [];
  c.people.forEach(([name, r, b], k) => {
    const x = M + k * (cw + 24);
    const tone = k % 2 ? g.accent2 : g.accent;
    const px = x + (cw - 220) / 2;
    nodes.push(photo(px, y, 220, 220, mixHex(g.panel, tone, 0.22), { shape: "ellipse" }));
    drawings.push(drawing(peepFor(K, k), px + 30, y + 22, 160, 176, { name: "Portrait" }));
    nodes.push(text(x, y + 252, cw, 40, name, t.display(30, { align: "center" })));
    if (r) nodes.push(text(x, y + 298, cw, 28, r, t.eyebrow({ align: "center", size: 17, color: k % 2 ? (g.accent2Ink ?? g.accent2) : (g.accentInk ?? g.accent) })));
    if (b) nodes.push(text(x + 24, y + 344, cw - 48, 96, b, t.body(21, { align: "center" })));
  });
  nodes.push(...note(K, g, c.note));
  return { name: "Team", bg: g.bg, nodes, drawings };
}

// --- quote ---------------------------------------------------------------------

export interface QuoteContent { text: string; name?: string; role?: string; note?: string }

export function quote(K: KitLook, i: number, c: QuoteContent): Slide {
  const g = K.deep;
  const t = type(K, g);
  const nodes: Prim[] = [...ornamentDeep(K, g), ...footer(K, g, i)];
  nodes.push(text(M, 180, 260, 260, "“", t.numeral(280, { lineHeight: 1, fixed: true, name: "Decor", decor: true })));
  const qw = K.ornament === "dots" || K.ornament === "watermark" ? 1100 : 1400;
  let size = K.scale.quote;
  const cw = K.charWidth ?? 0.56;
  while (size > K.scale.quote * 0.6 && linesFor(c.text, size, qw, cw) > 3) size -= 4;
  const qh = Math.round(size * 1.3 * 3) + 10;
  nodes.push(text(M + 20, 400, qw, qh, c.text, t.display(size, { lineHeight: 1.26, weight: K.display === "Fraunces" ? 400 : K.dw, name: "Quote" })));
  const ay = 400 + qh + 60;
  const drawings: DrawingPrim[] = [];
  if (c.name) {
    nodes.push(photo(M + 20, ay, 84, 84, g.panel2, { shape: "ellipse" }));
    drawings.push(drawing(peepFor(K, 4), M + 32, ay + 8, 60, 68, { name: "Portrait" }));
    nodes.push(text(M + 128, ay + 8, 800, 32, c.name, t.strong(24)));
    if (c.role) nodes.push(text(M + 128, ay + 44, 800, 28, c.role, t.body(20)));
  }
  nodes.push(...note(K, g, c.note, true));
  return { name: "Quote", bg: deepGround(g), nodes, drawings };
}

// --- pricing -------------------------------------------------------------------

export interface PricingContent {
  eyebrow: string; title: string;
  tiers: [string, string, string, string[], boolean][];
  hotLabel?: string; hotCta?: string; ctaPrefix?: string;
  note?: string;
}

export function pricing(K: KitLook, i: number, c: PricingContent): Slide {
  const g = K.paper;
  const d = K.deep;
  const t = type(K, g);
  const td = type(K, d);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
  const n = Math.max(1, c.tiers.length);
  const cw = (CW - 32 * (n - 1)) / n;
  const y = bodyTop;
  const h = 620;
  c.tiers.forEach(([name, price, per, feats, hot], k) => {
    const x = M + k * (cw + 32);
    const gg = hot ? d : g;
    const tt = hot ? td : t;
    if (hot) nodes.push(rect(x, y - 16, cw, h + 32, deepGround(d), { radius: K.radius, panel: true }));
    else nodes.push(card(K, g, x, y, cw, h, { fill: g.bg }));
    const top = hot ? y - 16 : y;
    if (hot && c.hotLabel) nodes.push(button(x + cw - 200, top + 28, 160, 36, c.hotLabel, { fill: gg.accent, color: inkOn(K, gg.accent), family: K.body, size: 15, weight: 700, upper: true, letterSpacing: 1 }));
    nodes.push(text(x + 40, top + 40, cw - 80, 28, name, tt.eyebrow()));
    nodes.push(text(x + 40, top + 84, cw - 80, 90, price, tt.display(fitSize(price, 72, cw - 80, 0.5, K.charWidth ?? 0.56))));
    if (per) nodes.push(text(x + 40, top + 180, cw - 80, 28, per, tt.body(20)));
    nodes.push(rect(x + 40, top + 232, cw - 80, 1, gg.line, { decor: true }));
    feats.slice(0, 5).forEach((f, j) => {
      const fy = top + 264 + j * 56;
      nodes.push(icon("circle-check", x + 40, fy, 26, gg.accent));
      nodes.push(text(x + 84, fy - 2, cw - 124, 32, f, tt.strong(22, { weight: 500 })));
    });
    const btnFill = hot ? gg.accent : d.bg;
    const cta = hot ? (c.hotCta ?? `${c.ctaPrefix ?? "Choose "}${name}`) : `${c.ctaPrefix ?? "Choose "}${name}`;
    nodes.push(button(x + 40, y + h - 100, cw - 80, 60, cta, { fill: btnFill, color: inkOn(K, btnFill), family: K.body, size: 20, weight: 700, radius: K.radius ? Math.min(K.radius, 30) : 0 }));
  });
  nodes.push(...note(K, g, c.note));
  return { name: "Pricing", bg: g.bg, nodes, drawings: [] };
}

// --- closing -------------------------------------------------------------------

export interface ClosingContent { title: string; subtitle?: string; rows?: [string, string][]; cta?: string; art?: string; note?: string }

export function closing(K: KitLook, i: number, c: ClosingContent): Slide {
  const g = K.deep;
  const t = type(K, g);
  const nodes: Prim[] = [...ornamentDeep(K, g, { mark: true })];
  const drawings: DrawingPrim[] = [];
  if (K.ornament === "blocks") {
    nodes.push(rect(1272, 0, 648, H, g.accent, { decor: true }));
    nodes.push(ellipse(1316, 240, 560, 560, g.ink, { opacity: 0.18, decor: true }));
    nodes.push(...confetti(confettiColors(g), 12, 8, { x: 1290, y: 80, w: 610, h: 920 }));
    if (c.art) drawings.push(drawing(c.art, 1336, 280, 520, 480));
  } else {
    nodes.push(...halo(1520, 520, 640, g.accent));
    if (c.art) drawings.push(drawing(c.art, 1250, 250, 540, 540));
  }
  nodes.push(...mark(K, g));
  nodes.push(text(M, 236, 1000, Math.round(K.accentSize * 1.3), K.farewell, t.kicker()));
  const closeLines = c.title.split("\n").length;
  const closeSize = fitSize(c.title, K.scale.cover, 1100, 0.6, K.charWidth ?? 0.56);
  const closeH = Math.round(closeSize * 1.1 * closeLines) + 10;
  nodes.push(text(M, 300, 1100, closeH, c.title, t.display(closeSize, { lineHeight: 1.04, name: "Title" })));
  if (c.subtitle) nodes.push(text(M, 300 + closeH + 34, 940, 200, c.subtitle, t.body(28)));
  (c.rows ?? []).slice(0, 4).forEach(([ic, v], k) => {
    const y = 700 + k * 62;
    if (ic) nodes.push(icon(ic, M, y + 2, 28, g.accent));
    nodes.push(text(M + 48, y, 800, 56, v, t.strong(24, { weight: 500, lineHeight: 1.15 })));
  });
  if (c.cta) nodes.push(button(M, 910, Math.max(340, Math.round(estWidth(c.cta, 22, 0.55) + 80)), 64, c.cta, { fill: g.accent, color: inkOn(K, g.accent), family: K.body, size: 22, weight: 700, radius: K.radius ? Math.min(K.radius, 32) : 0 }));
  if (K.total > 1) nodes.push(text(W - M - 240, 940, 240, 28, pageNo(i, K.total), t.meta({ align: "right", name: "Page number", fixed: true })));
  nodes.push(...note(K, g, c.note, true));
  return { name: "Closing", bg: deepGround(g), nodes, drawings };
}

// --- big figure ------------------------------------------------------------------

export interface BigStatContent { eyebrow?: string; value: string; caption?: string; delta?: string; icon?: string; note?: string }

/** One figure, as large as the page allows, on the deep ground: the slide
 *  a presenter pauses on. */
export function bigStat(K: KitLook, i: number, c: BigStatContent): Slide {
  const g = K.deep;
  const t = type(K, g);
  const nodes: Prim[] = [...ornamentDeep(K, g), ...footer(K, g, i)];
  nodes.push(...halo(W / 2, 470, 760, g.accent));
  if (c.eyebrow) nodes.push(text(M, 236, CW, 28, c.eyebrow, t.eyebrow({ align: "center" })));
  const size = fitSize(c.value, c.value.length > 6 ? 220 : 300, CW, 0.4, 0.62);
  nodes.push(text(M, 300, CW, size + 20, c.value, t.numeral(size, { align: "center" })));
  if (c.caption) nodes.push(text(W / 2 - 600, 300 + size + 50, 1200, 90, c.caption, t.body(30, { align: "center", color: g.ink })));
  if (c.delta) nodes.push(button(W / 2 - 130, 300 + size + 170, 260, 48, c.delta, { fill: mixHex(g.bg, g.accent, 0.22), color: g.accentInk ?? g.accent, family: K.body, size: 19, weight: 700 }));
  nodes.push(...note(K, g, c.note, true));
  return { name: "Big figure", bg: deepGround(g), nodes, drawings: [] };
}

// --- columns (roadmap) ---------------------------------------------------------

export interface ColumnsContent { eyebrow: string; title: string; intro?: string; cols: [string, string, [string, string][]][]; note?: string }

/** Three horizon columns, each a stack of items with a title and a line. */
export function columns(K: KitLook, i: number, c: ColumnsContent): Slide {
  const g = K.paper;
  const d = K.deep;
  const t = type(K, g);
  const td = type(K, d);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title, { titleWidth: 1000 });
  // The intro sits beside the title, where the corner ornament would cover it.
  if (c.intro && K.ornament !== "corner") nodes.push(text(M + 1040, 130, CW - 1040, 80, c.intro, t.body(21)));
  const n = Math.max(1, c.cols.length);
  const cw = (CW - (n - 1) * 24) / n;
  const y = bodyTop;
  const h = 640;
  c.cols.forEach(([head, sub, items], k) => {
    const x = M + k * (cw + 24);
    const hot = k === 0;
    if (hot) nodes.push(deepCard(K, x, y, cw, h));
    else nodes.push(card(K, g, x, y, cw, h));
    const tt = hot ? td : t;
    const gg = hot ? d : g;
    nodes.push(text(x + 36, y + 36, cw - 72, 44, head, tt.display(34)));
    if (sub) nodes.push(text(x + 36, y + 84, cw - 72, 26, sub, tt.eyebrow({ size: 15, letterSpacing: 3 })));
    nodes.push(rect(x + 36, y + 128, cw - 72, 1, gg.line, { decor: true }));
    const rows = items.slice(0, 4);
    const step = rows.length > 3 ? 118 : 156;
    rows.forEach(([it, line], j) => {
      const iy = y + 156 + j * step;
      nodes.push(ellipse(x + 36, iy + 8, 12, 12, gg.accent, { decor: true }));
      nodes.push(text(x + 64, iy, cw - 100, line ? 34 : step - 30, it, tt.strong(line ? 24 : 22, line ? {} : { lineHeight: 1.3 })));
      if (line) nodes.push(text(x + 64, iy + 40, cw - 100, step - 60, line, tt.body(19)));
    });
  });
  nodes.push(...note(K, g, c.note));
  return { name: "Roadmap", bg: g.bg, nodes, drawings: [] };
}

// --- schedule ------------------------------------------------------------------

export interface ScheduleContent {
  eyebrow: string; title: string;
  slots: [string, string, string][];
  after: { eyebrow: string; head: string; note?: string };
  art?: string;
}

/** A day's schedule: a timeline of slots down the left, an after-hours
 *  card on the deep ground at right with a drawing in a halo. */
export function schedule(K: KitLook, i: number, c: ScheduleContent): Slide {
  const g = K.paper;
  const d = K.deep;
  const t = type(K, g);
  const td = type(K, d);
  const { nodes } = chrome(K, g, i, c.eyebrow, c.title, { titleWidth: 940 });
  const slots = c.slots.slice(0, 6);
  const step = slots.length > 5 ? 104 : 120;
  nodes.push(rect(M + 10, 332, 4, Math.min(520, (slots.length - 1) * step + 40), g.line, { radius: 2, decor: true }));
  slots.forEach(([tm, h, sub], k) => {
    const y = 322 + k * step;
    nodes.push(ellipse(M + 2, y, 20, 20, k % 3 === 2 ? g.accent2 : g.accent, { decor: true }));
    nodes.push(text(M + 56, y - 2, 150, 28, tm, { family: K.mono ?? K.body, size: 22, weight: 600, color: g.accentInk ?? g.accent, lineHeight: 1.2, cw: 0.6 }));
    nodes.push(text(M + 220, y - 6, 620, 32, h, t.display(27)));
    if (sub) nodes.push(text(M + 220, y + 32, 620, 56, sub, t.body(20)));
  });
  const cx = 1120, cy = 268, cw = 660, ch = 650;
  nodes.push(deepCard(K, cx, cy, cw, ch));
  nodes.push(...sparkles(d.accent, 20 + i, 6, { x: cx + 20, y: cy + 20, w: cw - 40, h: 300 }));
  nodes.push(text(cx + 60, cy + 56, 540, 24, c.after.eyebrow, td.eyebrow({ size: 19, letterSpacing: 3 })));
  nodes.push(text(cx + 60, cy + 92, 540, 84, c.after.head, td.display(34)));
  nodes.push(...halo(cx + cw / 2, cy + 440, 360, d.accent));
  const drawings: DrawingPrim[] = c.art ? [drawing(c.art, cx + 150, cy + 280, 360, 300)] : [];
  if (c.after.note) nodes.push(text(cx + 60, cy + 592, 540, 44, c.after.note, td.kicker({ align: "center", size: Math.round(K.accentSize * 0.8), name: "Note" })));
  return { name: "Schedule", bg: g.bg, nodes, drawings };
}

// --- checklist -----------------------------------------------------------------

export interface ChecklistContent { eyebrow: string; title: string; items: [string, boolean][]; legend?: [string, string]; art?: string; picture?: PictureIntent | null; note?: string }

/** A checklist in two columns with a legend, and a picture slot at right. */
export function checklist(K: KitLook, i: number, c: ChecklistContent): Slide {
  const g = K.paper;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title, { titleWidth: 900 });
  const items = c.items.slice(0, 8);
  const rowH = items.length > 6 ? 80 : 92;
  items.forEach(([label, must], k) => {
    const col = k % 2, row = Math.floor(k / 2);
    const x = M + col * 560, y = bodyTop + 20 + row * rowH;
    nodes.push(icon(must ? "circle-check" : "circle", x, y + 2, 34, must ? (g.accentInk ?? g.accent) : g.line));
    nodes.push(text(x + 54, y, 480, rowH - 14, label, t.strong(22, { lineHeight: 1.25 })));
  });
  if (c.legend) {
    const ly = bodyTop + 20 + Math.ceil(items.length / 2) * rowH + 20;
    nodes.push(rect(M, ly, 1080, 1, g.line, { decor: true }));
    nodes.push(icon("circle-check", M, ly + 26, 22, g.accent));
    nodes.push(text(M + 34, ly + 22, 300, 28, c.legend[0], t.body(18)));
    nodes.push(icon("circle", M + 260, ly + 26, 22, g.line));
    nodes.push(text(M + 294, ly + 22, 300, 28, c.legend[1], t.body(18)));
  }
  const slot = pictureSlot(K, g, { x: 1300, y: 268, w: 480, h: 600 }, c.art, c.picture, 400, { x: 1360, y: 320, w: 360, h: 420 }, K.radius);
  nodes.push(...slot.nodes);
  nodes.push(...note(K, g, c.note));
  return { name: "Checklist", bg: g.bg, nodes, drawings: slot.drawings };
}

// --- facts ---------------------------------------------------------------------

export interface FactsContent { eyebrow: string; title: string; intro?: string; items: [string, string, string][]; art?: string; picture?: PictureIntent | null; note?: string }

/** Facts with icons down the left, a large picture slot at right. */
export function facts(K: KitLook, i: number, c: FactsContent): Slide {
  const g = K.paper;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title, { titleWidth: 900 });
  const items = c.items.slice(0, 5);
  const top = c.intro ? bodyTop + 100 : bodyTop + 10;
  if (c.intro) nodes.push(text(M, bodyTop - 20, 820, 90, c.intro, t.body(26)));
  const step = items.length > 4 ? 104 : 118;
  items.forEach(([ic, h, sub], k) => {
    const y = top + k * step;
    nodes.push(ellipse(M, y, 56, 56, mixHex(g.panel, g.accent, 0.18), { panel: true }));
    if (ic) nodes.push(icon(ic, M + 14, y + 14, 28, g.accentInk ?? g.accent));
    else nodes.push(text(M, y, 56, 56, String(k + 1), numeralLabel(K, g, 22)));
    if (sub || h.length <= 44) nodes.push(text(M + 80, y - 2, 740, sub ? 34 : step - 20, h, t.display(sub ? 26 : 24, sub ? {} : { lineHeight: 1.15 })));
    else nodes.push(text(M + 80, y - 2, 740, step - 14, h, t.strong(21, { weight: 500, lineHeight: 1.3 })));
    if (sub) nodes.push(text(M + 80, y + 34, 740, 60, sub, t.body(20)));
  });
  const slot = pictureSlot(K, g, { x: 1080, y: 268, w: 700, h: 610 }, c.art, c.picture, 500, { x: 1190, y: 320, w: 480, h: 420 }, K.radius);
  nodes.push(...slot.nodes);
  nodes.push(...note(K, g, c.note));
  return { name: "Facts", bg: g.bg, nodes, drawings: slot.drawings };
}

// --- split ---------------------------------------------------------------------

export interface SplitContent {
  left: { eyebrow: string; head: string; lines: string[] };
  right: { eyebrow: string; head: string; body?: string; checks: [string, string][] };
  art?: string;
}

/** A split slide: the problem on a deep panel at left, the answer on paper
 *  at right with checks, a drawing in a halo. */
export function split(K: KitLook, i: number, c: SplitContent): Slide {
  const g = K.paper;
  const d = K.deep;
  const t = type(K, g);
  const td = type(K, d);
  const cw = K.charWidth ?? 0.56;
  const leftHeadLines = Math.max(1, Math.min(3, linesFor(c.left.head, 58, 720, cw)));
  const leftLinesTop = Math.max(470, 184 + Math.round(58 * 1.08 * leftHeadLines) + 40);
  const rightHeadLines = Math.max(1, Math.min(2, linesFor(c.right.head, 58, 820, cw)));
  const rightBodyTop = 184 + Math.round(58 * 1.08 * rightHeadLines) + 30;
  const checksTop = c.right.body ? Math.max(520, rightBodyTop + 150) : rightBodyTop + 20;
  const checkStep = c.right.checks.some(([, l]) => linesFor(l, 22, 700, 0.52) > 1) ? 92 : 76;
  const nodes: Prim[] = [
    rect(0, 0, 900, H, deepGround(d), { panel: true }),
    ...sparkles(d.accent, 21 + i, 6, { x: 40, y: 40, w: 820, h: 400 }),
    text(M, 130, 700, 28, c.left.eyebrow, td.eyebrow()),
    text(M, 184, 720, Math.round(58 * 1.08 * 3) + 10, c.left.head, td.display(58, { lineHeight: 1.08, name: "Title" })),
    ...c.left.lines.slice(0, 4).flatMap((line, k) => [rect(M, leftLinesTop + 10 + k * 100, 12, 12, d.accent, { radius: 3, decor: true }), text(M + 32, leftLinesTop + k * 100, 660, 80, line, td.body(24))]),
    rect(900, 0, 6, H, g.accent, { decor: true }),
    text(980, 130, 800, 28, c.right.eyebrow, t.eyebrow()),
    text(980, 184, 820, Math.round(58 * 1.08 * 2) + 10, c.right.head, t.display(58, { lineHeight: 1.08 })),
    ...(c.right.body ? [text(980, rightBodyTop, 800, 130, c.right.body, t.body(24))] : []),
    ...c.right.checks.slice(0, 4).flatMap(([ic, line], k) => [
      ellipse(980, checksTop + k * checkStep, 44, 44, mixHex(g.panel, g.accent, 0.2), { panel: true }),
      ...(ic ? [icon(ic, 990, checksTop + 10 + k * checkStep, 24, g.accent)] : [icon("circle-check", 990, checksTop + 10 + k * checkStep, 24, g.accent)]),
      text(1044, checksTop + 4 + k * checkStep, 700, checkStep - 16, line, t.strong(22, { lineHeight: 1.25 })),
    ]),
    ...halo(1560, 800, 300, g.accent),
    ...footer(K, g, i).slice(1),
  ];
  const drawings: DrawingPrim[] = c.art ? [drawing(c.art, 1440, 690, 240, 220)] : [];
  return { name: "Split", bg: g.bg, nodes, drawings };
}

// --- four cards ----------------------------------------------------------------

export interface FourCardsContent { eyebrow: string; title: string; cards: [string, string, string][]; note?: string }

/** Four cards in a two by two grid, each with an icon, a heading and a line. */
export function fourCards(K: KitLook, i: number, c: FourCardsContent): Slide {
  const g = K.paper;
  const t = type(K, g);
  const { nodes, bodyTop } = chrome(K, g, i, c.eyebrow, c.title);
  const cards = c.cards.slice(0, 4);
  const rows = Math.ceil(cards.length / 2);
  const cardH = rows > 1 ? 264 : 300;
  cards.forEach(([ic, h, sub], k) => {
    const x = M + (k % 2) * 876, y = bodyTop + Math.floor(k / 2) * (cardH + 36);
    const tone = k % 2 ? g.accent2 : g.accent;
    nodes.push(card(K, g, x, y, 852, cardH));
    nodes.push(ellipse(x + 40, y + 40, 72, 72, mixHex(g.panel, tone, 0.2), { panel: true }));
    if (ic) nodes.push(icon(ic, x + 58, y + 58, 36, k % 2 ? (g.accent2Ink ?? g.accent2) : (g.accentInk ?? g.accent)));
    else nodes.push(text(x + 40, y + 40, 72, 72, String(k + 1).padStart(2, "0"), numeralLabel(K, g, 24)));
    if (sub) {
      nodes.push(text(x + 140, y + 44, 672, 40, h, t.display(30)));
      nodes.push(text(x + 140, y + 96, 672, cardH - 120, sub, t.body(22)));
    } else if (h.length <= 48) {
      nodes.push(text(x + 140, y + 44, 672, cardH - 80, h, t.display(28, { lineHeight: 1.15 })));
    } else {
      nodes.push(text(x + 140, y + 44, 672, cardH - 80, h, t.strong(24, { weight: 500, lineHeight: 1.3 })));
    }
  });
  nodes.push(...note(K, g, c.note));
  return { name: "Four cards", bg: g.bg, nodes, drawings: [] };
}
