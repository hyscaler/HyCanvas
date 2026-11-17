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
//  - Text never grows wider than the target leaves room for: its scale is
//    capped so the box keeps its (proportional) side margins, and font, width
//    and height share that scale so the text wraps exactly as before.
//  - Stacking survives: each node is anchored on its own, so a centered title
//    that grows can run into a subtitle anchored to the top (#83). After the
//    anchor pass, blocks that sat one above (or beside) the other in the source
//    are pushed apart again, keeping the source gap, and pulled back inside
//    the page.

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

/** Scale for a text node: the shared factor, unless that would make the box
 *  wider than the target leaves room for. The room is the target width minus
 *  the node's source side margins scaled to the new width, so a title that
 *  filled the post's width fills the story's width instead of running off it.
 *  Font, width and height all use this one scale, so the text wraps the same. */
function textScale(plan: AxisPlan, w0: number, sW: number, tW: number, factor: number): number {
  if (w0 <= 0) return factor;
  if (plan.anchor === "stretch") {
    // The box takes the target span; the font follows the width actually given.
    const span = Math.max(1, tW - plan.startMargin - plan.endMargin);
    return Math.min(factor, span / w0);
  }
  // Text already hanging off the source page has no margin to keep.
  if (plan.startMargin < 0 || plan.endMargin < 0) return factor;
  const kx = tW / sW;
  const room = tW - (plan.startMargin + plan.endMargin) * kx;
  return room > 0 ? Math.min(factor, room / w0) : factor;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlapX = (a: Box, b: Box) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0;
const containsCenter = (outer: Box, inner: Box) => {
  const cx = inner.x + inner.w / 2;
  const cy = inner.y + inner.h / 2;
  return cx >= outer.x && cx <= outer.x + outer.w && cy >= outer.y && cy <= outer.y + outer.h;
};
function bounds(boxes: Box[]): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Place one node: its new origin, and the uniform scale `k` for its size. */
function placeNode(node: Node, x: number, y: number, w: number, h: number, k: number): void {
  const w0 = node.size.width;
  const h0 = node.size.height;
  node.transform = { ...node.transform, x, y };
  node.size = { width: w, height: h };
  if (node.type === "text") reflowText(node as TextNode, k);
  // A line draws from its points, not its size, so the polyline must scale
  // with the mapped box or the stroke keeps its old length.
  if (node.type === "line") {
    const rec = node as unknown as { points?: { x: number; y: number }[] };
    const kx = w0 > 0 ? w / w0 : 1;
    const ky = h0 > 0 ? h / h0 : 1;
    if (rec.points) rec.points = rec.points.map((p) => ({ ...p, x: p.x * kx, y: p.y * ky }));
  }
  // Images, groups, and everything else keep their internal data (fit/crop/
  // clip, children) untouched: changing only transform+size recrops images
  // within their frame and re-places a group as a unit.
}

/** Whether any two of these nodes overlap now that did not in the source. */
function newOverlap(items: { node: Node; src: Box }[]): boolean {
  const area = (a: Box, b: Box) =>
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const now = (n: Node): Box => ({ x: n.transform.x, y: n.transform.y, w: n.size.width, h: n.size.height });
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (area(items[i].src, items[j].src) > 0) continue;
      if (area(now(items[i].node), now(items[j].node)) > 1) return true;
    }
  }
  return false;
}

interface Block {
  members: { node: Node; src: Box }[];
  src: Box;
  cur: Box;
}

/**
 * Put back the order the anchor pass can break, along one axis. For every pair
 * of blocks where one sat wholly before the other on `axis` in the source
 * (above it for "y", left of it for "x") and they overlap on the other axis
 * before and after, the later block is pushed along until the source gap,
 * scaled by `gapScale`, is restored. Blocks pushed past the page end are then
 * pulled back as far as the page start allows, taking the blocks before them
 * along. Only the transform on `axis` changes.
 */
function restoreOrder(blocks: Block[], axis: "x" | "y", srcEnd: number, end: number, gapScale: number): void {
  if (blocks.length < 2) return;
  const P = axis;
  const S = axis === "x" ? "w" : "h";
  const across = (a: Box, b: Box) =>
    axis === "y" ? overlapX(a, b) : Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0;
  const order = [...blocks].sort((a, b) => a.src[P] - b.src[P]);
  const before = order.map((b) =>
    order
      .filter((a) => a !== b && a.src[P] + a.src[S] <= b.src[P] + 1 && across(a.src, b.src) && across(a.cur, b.cur))
      .map((a) => ({ a, gap: Math.max(0, b.src[P] - (a.src[P] + a.src[S])) * gapScale })),
  );
  const shift = (blk: Block, d: number) => {
    if (!d) return;
    for (const m of blk.members) m.node.transform = { ...m.node.transform, [P]: m.node.transform[P] + d };
    blk.cur = { ...blk.cur, [P]: blk.cur[P] + d };
  };
  // Forward pass: clear every block that came before.
  order.forEach((b, j) => {
    let need = -Infinity;
    for (const { a, gap } of before[j]) need = Math.max(need, a.cur[P] + a.cur[S] + gap);
    if (b.cur[P] < need) shift(b, need - b.cur[P]);
  });
  // Backward pass: a block pushed past the page end comes back, and anything
  // before it that now collides follows, never past the page start.
  for (let j = order.length - 1; j >= 0; j--) {
    const b = order[j];
    const over = b.cur[P] + b.cur[S] - end;
    if (over > 0 && b.src[P] + b.src[S] <= srcEnd + 1) shift(b, -Math.min(over, Math.max(0, b.cur[P])));
    for (const { a, gap } of before[j]) {
      const clash = a.cur[P] + a.cur[S] + gap - b.cur[P];
      if (clash > 0) shift(a, -Math.min(clash, Math.max(0, a.cur[P])));
    }
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
 *
 * Content is mapped in blocks: nodes where one box holds the other's center (a
 * label on its pill, a price on its card) are one block, anchored and scaled as
 * a unit so their arrangement survives. Full-bleed and stretched nodes,
 * backgrounds (half the page or more) and decorations hanging off the page are
 * mapped on their own and take no part in the stacking repair.
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

  const items = out.children.map((node) => {
    const src: Box = { x: node.transform.x, y: node.transform.y, w: node.size.width, h: node.size.height };
    const xPlan = inferAxis(src.x, src.w, sW);
    const yPlan = inferAxis(src.y, src.h, sH);
    // A full-width line (a wide title) is content and takes part in blocks;
    // only a full-height node is treated as background.
    const free =
      yPlan.anchor !== "stretch" &&
      src.w * src.h < 0.5 * sW * sH &&
      src.x >= -1 && src.y >= -1 && src.x + src.w <= sW + 1 && src.y + src.h <= sH + 1;
    return { node, src, xPlan, yPlan, free };
  });

  // A panel (a card, a window frame) is content too, however much of the page
  // it covers, when it holds other content: mapped on its own, it stayed put
  // while the text on it moved as blocks, so a subtitle ended up off the card
  // on a dark background (#92). Promote it into the blocks, so it travels with
  // what sits on it. A panel holding nothing stays a backdrop.
  for (const it of items) {
    if (it.free || it.xPlan.anchor === "stretch" || it.yPlan.anchor === "stretch") continue;
    const inPage = it.src.x >= -1 && it.src.y >= -1 && it.src.x + it.src.w <= sW + 1 && it.src.y + it.src.h <= sH + 1;
    if (!inPage) continue;
    const held = items.filter((o) => o.free && containsCenter(it.src, o.src));
    if (held.some((o) => o.node.type === "text")) it.free = true;
  }

  // Nodes outside any block: mapped one by one on their own anchors. A
  // decoration that stretches on neither axis (a giant quote mark, a circle
  // bleeding off a corner) grows by the smaller axis ratio only, so a post
  // turned into a slide does not swell it into the text beside it.
  const decorScale = Math.min(tW / sW, tH / sH);
  for (const it of items) {
    if (it.free) continue;
    const decor = it.xPlan.anchor !== "stretch" && it.yPlan.anchor !== "stretch";
    const k = decor ? Math.min(factor, decorScale) : it.node.type === "text" ? textScale(it.xPlan, it.src.w, sW, tW, factor) : factor;
    const mx = mapAxis(it.xPlan, it.src.w, tW, k);
    const my = mapAxis(it.yPlan, it.src.h, tH, k);
    placeNode(it.node, mx.pos, my.pos, mx.extent, my.extent, k);
  }

  // Blocks: union-find over the free nodes.
  const free = items.filter((it) => it.free);
  const parent = free.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < free.length; i++) {
    for (let j = i + 1; j < free.length; j++) {
      if (containsCenter(free[i].src, free[j].src) || containsCenter(free[j].src, free[i].src)) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, typeof free>();
  free.forEach((it, i) => {
    const g = groups.get(find(i));
    if (g) g.push(it);
    else groups.set(find(i), [it]);
  });

  // The blocks together must still fit: cap their scale so the span all of
  // them covered in the source, with its outer margins scaled to the target,
  // fits on each axis. Otherwise the stacking repair runs out of page and has
  // to leave blocks overlapping.
  let blockFactor = factor;
  if (free.length) {
    const all = bounds(free.map((it) => it.src));
    const fit = (pos: number, extent: number, srcExtent: number, tgtExtent: number) => {
      const room = tgtExtent - (Math.max(0, pos) + Math.max(0, srcExtent - pos - extent)) * (tgtExtent / srcExtent);
      return extent > 0 && room > 0 ? room / extent : Infinity;
    };
    blockFactor = Math.min(factor, fit(all.x, all.w, sW, tW), fit(all.y, all.h, sH, tH));
  }

  const blocks: Block[] = [];
  for (const members of groups.values()) {
    const B = bounds(members.map((m) => m.src));
    const xPlan = inferAxis(B.x, B.w, sW);
    const yPlan = inferAxis(B.y, B.h, sH);
    // Every block keeps its proportional side margins, not only text: a wide
    // panel that keeps its full width on a narrow page shoves its neighbors
    // off the side.
    const k = textScale(xPlan, B.w, sW, tW, blockFactor);
    const mx = mapAxis(xPlan, B.w, tW, k);
    const my = mapAxis(yPlan, B.h, tH, k);
    for (const m of members) {
      placeNode(m.node, mx.pos + (m.src.x - B.x) * k, my.pos + (m.src.y - B.y) * k, Math.max(1, m.src.w * k), Math.max(1, m.src.h * k), k);
    }
    blocks.push({ members: members.map((m) => ({ node: m.node, src: m.src })), src: B, cur: { x: mx.pos, y: my.pos, w: mx.extent, h: my.extent } });
  }

  // Decorative text placed on its own (a giant glyph in a corner, big lines
  // bleeding off an edge) joins the order repair as one-node blocks, so two
  // stacked bleed lines that share an anchor do not land on the same spot and
  // a corner glyph keeps clear of the text it sat beside.
  const nowBox = (n: Node): Box => ({ x: n.transform.x, y: n.transform.y, w: n.size.width, h: n.size.height });
  for (const it of items) {
    if (!it.free && it.node.type === "text" && it.yPlan.anchor !== "stretch") {
      blocks.push({ members: [{ node: it.node, src: it.src }], src: it.src, cur: nowBox(it.node) });
    }
  }

  // Columns first (a wide page's side-by-side blocks squeezed onto a narrow
  // one), then rows (#83: a grown title running into the line below it).
  restoreOrder(blocks, "x", sW, tW, Math.min(factor, tW / sW));
  restoreOrder(blocks, "y", sH, tH, Math.min(factor, tH / sH));

  // Guarantee: if the content still collides anywhere it did not in the
  // source (a dense slide that cannot be spread onto a narrow page), place
  // all of it as one group instead, scaled to fit and anchored like the
  // whole. That keeps the source arrangement exactly, so nothing overlaps
  // that did not overlap before; it only gives up spreading to the edges.
  if (newOverlap(free)) {
    const B = bounds(free.map((it) => it.src));
    const xPlan = inferAxis(B.x, B.w, sW);
    const yPlan = inferAxis(B.y, B.h, sH);
    const k = Math.min(blockFactor, textScale(xPlan, B.w, sW, tW, blockFactor));
    const mx = mapAxis(xPlan.anchor === "stretch" ? { ...xPlan, anchor: "start" } : xPlan, B.w, tW, k);
    const my = mapAxis(yPlan, B.h, tH, k);
    for (const m of free) {
      placeNode(m.node, mx.pos + (m.src.x - B.x) * k, my.pos + (m.src.y - B.y) * k, Math.max(1, m.src.w * k), Math.max(1, m.src.h * k), k);
    }
  }

  // Ruler guides follow their axis proportionally: an "x" guide is a vertical
  // line measured along the width, a "y" guide a horizontal line along the
  // height. Without this they would sit at the source page's pixel offsets.
  if (out.guides) {
    for (const g of out.guides) {
      g.position = g.axis === "x" ? (g.position / sW) * tW : (g.position / sH) * tH;
    }
  }

  return out;
}
