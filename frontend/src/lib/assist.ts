// Algorithmic AI-assist analyzers (F22 FR-8/FR-9/FR-11/FR-14). These are
// DETERMINISTIC analyses over a design page plus the existing editor ops; no AI
// model is called. The core scoring/grouping/proposal logic is split into pure
// functions over plain data (rects, color hexes, font/style descriptors) so it
// can be unit-tested without the DOM or a live store, while thin extractors pull
// that data out of a DesignFile via @hc/editor (worldAABB) and @hc/color.
//
// Where the data comes from:
// - contrast critique uses @hc/color contrastRatio / fixToAA against the page
//   background (or the nearest underlying solid fill);
// - geometry (off-canvas / overflow / alignment / spacing) uses worldAABB from
//   @hc/editor against the page bounds;
// - harmonization counts fonts / colors / radii / shadows and proposes the
//   majority value as a unifying target;
// - auto-layout maps detected geometry problems onto the existing
//   align/distribute/tidy selection commands;
// - auto-animate assigns a coherent staggered entrance set in reading order.

import type { Color, DesignFile, Fill, Node, Page } from "@hc/schema";
import { contrastRatio, fixToAA, fromHex, toHex } from "@hc/color";
import { worldAABB } from "@hc/editor";
import { tr } from "@/lib/i18n";

// A simple page-space rectangle (mirrors @hc/engine Rect).
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type CritiqueCategory =
  | "contrast"
  | "overflow"
  | "offcanvas"
  | "alignment"
  | "spacing"
  | "readability";
export type CritiqueSeverity = "high" | "med" | "low";

/** A categorized design issue. `fix` (when present) is an applyable action the
 *  UI turns into one undoable store call. */
export interface CritiqueIssue {
  id: string;
  category: CritiqueCategory;
  severity: CritiqueSeverity;
  nodeId?: string;
  message: string;
  fix?: CritiqueFix;
}

/** An auto-fixable critique action. Each maps to one undoable store mutation. */
export type CritiqueFix =
  | { kind: "set_text_color"; nodeId: string; hex: string } // contrast
  | { kind: "move_into_bounds"; nodeId: string; dx: number; dy: number } // offcanvas/overflow
  | { kind: "align_nudge"; nodeId: string; dx: number; dy: number }; // alignment

export const CATEGORY_LABEL: Record<CritiqueCategory, string> = {
  contrast: "Contrast",
  overflow: "Overflow",
  offcanvas: "Off canvas",
  alignment: "Alignment",
  spacing: "Spacing",
  readability: "Readability",
};

// Thresholds (deterministic, documented so the UI copy matches the logic).
const WCAG_AA = 4.5; // FR-14: flag text contrast below AA-normal.
const MIN_READABLE_PX = 12; // text smaller than this (in page units) is hard to read.
const ALIGN_TOLERANCE = 1.5; // edges within this many units are "meant" to align.
const ALIGN_SNAP_MAX = 12; // only auto-nudge edges already within this gap.

// ---------------------------------------------------------------------------
// Geometry extraction
// ---------------------------------------------------------------------------

/** One top-level element with its page-space bounds and a few flags the
 *  analyzers need. Pure analyzers consume arrays of these, never the document. */
export interface ElementBox {
  id: string;
  bounds: Rect;
  isText: boolean;
  /** Smallest run font size in page units (text only), for readability. */
  minFontPx?: number;
  /** Effective text color over its background (text only), for contrast. */
  textColorHex?: string;
}

const WHITE: Color = { srgb: { r: 1, g: 1, b: 1, a: 1 } };

/** Resolve a page's background to an opaque color for contrast math. A gradient
 *  uses its first stop; an absent / non-solid background falls back to white. */
export function pageBackgroundColor(page: Page): Color {
  const bg = (page as unknown as { background?: Fill }).background;
  if (!bg) return WHITE;
  if (bg.type === "solid") return bg.color;
  if (bg.type === "gradient" && bg.stops.length) return bg.stops[0].color;
  return WHITE;
}

/** First solid fill color of a node, if any (used as the underlying background a
 *  text element sits on when it overlaps a filled shape). */
function solidFillColor(node: Node): Color | null {
  const fills = (node as unknown as { fills?: Fill[] }).fills;
  if (!fills) return null;
  for (const f of fills) if (f.type === "solid") return f.color;
  return null;
}

/** True when rect `a` is substantially inside rect `b` (centre + most area). */
function centreInside(a: Rect, b: Rect): boolean {
  const cx = a.x + a.width / 2;
  const cy = a.y + a.height / 2;
  return cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height;
}

/** The nearest background color underneath a text element: the topmost solid
 *  filled shape it sits on (searched back-to-front), else the page background.
 *  `order` is the page child order (back to front). */
function backgroundUnder(
  textBounds: Rect,
  textIndex: number,
  page: Page,
  doc: DesignFile,
): Color {
  // Look at shapes drawn BEHIND the text (lower index) whose box contains it.
  let found: Color | null = null;
  for (let i = 0; i < textIndex; i++) {
    const n = page.children[i];
    if (n.hidden) continue;
    const c = solidFillColor(n);
    if (!c) continue;
    const b = worldAABB(doc, n.id);
    if (b && centreInside(textBounds, b)) found = c; // later (higher index) wins
  }
  return found ?? pageBackgroundColor(page);
}

/** Smallest run font size across a text node's content (page units). */
function minFontSize(node: Node): number | undefined {
  if (node.type !== "text") return undefined;
  const content = (node as unknown as { content: { runs: { style: { fontSize: number } }[] }[] }).content;
  let min = Infinity;
  for (const p of content) for (const r of p.runs) min = Math.min(min, r.style.fontSize);
  return Number.isFinite(min) ? min : undefined;
}

/** First run fill color of a text node as hex (effective color). */
function textColorOf(node: Node): Color | null {
  if (node.type !== "text") return null;
  const content = (node as unknown as { content: { runs: { style: { fill?: Fill } }[] }[] }).content;
  for (const p of content) for (const r of p.runs) {
    const f = r.style.fill;
    if (f && f.type === "solid") return f.color;
  }
  return null;
}

/** Build the top-level element boxes for a page (skips hidden/locked nodes and
 *  any node without resolvable bounds). Text elements carry contrast + size. */
export function elementBoxesForPage(doc: DesignFile, pageIndex: number): {
  page: Page;
  boxes: ElementBox[];
  contrast: { id: string; ratio: number; passingHex: string }[];
} {
  const page = doc.pages[pageIndex];
  const boxes: ElementBox[] = [];
  const contrast: { id: string; ratio: number; passingHex: string }[] = [];
  if (!page) return { page: page ?? ({} as Page), boxes, contrast };

  page.children.forEach((node, index) => {
    if (node.hidden || node.locked) return;
    const bounds = worldAABB(doc, node.id);
    if (!bounds) return;
    const isText = node.type === "text";
    const box: ElementBox = { id: node.id, bounds, isText };
    if (isText) {
      box.minFontPx = minFontSize(node);
      const fg = textColorOf(node);
      if (fg) {
        box.textColorHex = toHex(fg);
        const bg = backgroundUnder(bounds, index, page, doc);
        const ratio = contrastRatio(fg, bg);
        const passing = fixToAA(fg, bg, WCAG_AA);
        contrast.push({ id: node.id, ratio, passingHex: toHex(passing) });
      }
    }
    boxes.push(box);
  });
  return { page, boxes, contrast };
}

// ---------------------------------------------------------------------------
// Pure critique analyzers (operate on plain data; unit-tested directly)
// ---------------------------------------------------------------------------

/** Off-canvas / overflow issues for a set of boxes against the page rect. A box
 *  fully outside is "offcanvas"; one partly past an edge is "overflow". The fix
 *  is the minimal translation that brings the box back inside the page. */
export function detectOffCanvas(boxes: ElementBox[], page: { width: number; height: number }): CritiqueIssue[] {
  const out: CritiqueIssue[] = [];
  for (const b of boxes) {
    const r = b.bounds;
    const fullyOut =
      r.x + r.width <= 0 || r.y + r.height <= 0 || r.x >= page.width || r.y >= page.height;
    const overEdge =
      r.x < -0.5 || r.y < -0.5 || r.x + r.width > page.width + 0.5 || r.y + r.height > page.height + 0.5;
    if (!fullyOut && !overEdge) continue;
    // Minimal move back inside (clamp each axis; if larger than page, align top-left).
    let dx = 0;
    let dy = 0;
    if (r.width <= page.width) {
      if (r.x < 0) dx = -r.x;
      else if (r.x + r.width > page.width) dx = page.width - (r.x + r.width);
    } else dx = -r.x;
    if (r.height <= page.height) {
      if (r.y < 0) dy = -r.y;
      else if (r.y + r.height > page.height) dy = page.height - (r.y + r.height);
    } else dy = -r.y;
    const category: CritiqueCategory = fullyOut ? "offcanvas" : "overflow";
    out.push({
      id: `${category}:${b.id}`,
      category,
      severity: fullyOut ? "high" : "med",
      nodeId: b.id,
      message: fullyOut
        ? tr("app.element_is_off_the_canvas_and_wont_appear_in")
        : tr("app.element_extends_past_the_page_edge_and_will"),
      fix: { kind: "move_into_bounds", nodeId: b.id, dx, dy },
    });
  }
  return out;
}

/** Low-contrast text issues from pre-computed ratios. Flags ratio < AA (4.5). */
export function detectContrast(
  contrast: { id: string; ratio: number; passingHex: string }[],
): CritiqueIssue[] {
  const out: CritiqueIssue[] = [];
  for (const c of contrast) {
    if (c.ratio >= WCAG_AA) continue;
    out.push({
      id: `contrast:${c.id}`,
      category: "contrast",
      severity: c.ratio < 3 ? "high" : "med",
      nodeId: c.id,
      message: `Text contrast is ${c.ratio.toFixed(1)}:1, below the 4.5:1 readability standard.`,
      fix: { kind: "set_text_color", nodeId: c.id, hex: c.passingHex },
    });
  }
  return out;
}

/** Very small text (readability). No auto-fix (resizing type is a design choice),
 *  but it points the user at the node. */
export function detectReadability(boxes: ElementBox[]): CritiqueIssue[] {
  const out: CritiqueIssue[] = [];
  for (const b of boxes) {
    if (!b.isText || b.minFontPx === undefined) continue;
    if (b.minFontPx >= MIN_READABLE_PX) continue;
    out.push({
      id: `readability:${b.id}`,
      category: "readability",
      severity: b.minFontPx < 8 ? "high" : "low",
      nodeId: b.id,
      message: `Text is very small (${Math.round(b.minFontPx)}px) and may be hard to read.`,
    });
  }
  return out;
}

/** A cluster of edges that ALMOST align: 2+ elements whose left/top edge sit
 *  within ALIGN_TOLERANCE..ALIGN_SNAP_MAX of a common value. Flags the outliers
 *  with an align-nudge fix to the cluster's dominant edge. */
export function detectAlignment(boxes: ElementBox[]): CritiqueIssue[] {
  if (boxes.length < 3) return [];
  const out: CritiqueIssue[] = [];
  const seen = new Set<string>();

  const scan = (axis: "x" | "y") => {
    const edge = (b: ElementBox) => (axis === "x" ? b.bounds.x : b.bounds.y);
    const sorted = [...boxes].sort((a, b) => edge(a) - edge(b));
    let i = 0;
    while (i < sorted.length) {
      // Gather a near-aligned run: edges within ALIGN_SNAP_MAX of the first.
      const group = [sorted[i]];
      let j = i + 1;
      while (j < sorted.length && edge(sorted[j]) - edge(sorted[i]) <= ALIGN_SNAP_MAX) {
        group.push(sorted[j]);
        j++;
      }
      if (group.length >= 2) {
        const spread = edge(group[group.length - 1]) - edge(group[0]);
        if (spread > ALIGN_TOLERANCE) {
          // Snap target = the most common edge (mode), else the first.
          const target = modeEdge(group.map(edge));
          for (const b of group) {
            const delta = target - edge(b);
            if (Math.abs(delta) <= ALIGN_TOLERANCE) continue;
            const key = `align:${axis}:${b.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
              id: key,
              category: "alignment",
              severity: "low",
              nodeId: b.id,
              message:
                axis === "x"
                  ? tr("app.element_is_slightly_off_the_left_edge_of_nea")
                  : tr("app.element_is_slightly_off_the_top_edge_of_near"),
              fix: {
                kind: "align_nudge",
                nodeId: b.id,
                dx: axis === "x" ? delta : 0,
                dy: axis === "y" ? delta : 0,
              },
            });
          }
        }
      }
      i = j > i ? j : i + 1;
    }
  };
  scan("x");
  scan("y");
  return out;
}

/** Most frequent value (rounded to a unit) in a list, else the first. */
function modeEdge(values: number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) {
    const k = Math.round(v);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best = Math.round(values[0]);
  let bestCount = 0;
  for (const [k, c] of counts) if (c > bestCount) { bestCount = c; best = k; }
  return best;
}

/** Uneven spacing among 3+ elements arranged in a row/column: detects a clear
 *  dominant axis (their centres mostly vary along one axis) and flags when the
 *  gaps between consecutive elements differ markedly. No per-node fix (the
 *  auto-layout tool offers distribute), so this is informational. */
export function detectSpacing(boxes: ElementBox[]): CritiqueIssue[] {
  if (boxes.length < 3) return [];
  const xs = boxes.map((b) => b.bounds.x + b.bounds.width / 2);
  const ys = boxes.map((b) => b.bounds.y + b.bounds.height / 2);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  const axis: "x" | "y" = spanX >= spanY ? "x" : "y";
  const sorted = [...boxes].sort((a, b) =>
    axis === "x" ? a.bounds.x - b.bounds.x : a.bounds.y - b.bounds.y,
  );
  // Gaps between adjacent edges along the axis.
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].bounds;
    const cur = sorted[i].bounds;
    gaps.push(
      axis === "x" ? cur.x - (prev.x + prev.width) : cur.y - (prev.y + prev.height),
    );
  }
  if (gaps.length < 2) return [];
  const min = Math.min(...gaps);
  const max = Math.max(...gaps);
  // Only flag a genuine row/column (positive gaps) with uneven spacing.
  if (min < 0) return [];
  const uneven = max - min > Math.max(8, max * 0.25);
  if (!uneven) return [];
  return [
    {
      id: "spacing:row",
      category: "spacing",
      severity: "low",
      message: `Spacing between ${axis === "x" ? "columns" : "rows"} is uneven. Distributing will even it out.`,
    },
  ];
}

/** Run every critique analyzer over a page and return the issues (FR-14). */
export function critiquePage(doc: DesignFile, pageIndex: number): CritiqueIssue[] {
  const { page, boxes, contrast } = elementBoxesForPage(doc, pageIndex);
  if (!page || !page.width) return [];
  return [
    ...detectContrast(contrast),
    ...detectOffCanvas(boxes, page),
    ...detectReadability(boxes),
    ...detectAlignment(boxes),
    ...detectSpacing(boxes),
  ];
}

// ---------------------------------------------------------------------------
// Style harmonization (FR-8)
// ---------------------------------------------------------------------------

/** A proposed harmonization change. `apply` is interpreted by the store wrapper. */
export type FontChange = { kind: "font"; from: string; to: string; count: number };
export type ColorChange = { kind: "color"; from: string; to: string; count: number };
export type RadiusChange = { kind: "radius"; from: number; to: number; count: number };
export type HarmonizeChange = FontChange | ColorChange | RadiusChange;

export interface HarmonizeProposal {
  fonts: FontChange[];
  colors: ColorChange[];
  radii: RadiusChange[];
  /** Target sets, for display ("collapse to N fonts / N color roles"). */
  keepFonts: string[];
  keepColors: string[];
  keepRadius: number | null;
}

/** Style census of a page: font families, solid color hexes, corner radii and
 *  whether shadows are used. Pure over a list of node descriptors so it can be
 *  unit-tested without a document. */
export interface StyleSample {
  nodeId: string;
  fonts: string[]; // font families used by this node's runs (text only)
  colors: string[]; // solid color hexes used by this node (fill/text)
  radius: number | null; // uniform corner radius if rect-ish, else null
}

function countBy<T>(items: T[]): Map<T, number> {
  const m = new Map<T, number>();
  for (const it of items) m.set(it, (m.get(it) ?? 0) + 1);
  return m;
}

/** The N most common entries (descending count, ties by first appearance). */
function topN<T>(counts: Map<T, number>, n: number): T[] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map((e) => e[0]);
}

/**
 * Propose harmonizing changes from style samples (FR-8): collapse fonts to the
 * 1-2 most common families, snap colors to the small set of most-used "roles",
 * and unify corner radii to the most common radius. Only emits a change when a
 * value actually differs from its target, so an already-consistent page yields
 * an empty proposal.
 */
export function harmonizeProposal(
  samples: StyleSample[],
  opts: { maxFonts?: number; maxColors?: number } = {},
): HarmonizeProposal {
  const maxFonts = opts.maxFonts ?? 2;
  const maxColors = opts.maxColors ?? 5;

  const fontCounts = countBy(samples.flatMap((s) => s.fonts));
  const colorCounts = countBy(samples.flatMap((s) => s.colors));
  const radiusCounts = countBy(samples.map((s) => s.radius).filter((r): r is number => r !== null && r > 0));

  const keepFonts = topN(fontCounts, maxFonts);
  const keepColors = topN(colorCounts, maxColors);
  const keepRadius = radiusCounts.size ? topN(radiusCounts, 1)[0] : null;

  // Map each off-set font to the most common kept font; each off-set color to
  // its nearest kept color (by perceptual distance via @hc/color when parseable).
  const fonts: FontChange[] = [];
  for (const [from, count] of fontCounts) {
    if (keepFonts.includes(from)) continue;
    const to = keepFonts[0];
    if (to && to !== from) fonts.push({ kind: "font", from, to, count });
  }

  const colors: ColorChange[] = [];
  const keepColorObjs = keepColors.map((h) => ({ hex: h, color: fromHex(h) }));
  for (const [from, count] of colorCounts) {
    if (keepColors.includes(from)) continue;
    const to = nearestKeptColor(from, keepColorObjs);
    if (to && to !== from) colors.push({ kind: "color", from, to, count });
  }

  const radii: RadiusChange[] = [];
  if (keepRadius !== null) {
    for (const [from, count] of radiusCounts) {
      if (from === keepRadius) continue;
      radii.push({ kind: "radius", from, to: keepRadius, count });
    }
  }

  return { fonts, colors, radii, keepFonts, keepColors, keepRadius };
}

/** Nearest kept color hex to `fromHex` by perceptual distance, falling back to
 *  the first kept color when either is unparseable. */
function nearestKeptColor(from: string, kept: { hex: string; color: Color | null }[]): string | null {
  if (!kept.length) return null;
  const src = fromHex(from);
  if (!src) return kept[0].hex;
  let best = kept[0].hex;
  let bestDist = Infinity;
  for (const k of kept) {
    if (!k.color) continue;
    const d =
      (src.srgb.r - k.color.srgb.r) ** 2 +
      (src.srgb.g - k.color.srgb.g) ** 2 +
      (src.srgb.b - k.color.srgb.b) ** 2;
    if (d < bestDist) { bestDist = d; best = k.hex; }
  }
  return best;
}

/** Build style samples for the active page's top-level nodes (FR-8 input). */
export function styleSamplesForPage(doc: DesignFile, pageIndex: number): StyleSample[] {
  const page = doc.pages[pageIndex];
  if (!page) return [];
  const samples: StyleSample[] = [];
  for (const node of page.children) {
    if (node.hidden || node.locked) continue;
    const fonts: string[] = [];
    const colors: string[] = [];
    let radius: number | null = null;
    if (node.type === "text") {
      const content = (node as unknown as { content: { runs: { style: { fontFamily: string; fill?: Fill } }[] }[] }).content;
      for (const p of content) for (const r of p.runs) {
        fonts.push(r.style.fontFamily);
        if (r.style.fill && r.style.fill.type === "solid") colors.push(toHex(r.style.fill.color));
      }
    } else {
      const c = solidFillColor(node);
      if (c) colors.push(toHex(c));
    }
    const cr = (node as unknown as { cornerRadius?: { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number } }).cornerRadius;
    if (cr && cr.topLeft === cr.topRight && cr.topRight === cr.bottomRight && cr.bottomRight === cr.bottomLeft) {
      radius = cr.topLeft;
    }
    samples.push({ nodeId: node.id, fonts: [...new Set(fonts)], colors: [...new Set(colors)], radius });
  }
  return samples;
}

/** True when a proposal contains at least one change. */
export function hasHarmonizeChanges(p: HarmonizeProposal): boolean {
  return p.fonts.length > 0 || p.colors.length > 0 || p.radii.length > 0;
}

// ---------------------------------------------------------------------------
// Auto-layout suggestions (FR-9)
// ---------------------------------------------------------------------------

export type AutoLayoutOp = "align-left" | "align-top" | "distribute-h" | "distribute-v" | "tidy" | "fit";

export interface AutoLayoutSuggestion {
  op: AutoLayoutOp;
  label: string;
  /** Node ids the operation should be applied to (the affected siblings). */
  nodeIds: string[];
}

/**
 * Suggest one-click layout operations from the page's element boxes (FR-9):
 * - misaligned left/top edges -> align;
 * - 3+ elements in a row/column with uneven gaps -> distribute;
 * - overflowing / off-canvas elements -> "fit" (move back in bounds via tidy).
 * Each suggestion names the existing align/distribute/tidy command and the
 * sibling ids to run it over. Returns at most one of each op.
 */
export function autoLayoutSuggestions(
  boxes: ElementBox[],
  page: { width: number; height: number },
): AutoLayoutSuggestion[] {
  const out: AutoLayoutSuggestion[] = [];
  const ids = boxes.map((b) => b.id);

  const align = detectAlignment(boxes);
  const leftMisaligned = align.filter((i) => i.fix?.kind === "align_nudge" && i.fix.dx !== 0).map((i) => i.nodeId!);
  const topMisaligned = align.filter((i) => i.fix?.kind === "align_nudge" && i.fix.dy !== 0).map((i) => i.nodeId!);
  if (leftMisaligned.length >= 1 && boxes.length >= 2) {
    out.push({ op: "align-left", label: tr("app.align_left_edges"), nodeIds: ids });
  } else if (topMisaligned.length >= 1 && boxes.length >= 2) {
    out.push({ op: "align-top", label: tr("app.align_top_edges"), nodeIds: ids });
  }

  const spacing = detectSpacing(boxes);
  if (spacing.length && boxes.length >= 3) {
    const xs = boxes.map((b) => b.bounds.x + b.bounds.width / 2);
    const ys = boxes.map((b) => b.bounds.y + b.bounds.height / 2);
    const horiz = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
    out.push(
      horiz
        ? { op: "distribute-h", label: tr("app.distribute_horizontally"), nodeIds: ids }
        : { op: "distribute-v", label: tr("app.distribute_vertically"), nodeIds: ids },
    );
  }

  const off = detectOffCanvas(boxes, page);
  if (off.length) {
    out.push({ op: "fit", label: tr("app.bring_stray_elements_into_the_page"), nodeIds: off.map((i) => i.nodeId!).filter(Boolean) });
  }

  if (boxes.length >= 2 && !out.some((s) => s.op === "tidy")) {
    out.push({ op: "tidy", label: tr("app.tidy_up_into_an_even_grid"), nodeIds: ids });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Auto-animate (FR-11)
// ---------------------------------------------------------------------------

export type AnimateStyle = "fade" | "rise" | "pop";

export const ANIMATE_STYLES: { id: AnimateStyle; label: string }[] = [
  { id: "fade", label: "Fade" },
  { id: "rise", label: "Rise" },
  { id: "pop", label: "Pop" },
];

/** A staggered entrance assignment for one node. */
export interface AnimateAssignment {
  nodeId: string;
  preset: AnimateStyle;
  durationMs: number;
  delayMs: number;
}

/**
 * Assign a coherent staggered entrance to nodes in reading order (FR-11):
 * top-to-bottom then left-to-right, each delayed `stagger` ms after the prior.
 * Pure over (id, bounds) pairs so it is testable and deterministic.
 */
export function autoAnimatePlan(
  boxes: { id: string; bounds: Rect }[],
  style: AnimateStyle,
  opts: { durationMs?: number; staggerMs?: number } = {},
): AnimateAssignment[] {
  const durationMs = opts.durationMs ?? 500;
  const staggerMs = opts.staggerMs ?? 120;
  const ordered = [...boxes].sort((a, b) => {
    const dy = a.bounds.y - b.bounds.y;
    if (Math.abs(dy) > 8) return dy; // distinct rows: top first
    return a.bounds.x - b.bounds.x; // same row: left first
  });
  return ordered.map((b, i) => ({
    nodeId: b.id,
    preset: style,
    durationMs,
    delayMs: i * staggerMs,
  }));
}

/** Reading-order boxes for the active page's top-level visible nodes. */
export function animateBoxesForPage(doc: DesignFile, pageIndex: number): { id: string; bounds: Rect }[] {
  const page = doc.pages[pageIndex];
  if (!page) return [];
  const out: { id: string; bounds: Rect }[] = [];
  for (const node of page.children) {
    if (node.hidden) continue;
    const b = worldAABB(doc, node.id);
    if (b) out.push({ id: node.id, bounds: b });
  }
  return out;
}
