// Line-breaking layout. Framework-agnostic with a pluggable `measure`
// so the same code runs in the browser (canvas measureText), on the server, and
// in tests (a metric approximation). True shaping/kerning/bidi/complex-script
// layout via HarfBuzz is deferred; this produces correct line structure.

import type { CharStyle, Paragraph, TextNode } from "@hc/schema";
import { orderLinePieces, resolveBaseDirection } from "./bidi";
import { resolveParagraphStyle } from "./cascade";
import { wrapChunks } from "./segment";

export type MeasureFn = (text: string, style: CharStyle) => number;

/** Default advance approximation (~0.55em per char + tracking). */
export const approximateMeasure: MeasureFn = (text, style) =>
  text.length * (style.fontSize * 0.55 + (style.letterSpacing ?? 0));

/** A run of one or more tab characters (used by both layout and rendering so
 *  tab advances agree). */
export const isTabRun = (text: string): boolean => text.length > 0 && /^\t+$/.test(text);

/** Next tab stop at or past `pos`, honoring explicit `tabStops` then falling
 *  back to a default grid of `em * 4`. Shared by layout (wrap width) and the
 *  renderer (glyph advance) so a tab lands in the same place in both. */
export function nextTabStop(pos: number, tabStops: number[] | undefined, em: number): number {
  if (tabStops && tabStops.length) {
    for (const t of [...tabStops].sort((a, b) => a - b)) if (t > pos + 0.01) return t;
  }
  const grid = Math.max(1, em * 4);
  return Math.floor(pos / grid + 1) * grid;
}

/** Total width of a run of tabs starting at `pos`. */
export function tabRunWidth(text: string, pos: number, tabStops: number[] | undefined, em: number): number {
  let p = pos;
  for (let k = 0; k < text.length; k++) p = nextTabStop(p, tabStops, em);
  return p - pos;
}

export interface LineSegment {
  text: string;
  style: CharStyle;
}
export interface LineBox {
  paragraph: number;
  y: number;
  height: number;
  width: number;
  align: "left" | "center" | "right" | "justify";
  segments: LineSegment[];
  /** Left offset of the text within the content box (indent + list gutter). */
  x: number;
  /** List marker drawn in the gutter on the paragraph's first line, if any. */
  marker?: { text: string; style: CharStyle; x: number };
  /** Multi-column flow: the left origin of this line's column relative to the
   *  content box, and the column's width. Absent for single-column layout. */
  colLeft?: number;
  colWidth?: number;
  /** The paragraph's resolved base direction (F38 FR-10). `segments` are in
   *  DISPLAY order, so a renderer draws them left to right regardless; this is
   *  here so alignment and caret placement can respect the base direction. */
  direction: "ltr" | "rtl";
}
export interface LayoutResult {
  lines: LineBox[];
  width: number;
  height: number;
}

function lineHeightPx(style: CharStyle): number {
  const lh = style.lineHeight;
  if (lh === undefined) return style.fontSize * 1.2;
  if (typeof lh === "number") return style.fontSize * lh;
  if (lh.mode === "absolute") return lh.value;
  if (lh.mode === "multiple") return style.fontSize * lh.value;
  return style.fontSize * 1.2; // auto
}

export interface LayoutOptions {
  measure?: MeasureFn;
}

/** Ordered-list ordinal -> label (1. / 2. / ...). */
function listMarkerText(
  list: NonNullable<ReturnType<typeof resolveParagraphStyle>["list"]>,
  ordinal: number,
): string {
  if (list.marker) return list.marker;
  if (list.type === "number") return `${ordinal}.`;
  if (list.type === "checklist") return "☐"; // ballot box
  return "•"; // bullet
}

export function layoutText(node: TextNode, opts: LayoutOptions = {}): LayoutResult {
  const measure = opts.measure ?? approximateMeasure;
  const pad = node.box.padding ?? { t: 0, r: 0, b: 0, l: 0 };
  const wrap = node.box.mode !== "autoWidth";
  const fullWidth = Math.max(0, node.box.width - pad.l - pad.r);
  // Multi-column flow: wrap to one column's width, then reflow lines into columns
  // (a post-process below). Single column keeps the full content width.
  const colSpec = (node.box as { columns?: { count: number; gutter: number } }).columns;
  const cols = wrap && colSpec && colSpec.count > 1 ? Math.floor(colSpec.count) : 1;
  const gutter = cols > 1 ? Math.max(0, colSpec!.gutter) : 0;
  const colW = cols > 1 ? Math.max(0, (fullWidth - gutter * (cols - 1)) / cols) : fullWidth;
  const boxWidth = colW;

  const lines: LineBox[] = [];
  let y = pad.t;
  let maxLineWidth = 0;
  // Per-level ordinals for numbered lists; reset by shallower/non-list paras.
  const counters: number[] = [];

  node.content.forEach((para: Paragraph, pi) => {
    const ps = resolveParagraphStyle(para);
    // Base direction per UAX #9: an explicit setting wins, "auto" follows the
    // first strong character in the paragraph.
    const paraText = para.runs.map((r) => r.text).join("");
    const dir = resolveBaseDirection(paraText, ps.direction ?? "auto");
    // A right-to-left paragraph reads from the right, so the default alignment
    // flips with it. An author who explicitly chose an alignment keeps it; only
    // the untouched default (the style's "left") follows the text.
    const authoredAlign = para.style?.align ?? para.overrides?.align;
    const align = dir === "rtl" && !authoredAlign && ps.align === "left" ? "right" : ps.align;
    const firstStyle = para.runs[0]?.style;
    const em = firstStyle?.fontSize ?? 16;
    const level = ps.list?.level ?? 0;

    // List bookkeeping: gutter for the marker, hanging indent for wrapped text.
    let marker: LineBox["marker"];
    const gutter = ps.list ? em * 1.6 : 0;
    if (ps.list) {
      if (ps.list.type === "number") {
        counters[level] = (counters[level] ?? 0) + 1;
        counters.length = level + 1; // deeper levels restart
      }
      const ord = counters[level] ?? 1;
      if (firstStyle) marker = { text: listMarkerText(ps.list, ord), style: firstStyle, x: (ps.indentStart ?? 0) + level * em * 1.2 };
    } else {
      counters.length = 0; // a non-list paragraph resets numbering
    }

    const baseIndent = (ps.indentStart ?? 0) + level * em * 1.2 + gutter;
    const contentWidth = Math.max(0, boxWidth - baseIndent - (ps.indentEnd ?? 0));
    // space-before collapses against the top of the box (first paragraph only).
    if (pi > 0) y += ps.spaceBefore ?? 0;

    let segs: LineSegment[] = [];
    let lineWidth = 0;
    let lineHeight = 0;
    let firstLine = true;

    const flush = () => {
      const h = lineHeight || (firstStyle ? lineHeightPx(firstStyle) : 16 * 1.2);
      const x = baseIndent + (firstLine ? ps.firstLineIndent ?? 0 : 0);
      lines.push({
        paragraph: pi,
        y,
        height: h,
        width: lineWidth,
        align,
        // Display order, so every renderer draws left to right and none of
        // them needs to know about bidi.
        segments: orderLinePieces(segs, dir).map((p) => ({ text: p.text, style: p.item.style })),
        x,
        marker: firstLine ? marker : undefined,
        direction: dir,
      });
      maxLineWidth = Math.max(maxLineWidth, lineWidth + x);
      y += h;
      segs = [];
      lineWidth = 0;
      lineHeight = 0;
      firstLine = false;
    };

    for (const run of para.runs) {
      const lh = lineHeightPx(run.style);
      for (const chunk of wrapChunks(run.text)) {
        // Tabs advance to the next tab stop from the current line position
        // (never wrap); everything else uses the measured advance.
        const w = isTabRun(chunk.text) ? tabRunWidth(chunk.text, lineWidth, ps.tabStops, em) : measure(chunk.text, run.style);
        if (wrap && lineWidth > 0 && lineWidth + w > contentWidth && !chunk.whitespace) {
          flush();
        }
        segs.push({ text: chunk.text, style: run.style });
        lineWidth += w;
        lineHeight = Math.max(lineHeight, lh);
      }
    }
    // Always emit at least one (possibly empty) line per paragraph.
    flush();
    y += ps.spaceAfter ?? 0;
  });

  // Multi-column reflow: lines were stacked at column width; distribute them
  // across `cols` columns by height, resetting each column to the top and
  // tagging the line with its column's left origin + width.
  if (cols > 1) {
    const contentH = Math.max(1, node.box.height - pad.t - pad.b);
    let col = 0;
    let shift = 0; // subtracted from y so each new column restarts at pad.t
    for (const ln of lines) {
      const localY = ln.y - shift;
      if (col < cols - 1 && localY > pad.t && localY + ln.height > pad.t + contentH) {
        col++;
        shift = ln.y - pad.t;
      }
      ln.y -= shift;
      ln.colLeft = col * (colW + gutter);
      ln.colWidth = colW;
    }
  }

  return {
    lines,
    width: node.box.mode === "autoWidth" ? maxLineWidth + pad.l + pad.r : node.box.width,
    height: node.box.mode === "fixed" ? node.box.height : y + pad.b,
  };
}

/** Content size of a text node under the given measure. */
export function measureText(node: TextNode, opts: LayoutOptions = {}): { width: number; height: number } {
  const r = layoutText(node, opts);
  return { width: r.width, height: r.height };
}
