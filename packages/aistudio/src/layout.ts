// F39 AI Creative Studio - the deterministic layout engine. It turns a validated
// AiDesignSpec (content + roles + a layout intent) into a positioned page: a
// background Fill plus a list of schema Nodes. The model never picks pixels; this
// engine owns margins, the type scale, the vertical rhythm, alignment, z-order,
// and readable text color (WCAG-aware). Pure and framework-agnostic.

import { createNode, type Color, type Fill, type Node } from "@hc/schema";
import { contrastRatio, fixToAA, fromHex } from "@hc/color";
import type { AiDesignSpec, BlockRole, DesignBlock, DesignLayout } from "./spec";

const WHITE: Color = { srgb: { r: 1, g: 1, b: 1, a: 1 } };
const NEAR_BLACK: Color = { srgb: { r: 0.1, g: 0.12, b: 0.16, a: 1 } };

export interface Size {
  width: number;
  height: number;
}

export interface LayoutResult {
  background: Fill;
  nodes: Node[];
}

/** Type scale as a fraction of the page's shorter side, plus weight + tracking,
 *  so headings read as headings on any page size. */
const TYPE_SCALE: Record<BlockRole, { size: number; wght: number; tracking: number; lineHeight: number }> = {
  eyebrow: { size: 0.026, wght: 600, tracking: 0.12, lineHeight: 1.2 },
  heading: { size: 0.11, wght: 800, tracking: -0.01, lineHeight: 1.05 },
  subheading: { size: 0.05, wght: 600, tracking: 0, lineHeight: 1.15 },
  body: { size: 0.028, wght: 400, tracking: 0, lineHeight: 1.35 },
  accent: { size: 0, wght: 400, tracking: 0, lineHeight: 1 },
};

/** Vertical gap after a block, as a fraction of the page's shorter side, keyed by
 *  the role that precedes the gap. Tighter under eyebrows, looser after headings. */
const GAP_AFTER: Record<BlockRole, number> = {
  eyebrow: 0.012,
  heading: 0.03,
  subheading: 0.035,
  body: 0.025,
  accent: 0.03,
};

function resolveBackground(spec: AiDesignSpec): { fill: Fill; refs: Color[] } {
  const start = fromHex(spec.background.color ?? "#ffffff") ?? WHITE;
  if (spec.background.kind === "gradient" && spec.background.color2) {
    const end = fromHex(spec.background.color2) ?? start;
    return {
      fill: {
        type: "gradient",
        gradient: "linear",
        angle: spec.background.angle ?? 135,
        stops: [
          { position: 0, color: start },
          { position: 1, color: end },
        ],
      } as Fill,
      // Both stops are contrast references: text must be readable across the
      // WHOLE gradient, so we evaluate against every stop and take the worst.
      refs: [start, end],
    };
  }
  return { fill: { type: "solid", color: start }, refs: [start] };
}

/** Lowest contrast of `fg` against any background reference (worst case). */
function minContrast(fg: Color, refs: Color[]): number {
  let m = Infinity;
  for (const ref of refs) m = Math.min(m, contrastRatio(fg, ref));
  return m === Infinity ? 0 : m;
}

/** The reference `fg` reads worst against (used to nudge toward AA). */
function worstRef(fg: Color, refs: Color[]): Color {
  let worst = refs[0];
  let worstC = contrastRatio(fg, refs[0]);
  for (const ref of refs) {
    const c = contrastRatio(fg, ref);
    if (c < worstC) {
      worst = ref;
      worstC = c;
    }
  }
  return worst;
}

/** Black or white, whichever stays more readable across all references, nudged
 *  to AA against its worst reference. Guarantees readability over a gradient. */
function readableOn(refs: Color[]): Color {
  const base = minContrast(WHITE, refs) >= minContrast(NEAR_BLACK, refs) ? WHITE : NEAR_BLACK;
  return fixToAA(base, worstRef(base, refs));
}

/** The exact ink this engine paints over the given background references -
 *  exported for theme derivation (T19): a theme record built from a generated
 *  deck must carry the very color the pages were painted with, so a later
 *  theme swap can remap it precisely. */
export function readableTextColor(refs: Color[]): Color {
  return readableOn(refs.length ? refs : [WHITE]);
}

/** Readable text color for a block: honor the spec hint only if it already clears
 *  AA against every background reference; otherwise auto-pick a readable color. */
function textColorFor(block: DesignBlock, refs: Color[]): Color {
  const hinted = block.color ? fromHex(block.color) : null;
  if (hinted && minContrast(hinted, refs) >= 4.5) return hinted;
  return readableOn(refs);
}

/** Estimate wrapped line count from content width and font size (avg glyph
 *  advance ~0.52em). Deterministic and conservative so blocks don't overlap. */
function estimateLines(text: string, fontSize: number, boxWidth: number): number {
  const charsPerLine = Math.max(1, Math.floor(boxWidth / (fontSize * 0.52)));
  const explicit = text.split("\n");
  let lines = 0;
  for (const seg of explicit) lines += Math.max(1, Math.ceil(seg.length / charsPerLine));
  return Math.max(1, lines);
}

interface Placed {
  block: DesignBlock;
  fontSize: number;
  height: number;
  wght: number;
  tracking: number;
}

export function layoutDesign(spec: AiDesignSpec, size: Size): LayoutResult {
  const w = Math.max(1, Math.round(size.width));
  const h = Math.max(1, Math.round(size.height));
  const shortSide = Math.min(w, h);
  const margin = Math.round(shortSide * 0.08);
  const contentW = Math.max(1, w - margin * 2);
  const contentH = Math.max(1, h - margin * 2);

  const { fill: background, refs: bgRefs } = resolveBackground(spec);
  const headingFont = spec.fonts?.heading || "system";
  const bodyFont = spec.fonts?.body || "system";

  // Content column width depends on the layout intent.
  const layout: DesignLayout = spec.layout;
  const colW = layout === "split" ? Math.round(contentW * 0.55) : contentW;

  // Measure every block into the column to get a total stack height.
  const placed: Placed[] = [];
  let stackH = 0;
  spec.blocks.forEach((block, i) => {
    const scale = TYPE_SCALE[block.role];
    if (block.role === "accent") {
      const barH = Math.max(3, Math.round(shortSide * 0.01));
      placed.push({ block, fontSize: 0, height: barH, wght: 0, tracking: 0 });
      stackH += barH;
    } else {
      const fontSize = Math.max(8, Math.round(shortSide * scale.size));
      const lines = estimateLines(block.text ?? "", fontSize, colW);
      const height = Math.ceil(lines * fontSize * scale.lineHeight);
      placed.push({ block, fontSize, height, wght: scale.wght, tracking: scale.tracking });
      stackH += height;
    }
    if (i < spec.blocks.length - 1) stackH += Math.round(shortSide * GAP_AFTER[spec.blocks[i].role]);
  });

  // Fit-to-height: if the stack is taller than the content area, scale every
  // block (font, height, gaps) down uniformly so nothing overflows the page.
  // This makes FR-13's geometry guarantee hold for text-heavy briefs.
  const fit = stackH > contentH ? contentH / stackH : 1;
  const gapPx = (role: BlockRole) => Math.round(shortSide * GAP_AFTER[role] * fit);
  const scaledStackH = stackH * fit;

  // Vertical anchor of the (scaled) stack within the content area.
  let cursorY: number;
  if (layout === "title-top") {
    cursorY = margin; // top-aligned
  } else {
    // centered / left / split: vertically center, clamped to the top margin.
    cursorY = margin + Math.max(0, Math.round((contentH - scaledStackH) / 2));
  }

  // Horizontal anchor + text alignment. RTL flips edge-aligned layouts to the
  // right edge and sets right text alignment (a competitor weak spot, FR per
  // the RTL/non-Latin hardening goal).
  const rtl = spec.dir === "rtl";
  const align: "left" | "center" | "right" =
    layout === "centered" ? "center" : rtl ? "right" : "left";
  const colLeft =
    layout === "centered"
      ? margin + Math.round((contentW - colW) / 2)
      : rtl
        ? w - margin - colW
        : margin;

  const nodes: Node[] = [];
  placed.forEach((p, i) => {
    const boxH = Math.max(1, Math.round(p.height * fit));
    if (p.block.role === "accent") {
      const barW = Math.round(colW * 0.28);
      const barColor = p.block.color ? fromHex(p.block.color) ?? readableOn(bgRefs) : readableOn(bgRefs);
      const x =
        align === "center"
          ? colLeft + Math.round((colW - barW) / 2)
          : align === "right"
            ? colLeft + (colW - barW)
            : colLeft;
      const r = Math.round(boxH / 2);
      nodes.push(
        createNode("shape", {
          name: "Accent",
          shape: "rect",
          transform: { x, y: cursorY, scaleX: 1, scaleY: 1, rotation: 0 },
          size: { width: barW, height: boxH },
          cornerRadius: { topLeft: r, topRight: r, bottomRight: r, bottomLeft: r },
          fills: [{ type: "solid", color: barColor }],
        } as Partial<Node>),
      );
    } else {
      const fontSize = Math.max(8, Math.round(p.fontSize * fit));
      const fillColor = textColorFor(p.block, bgRefs);
      nodes.push(
        createNode("text", {
          name: (p.block.text ?? p.block.role).slice(0, 24) || p.block.role,
          transform: { x: colLeft, y: cursorY, scaleX: 1, scaleY: 1, rotation: 0 },
          size: { width: colW, height: boxH },
          box: {
            mode: "fixed",
            width: colW,
            height: boxH,
            autoFit: { enabled: true, min: 8, max: Math.max(8, Math.round(fontSize * 1.4)) },
            verticalAlign: "top",
          },
          content: [
            {
              runs: [
                {
                  text: p.block.text ?? "",
                  style: {
                    fontFamily: p.block.role === "body" ? bodyFont : headingFont,
                    fontStyle: "Regular",
                    fontSize,
                    axes: { wght: p.wght },
                    letterSpacing: p.tracking ? p.tracking * fontSize : undefined,
                    fill: { type: "solid", color: fillColor },
                  },
                },
              ],
              style: { align, direction: rtl ? "rtl" : "auto" },
            },
          ],
        } as Partial<Node>),
      );
    }
    cursorY += boxH;
    if (i < placed.length - 1) cursorY += gapPx(placed[i].block.role);
  });

  return { background, nodes };
}
