// Derive a frame mask from a shape or path node, so "use as frame" can clip an
// image to that outline. Rect/ellipse map to the built-in mask shapes; polygons,
// stars, triangles, and custom paths serialize to an SVG `d` (the engine scales
// it to the frame box when clipping).

import { shapeNodeToParametric, shapeToPath } from "@hc/geometry";
import type { CornerRadius, Node, ShapeNode, SubPath, VectorPath } from "@hc/schema";

export interface FrameMask {
  maskShape: "rect" | "ellipse" | "custom";
  maskPath?: string;
  cornerRadius?: CornerRadius;
}

type Pt = { x: number; y: number };
type Seg = { x: number; y: number; cIn?: Pt; cOut?: Pt };

const seg = (from: Pt & { outHandle?: Pt; cOut?: Pt }, to: Pt & { inHandle?: Pt; cIn?: Pt }) => {
  const o = (from.outHandle ?? from.cOut) as Pt | undefined;
  const ih = (to.inHandle ?? to.cIn) as Pt | undefined;
  if (o || ih) {
    const c1 = o ?? from;
    const c2 = ih ?? to;
    return ` C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${to.x} ${to.y}`;
  }
  return ` L ${to.x} ${to.y}`;
};

function subPathToD(anchors: SubPath["anchors"], closed: boolean): string {
  if (!anchors.length) return "";
  let d = `M ${anchors[0].x} ${anchors[0].y}`;
  for (let i = 1; i < anchors.length; i++) d += seg(anchors[i - 1], anchors[i]);
  if (closed) {
    d += seg(anchors[anchors.length - 1], anchors[0]);
    d += " Z";
  }
  return d;
}

function vectorPathToD(vp: VectorPath): string {
  return vp.subpaths.map((s) => subPathToD(s.anchors, s.closed)).join(" ").trim();
}

function segmentsToD(segs: Seg[], closed: boolean): string {
  if (!segs.length) return "";
  let d = `M ${segs[0].x} ${segs[0].y}`;
  for (let i = 1; i < segs.length; i++) d += seg(segs[i - 1], segs[i]);
  if (closed) {
    d += seg(segs[segs.length - 1], segs[0]);
    d += " Z";
  }
  return d;
}

/** The frame mask matching a shape/path node's outline, or null if not maskable. */
export function frameMaskFor(node: Node): FrameMask | null {
  if (node.type === "shape") {
    const s = node as ShapeNode;
    if (s.shape === "rect" || s.shape === undefined) return { maskShape: "rect", cornerRadius: s.cornerRadius };
    if (s.shape === "ellipse") return { maskShape: "ellipse" };
    const param = shapeNodeToParametric(s);
    if (param) {
      const d = vectorPathToD(shapeToPath(param));
      if (d) return { maskShape: "custom", maskPath: d };
    }
    return { maskShape: "rect" };
  }
  if (node.type === "path") {
    const p = node as unknown as { segments: Seg[]; closed?: boolean };
    const d = segmentsToD(p.segments ?? [], !!p.closed);
    if (d) return { maskShape: "custom", maskPath: d };
  }
  return null;
}
