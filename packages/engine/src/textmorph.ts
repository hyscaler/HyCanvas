// Word-level text morph (F28 completion C10).
//
// When Magic Move matches two TEXT nodes whose words differ, the morph can do
// better than tweening the box and snapping the content: words present on
// both sides slide from their old laid-out position to their new one, added
// words fade in, removed words fade out. Positions come from the SAME layout
// and the SAME measure the renderer itself uses, so word positions line up
// with the rendered text at both endpoints of the morph.
//
// Honest scope (documented in the capability row): word-level, not
// glyph-level; matching is greedy in-order by case-folded word text; pairs
// where either node is rotated or meaningfully scaled fall back to the
// whole-node tween; past `maxMorphWords` on either side the morph falls back
// to the classic crossfade (a paragraph rewrite is not a word dance).
//
// MEASUREMENT PARITY: the renderer lays text out with the canvas's own
// measureText, so word positions here must use the SAME measure or the words
// visibly snap at the morph's endpoints. Callers pass `measureFnFor(ctx)`;
// the approximate fallback exists only for measureText-less contexts (where
// the renderer itself falls back the same way). The start-x, auto-fit, and
// vertical-align math below mirrors render2d's line loop exactly.

import type { CharStyle, Node, TextNode } from "@hc/schema";
import { approximateMeasure, autoFitNode, layoutText, type MeasureFn } from "@hc/text";
import { canvasFontString } from "./fonts";
import type { CanvasLike } from "./types";

export interface WordBox {
  text: string;
  /** Position of the word's left baseline-top corner, in NODE-LOCAL px. */
  x: number;
  y: number;
  width: number;
  lineHeight: number;
  style: CharStyle;
}

export interface WordMorphPlan {
  moved: { from: WordBox; to: WordBox }[];
  added: WordBox[];
  removed: WordBox[];
}

/** Words per side past which a text morph degrades to the classic crossfade. */
export const maxMorphWords = 40;

/** The canvas-metrics measure the RENDERER uses, built from any context that
 *  implements measureText (mirrors render2d's construction: font string per
 *  style, letter-spacing included). Null when the context cannot measure -
 *  the renderer falls back to the approximation in that case, and so do we. */
export function measureFnFor(ctx: CanvasLike): MeasureFn | null {
  if (!ctx.measureText) return null;
  const lctx = ctx as unknown as { letterSpacing?: string };
  return (text, style) => {
    ctx.font = canvasFontString(style as Parameters<typeof canvasFontString>[0]);
    if ("letterSpacing" in (ctx as object)) lctx.letterSpacing = `${style.letterSpacing ?? 0}px`;
    return ctx.measureText!(text).width;
  };
}

/** Lay a text node out and split it into positioned words (node-local px),
 *  with the exact line origin math render2d uses (auto-fit applied, start x
 *  per alignment ignoring line.x for center/right, vertical-align shift). */
export function wordBoxes(node: TextNode, measure?: MeasureFn): WordBox[] {
  const m = measure ?? approximateMeasure;
  const opts = { measure: m };
  const fitted = autoFitNode(node, opts);
  const laid = layoutText(fitted, opts);
  const pad = (node.box.padding ?? { t: 0, r: 0, b: 0, l: 0 }) as { t: number; r: number; b: number; l: number };
  const contentW = Math.max(0, node.box.width - pad.l - pad.r);
  // Vertical alignment shift, exactly as render2d computes it.
  const vAlign = (node.box as { verticalAlign?: string }).verticalAlign ?? "top";
  let vShift = 0;
  if (vAlign !== "top" && laid.lines.length) {
    const last = laid.lines[laid.lines.length - 1];
    const used = last.y + last.height - pad.t;
    const slack = Math.max(0, node.box.height - pad.t - pad.b - used);
    vShift = vAlign === "middle" ? slack / 2 : slack;
  }
  const out: WordBox[] = [];
  for (const line of laid.lines) {
    const colLeft = pad.l + (line.colLeft ?? 0);
    const colW = line.colWidth ?? contentW;
    // Line advance re-measured with the SAME measure, matching lineAdvance
    // (tab stops are not re-derived here; morphing tabbed text is out of scope
    // and such lines simply measure their tab runs as ordinary text).
    const lineW = line.segments.reduce((acc, seg) => acc + m(seg.text, seg.style), 0);
    const align = line.align === "justify" ? "left" : line.align;
    const startX =
      line.marker || align === "left"
        ? colLeft + line.x
        : align === "center"
          ? colLeft + (colW - lineW) / 2
          : colLeft + colW - lineW;
    let x = startX;
    for (const seg of line.segments) {
      // Split the segment into word / whitespace chunks, advancing by the same
      // measure the layout used, so word x positions line up with the render.
      const parts = seg.text.split(/(\s+)/);
      for (const part of parts) {
        if (!part) continue;
        const w = m(part, seg.style);
        if (part.trim()) {
          out.push({ text: part, x, y: line.y + vShift, width: w, lineHeight: line.height, style: seg.style });
        }
        x += w;
      }
    }
  }
  return out;
}

/**
 * Plan a word morph between two text nodes, or null when it should not run:
 * identical visible words (nothing to morph), either side over the word cap,
 * or nothing matches at all (a full rewrite crossfades better than a scatter
 * of fades).
 */
export function planWordMorph(from: TextNode, to: TextNode, cap = maxMorphWords, measure?: MeasureFn): WordMorphPlan | null {
  const a = wordBoxes(from, measure);
  const b = wordBoxes(to, measure);
  if (a.length === 0 || b.length === 0) return null;
  if (a.length > cap || b.length > cap) return null;
  const key = (w: WordBox) => w.text.toLowerCase();
  if (a.length === b.length && a.every((w, i) => key(w) === key(b[i]))) return null; // same words, same order
  const consumed = new Array<boolean>(a.length).fill(false);
  const moved: WordMorphPlan["moved"] = [];
  const added: WordBox[] = [];
  // Greedy in-order: each to-word takes the FIRST unconsumed from-word with
  // the same folded text, which keeps repeated words stable and deterministic.
  let cursor = 0;
  for (const tw of b) {
    let hit = -1;
    for (let i = cursor; i < a.length; i++) {
      if (!consumed[i] && key(a[i]) === key(tw)) { hit = i; break; }
    }
    if (hit < 0) {
      for (let i = 0; i < cursor; i++) {
        if (!consumed[i] && key(a[i]) === key(tw)) { hit = i; break; }
      }
    }
    if (hit >= 0) {
      consumed[hit] = true;
      cursor = Math.max(cursor, hit + 1);
      moved.push({ from: a[hit], to: tw });
    } else {
      added.push(tw);
    }
  }
  const removed = a.filter((_, i) => !consumed[i]);
  if (moved.length === 0) return null; // full rewrite: crossfade reads better
  return { moved, added, removed };
}

/** Whether a matched text pair qualifies for a word morph: both unrotated and
 *  at (near) unit scale, so node-local word positions map to the page by a
 *  plain translate. */
export function wordMorphEligible(from: Node, to: Node): boolean {
  const ok = (n: Node) =>
    n.type === "text" &&
    (n.transform.rotation ?? 0) === 0 &&
    Math.abs(n.transform.scaleX - 1) < 0.001 &&
    Math.abs(n.transform.scaleY - 1) < 0.001;
  return ok(from) && ok(to);
}

const L = (x: number, y: number, p: number) => x + (y - x) * p;

/** Fabricate the overlay nodes for a word morph at progress `p`: one small
 *  single-run text node per word, positioned in PAGE coordinates (the nodes'
 *  own transforms already carry the page offset). Ids are derived from the
 *  destination node's id so they never collide with real nodes. */
export function wordMorphNodes(fromNode: TextNode, toNode: TextNode, plan: WordMorphPlan, p: number): Node[] {
  const fx = fromNode.transform.x;
  const fy = fromNode.transform.y;
  const tx = toNode.transform.x;
  const ty = toNode.transform.y;
  const out: Node[] = [];
  let seq = 0;
  const mk = (text: string, x: number, y: number, width: number, lineHeight: number, style: CharStyle, opacity: number): Node =>
    ({
      id: `${toNode.id}-wm-${seq++}`,
      type: "text",
      transform: { x, y, scaleX: 1, scaleY: 1, rotation: 0 },
      // Generous bounds so the word never wraps; the render draws one run.
      size: { width: width + style.fontSize, height: lineHeight },
      opacity,
      blendMode: "normal",
      box: { mode: "fixed", width: width + style.fontSize, height: lineHeight },
      content: [{ runs: [{ text, style }], style: { align: "left" } }],
    }) as unknown as Node;
  for (const m of plan.moved) {
    out.push(mk(
      m.to.text,
      L(fx + m.from.x, tx + m.to.x, p),
      L(fy + m.from.y, ty + m.to.y, p),
      Math.max(m.from.width, m.to.width),
      Math.max(m.from.lineHeight, m.to.lineHeight),
      p < 0.5 ? m.from.style : m.to.style,
      1,
    ));
  }
  for (const w of plan.removed) {
    out.push(mk(w.text, fx + w.x, fy + w.y, w.width, w.lineHeight, w.style, Math.max(0, 1 - p * 2)));
  }
  for (const w of plan.added) {
    out.push(mk(w.text, tx + w.x, ty + w.y, w.width, w.lineHeight, w.style, Math.min(1, Math.max(0, p * 2 - 1))));
  }
  return out;
}
