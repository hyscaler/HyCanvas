// Pose a design at an animation time: returns a deep-cloned
// DesignFile with every animated node's transform/opacity advanced to time tMs,
// composing entrance -> emphasis/custom (+ image motion) exactly like present
// mode. Pure (no canvas), so animated export can sample frames headlessly and
// the result matches on-screen playback.

import type { DesignFile, Node, NodeAnimation, ImageMotion } from "@hc/schema";
import { childrenOf } from "@hc/schema";
import {
  type AnimPatch, IDENTITY_PATCH, appliedOpacity, clipEnd,
  entrancePatch, emphasisPatch, customPatch, imageMotionPatch,
} from "./animation";

function compose(a: AnimPatch | null, b: AnimPatch): AnimPatch {
  const base = a ?? IDENTITY_PATCH;
  return {
    dx: base.dx + b.dx,
    dy: base.dy + b.dy,
    scale: base.scale * b.scale,
    rotate: base.rotate + b.rotate,
    opacityMul: base.opacityMul * b.opacityMul,
  };
}

function applyPatch(node: Node, patch: AnimPatch): void {
  const n = node as unknown as { transform: { x: number; y: number; scaleX: number; scaleY: number; rotation: number }; opacity: number };
  const t = n.transform;
  n.opacity = appliedOpacity(n.opacity, patch.opacityMul);
  n.transform = {
    ...t,
    x: t.x + patch.dx,
    y: t.y + patch.dy,
    scaleX: t.scaleX * patch.scale,
    scaleY: t.scaleY * patch.scale,
    rotation: t.rotation + patch.rotate,
  };
}

/** The total animated duration of a page in ms (max over its nodes' entrance +
 *  emphasis/custom windows), for choosing an export length. Image motion loops,
 *  so it does not extend the total. */
export function pageAnimationDuration(file: DesignFile, pageIndex = 0): number {
  const page = file.pages[pageIndex];
  if (!page) return 0;
  let total = 0;
  const visit = (nodes: Node[]): void => {
    for (const n of nodes) {
      const anim = (n as unknown as { animation?: NodeAnimation }).animation;
      if (anim) {
        const entEnd = clipEnd(anim.entrance);
        let end = entEnd;
        if (anim.emphasis) end = Math.max(end, entEnd + clipEnd(anim.emphasis));
        if (anim.custom) end = Math.max(end, entEnd + anim.custom.durationMs);
        total = Math.max(total, end);
      }
      const kids = childrenOf(n);
      if (kids.length) visit(kids);
    }
  };
  visit(page.children);
  return total;
}

/** Return a clone of `file` with page `pageIndex` posed at time `tMs`. */
export function poseDesignAt(file: DesignFile, pageIndex: number, tMs: number): DesignFile {
  const clone = structuredClone(file);
  const page = clone.pages[pageIndex];
  if (!page) return clone;
  const visit = (nodes: Node[]): void => {
    for (const n of nodes) {
      const anim = (n as unknown as { animation?: NodeAnimation }).animation;
      const motion = n.type === "image" ? (n as unknown as { motion?: ImageMotion }).motion : undefined;
      if (anim || motion) {
        let patch: AnimPatch | null = null;
        const entEnd = clipEnd(anim?.entrance);
        if (anim?.entrance && tMs <= entEnd) patch = entrancePatch(anim.entrance, tMs);
        else if (anim?.emphasis) patch = emphasisPatch(anim.emphasis, tMs - entEnd);
        else if (anim?.entrance) patch = entrancePatch(anim.entrance, entEnd);
        if (anim?.custom) patch = compose(patch, customPatch(anim.custom, tMs - entEnd));
        if (motion) patch = compose(patch, imageMotionPatch(motion, tMs));
        if (patch) applyPatch(n, patch);
      }
      const kids = childrenOf(n);
      if (kids.length) visit(kids);
    }
  };
  visit(page.children);
  return clone;
}
