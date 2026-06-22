// Auto-fit: binary-search a uniform font-size scale so the laid-
// out content fits the box height within the configured min/max, and a
// "fit box to text" that returns box dimensions sized to the content.

import type { CharStyle, TextNode } from "@hc/schema";
import { layoutText, measureText, type LayoutOptions } from "./layout";

function scaleNode(node: TextNode, scale: number): TextNode {
  const scaleStyle = (style: CharStyle): CharStyle => {
    const next: CharStyle = { ...style, fontSize: style.fontSize * scale };
    // An absolute line height must scale with the font; multiplier/auto already do.
    if (style.lineHeight && typeof style.lineHeight === "object" && style.lineHeight.mode === "absolute") {
      next.lineHeight = { mode: "absolute", value: style.lineHeight.value * scale };
    }
    return next;
  };
  return {
    ...node,
    content: node.content.map((p) => ({
      ...p,
      runs: p.runs.map((r) => ({ ...r, style: scaleStyle(r.style) })),
    })),
  };
}

/**
 * Largest font-size scale (multiplier on every run's fontSize) in
 * [minScale, maxScale] for which content height fits box.height. Uses a fixed
 * number of bisection steps with hysteresis-free convergence.
 */
export function autoFitScale(
  node: TextNode,
  opts: LayoutOptions = {},
  bounds: { minScale?: number; maxScale?: number; steps?: number } = {},
): number {
  const minScale = bounds.minScale ?? 0.25;
  const maxScale = bounds.maxScale ?? 4;
  const steps = bounds.steps ?? 20;
  const target = node.box.height - (node.box.padding ? node.box.padding.t + node.box.padding.b : 0);

  const fits = (scale: number) => {
    const laid = layoutText({ ...scaleNode(node, scale), box: { ...node.box, mode: "autoHeight" } }, opts);
    return laid.height <= target;
  };

  if (fits(maxScale)) return maxScale;
  if (!fits(minScale)) return minScale;
  let lo = minScale;
  let hi = maxScale;
  for (let i = 0; i < steps; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Box dimensions sized to the content (fit box to text). The autoWidth measure
 *  already includes padding, so no extra is added. */
export function fitBoxToText(
  node: TextNode,
  opts: LayoutOptions = {},
): { width: number; height: number } {
  return measureText({ ...node, box: { ...node.box, mode: "autoWidth" } }, opts);
}
