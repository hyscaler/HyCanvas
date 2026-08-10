// Recompute a `boolean` node's geometry from its operands (F40 Phase 1).
//
// A boolean node carries `operands` plus an optional cached `result`. Until now
// the renderer drew `result` or, when it was absent, a placeholder box, so a
// document whose result had never been computed (authored by another client, or
// written by a tool that did not run the clipper) showed a grey rectangle where
// the artwork should be. This makes the engine able to derive the geometry
// itself, which is what retires that fallback.
//
// The space rule is the subtle part and is worth stating, because getting it
// wrong misplaces the artwork rather than failing visibly. The store creates a
// boolean node by combining shapes in PAGE space, normalizing the combined
// result so its bounds minimum sits at the origin, and putting that minimum in
// the node's own transform. The operands are then stored VERBATIM, still
// carrying the page-space transforms they had at creation. So the operands and
// the result do not share a coordinate space: reproducing `result` means
// combining the operands in their own space and then re-normalizing to the
// combination's bounds minimum, exactly as the store did. Applying the node's
// current transform here instead would double-count it.
//
// A consequence worth knowing before F41 FR-13 ("editing an operand
// re-evaluates the result") is built: because operand transforms are frozen
// page-space snapshots rather than being relative to the node, moving the
// boolean node leaves them stale. They still combine to the right SHAPE, which
// is all this function needs, but they no longer describe where that shape sits.
// Making operands editable in place requires re-expressing them relative to the
// node first.

import { booleanOp, shapeNodeToParametric, shapeToPath, type VectorPath } from "@hc/geometry";
import type { BooleanNode } from "@hc/schema";
import { applyToPoint, fromTransform } from "./math";

/** Map a path's anchors and handles through a node transform. */
function transformPath(vp: VectorPath, t: BooleanNode["operands"][number]["transform"]): VectorPath {
  const m = fromTransform(t);
  const pt = (p: { x: number; y: number }) => applyToPoint(m, p);
  return {
    fillRule: vp.fillRule,
    subpaths: vp.subpaths.map((sp) => ({
      closed: sp.closed,
      anchors: sp.anchors.map((a) => {
        const moved = pt(a);
        const out: (typeof sp.anchors)[number] = { x: moved.x, y: moved.y, corner: a.corner };
        if (a.inHandle) out.inHandle = pt(a.inHandle);
        if (a.outHandle) out.outHandle = pt(a.outHandle);
        return out;
      }),
    })),
  };
}

/**
 * The geometry a boolean node should draw, in the node's local space, derived
 * from its operands. Returns null when it cannot be derived (no operands, an
 * operand shape with no parametric form such as `custom`, or an empty clip
 * result), so the caller can keep its existing fallback for those cases rather
 * than drawing nothing.
 */
export function booleanGeometry(node: BooleanNode): VectorPath | null {
  const operands = node.operands ?? [];
  if (operands.length < 2) return null;

  const paths: VectorPath[] = [];
  for (const operand of operands) {
    const parametric = shapeNodeToParametric(operand);
    if (!parametric) return null; // a `custom` operand carries pathData, not a parametric form
    paths.push(transformPath(shapeToPath(parametric), operand.transform));
  }

  const combined = booleanOp(node.op, paths);
  if (!combined.subpaths.length) return null;

  // Re-normalize to the combination's own bounds minimum, matching how the
  // stored result was produced. Without this the geometry lands offset by the
  // node's transform.
  let minX = Infinity;
  let minY = Infinity;
  for (const sp of combined.subpaths) {
    for (const a of sp.anchors) {
      if (a.x < minX) minX = a.x;
      if (a.y < minY) minY = a.y;
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;

  return {
    fillRule: combined.fillRule,
    subpaths: combined.subpaths.map((sp) => ({
      closed: sp.closed,
      anchors: sp.anchors.map((a) => ({ ...a, x: a.x - minX, y: a.y - minY })),
    })),
  };
}
