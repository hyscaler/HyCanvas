// Constraint-aware page re-layout (Magic Resize / Magic Switch core, F22
// FR-1/FR-2). This is ALGORITHMIC, not an AI call: it re-lays-out a page to a
// new size by inferring each top-level node's anchor from where it sits in the
// source page, then mapping anchored edges/centers into the target and scaling
// element sizes by a sensible factor. It is pure (no store, no IO) so it is
// unit-testable in isolation.
//
// Design choices (kept pragmatic but clearly better than uniform scaling):
//  - Anchors are inferred per top-level node from its margins to the source
//    page edges (left/center/right/stretch horizontally; top/middle/bottom/
//    stretch vertically). A node spanning nearly the whole axis is "stretch"
//    (a full-bleed background); otherwise it snaps to the nearest edge or center.
//  - Element sizes scale by the geometric mean of the width/height ratios, so a
//    square element stays roughly square across an aspect-ratio change rather
//    than being crushed. Stretched axes take the full target span instead.
//  - Text: font size scales by the same factor (clamped to the box autoFit
//    min/max where present, else a sane default), and the text box width is set
//    to the node's new mapped width so it reflows; box height tracks the node.
//  - Images: the node keeps its fit/crop/clip so it recrops within the new
//    frame rather than distorting (we only change transform + size).
//  - Groups / nested children: the group is re-placed as a UNIT (its transform
//    and size change); children are left relative to the group, so identity and
//    inner layout are preserved.
//  - Node ids, z-order, group structure are all preserved: we deep-clone and
//    only rewrite transforms/sizes (and text box/font), never ids or children.

import type {
  Node,
  Page,
  Paragraph,
  TextBox,
  TextNode,
} from "@hc/schema";

export interface ResizeTarget {
  width: number;
  height: number;
}

// A node spanning at least this fraction of an axis (after margins) is treated
// as stretched on that axis (full-bleed background, divider bar, etc.).
const STRETCH_FRACTION = 0.92;
// Font size is never scaled outside this absolute range, regardless of factor,
// so a huge upscale stays legible and a tiny downscale stays readable. The
// box's own autoFit min/max (when present) further constrains within this.
const FONT_MIN = 6;
const FONT_MAX = 800;

type Anchor1D = "start" | "center" | "end" | "stretch";

interface AxisPlan {
  anchor: Anchor1D;
  /** Source margin from the relevant edge (start margin, or end margin). */
  startMargin: number;
  endMargin: number;
}

/** Infer how a node is anchored on one axis from its position/extent in the
 *  source page. `pos` is the node origin, `extent` its size, `pageExtent` the
 *  page width/height on that axis. */
function inferAxis(pos: number, extent: number, pageExtent: number): AxisPlan {
  const startMargin = pos;
  const endMargin = pageExtent - (pos + extent);
  if (pageExtent > 0 && extent / pageExtent >= STRETCH_FRACTION) {
    return { anchor: "stretch", startMargin, endMargin };
  }
  const center = pos + extent / 2;
  const pageCenter = pageExtent / 2;
  // Distance from the node center to each reference. The nearest wins.
  const dStart = Math.abs(startMargin);
  const dEnd = Math.abs(endMargin);
  const dCenter = Math.abs(center - pageCenter);
  if (dCenter <= dStart && dCenter <= dEnd) {
    return { anchor: "center", startMargin, endMargin };
  }
  return { anchor: dStart <= dEnd ? "start" : "end", startMargin, endMargin };
}

/** Map a node's extent + origin on one axis into the target, honoring the
 *  inferred anchor and scaling non-stretched extents by `factor`. */
function mapAxis(
  plan: AxisPlan,
  extent: number,
  targetExtent: number,
  factor: number,
): { pos: number; extent: number } {
  if (plan.anchor === "stretch") {
    // Fill the target axis, keeping the original (small) margins on both sides.
    const pos = plan.startMargin;
    const newExtent = Math.max(1, targetExtent - plan.startMargin - plan.endMargin);
    return { pos, extent: newExtent };
  }
  const newExtent = Math.max(1, extent * factor);
  let pos: number;
  if (plan.anchor === "start") {
    // Keep the start margin fixed.
    pos = plan.startMargin;
  } else if (plan.anchor === "end") {
    // Keep the end margin fixed: distance from the node's end to the page end.
    pos = targetExtent - plan.endMargin - newExtent;
  } else {
    // Center: keep the node centered on the target axis.
    pos = (targetExtent - newExtent) / 2;
  }
  // Clamp so the element stays on-canvas (its box never starts past the page or
  // ends before 0); allow it to overhang only if it is larger than the page.
  if (newExtent <= targetExtent) {
    pos = Math.max(0, Math.min(pos, targetExtent - newExtent));
  }
  return { pos, extent: newExtent };
}

/** Scale a text node's fonts by `factor`, clamped to the box autoFit range (or
 *  a global range), and set the box width/height to the node's new size so the
 *  text reflows. Mutates the cloned node in place. */
function reflowText(node: TextNode, factor: number): void {
  const box = node.box as TextBox | undefined;
  const min = Math.max(FONT_MIN, box?.autoFit?.min ?? FONT_MIN);
  const max = Math.min(FONT_MAX, box?.autoFit?.max ?? FONT_MAX);
  const clampFont = (size: number) => Math.max(min, Math.min(max, size * factor));
  const content = node.content as Paragraph[] | undefined;
  if (Array.isArray(content)) {
    for (const para of content) {
      if (para.style?.baseChar?.fontSize != null) {
        para.style.baseChar.fontSize = clampFont(para.style.baseChar.fontSize);
      }
      for (const run of para.runs ?? []) {
        if (run.style?.fontSize != null) run.style.fontSize = clampFont(run.style.fontSize);
        if (run.overrides?.fontSize != null) run.overrides.fontSize = clampFont(run.overrides.fontSize);
      }
    }
  }
  // Sync the layout box to the node's (already mapped) size so text reflows to
  // the new frame width and the box matches the gizmo. autoWidth boxes keep
  // following their content, so only width/height are mirrored here.
  if (box) {
    box.width = node.size.width;
    box.height = node.size.height;
  }
}

/**
 * Re-lay-out a page to a new size, constraint-aware (NOT a uniform scale).
 * Returns a NEW Page with the same node ids, z-order, and group structure, and
 * new transforms/sizes mapped to the target. The source page is not mutated.
 *
 * Only un-rotated top-level nodes are anchor-mapped; a rotated node keeps its
 * rotation and is treated by its axis-aligned origin (best effort). Nested
 * children move with their group (the group is re-placed as a unit).
 */
export function resizePage(page: Page, target: ResizeTarget): Page {
  const tW = Math.max(1, Math.round(target.width));
  const tH = Math.max(1, Math.round(target.height));
  const sW = Math.max(1, page.width);
  const sH = Math.max(1, page.height);

  // Geometric mean of the per-axis ratios: balances extreme aspect changes so
  // elements stay proportioned instead of being stretched on one axis.
  const factor = Math.sqrt((tW / sW) * (tH / sH));

  const out: Page = {
    ...structuredClone(page),
    width: tW,
    height: tH,
  };

  for (const node of out.children) {
    const t = node.transform;
    const xPlan = inferAxis(t.x, node.size.width, sW);
    const yPlan = inferAxis(t.y, node.size.height, sH);
    const mx = mapAxis(xPlan, node.size.width, tW, factor);
    const my = mapAxis(yPlan, node.size.height, tH, factor);

    node.transform = { ...t, x: mx.pos, y: my.pos };
    node.size = { width: mx.extent, height: my.extent };

    if (node.type === "text") {
      reflowText(node as TextNode, factor);
    }
    // Images, groups, and everything else keep their internal data (fit/crop/
    // clip, children) untouched: changing only transform+size recrops images
    // within their frame and re-places a group as a unit.
    void (node as Node);
  }

  return out;
}
