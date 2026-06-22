// Parametric shape -> VectorPath. Each shape lazily derives an
// editable path used for rendering, hit-testing, masking, and booleans.

import type { ShapeNode, SubPath, VectorAnchor, VectorPath } from "@hc/schema";
import { KAPPA, type ParametricShape } from "./types";

const DEG = Math.PI / 180;

function closed(anchors: VectorAnchor[]): VectorPath {
  return { subpaths: [{ closed: true, anchors }], fillRule: "nonzero" };
}

function roundedRect(w: number, h: number, radii: [number, number, number, number]): VectorPath {
  const maxR = Math.min(w, h) / 2;
  const [tl, tr, br, bl] = radii.map((r) => Math.max(0, Math.min(r, maxR))) as [
    number,
    number,
    number,
    number,
  ];
  if (tl === 0 && tr === 0 && br === 0 && bl === 0) {
    return closed([
      { x: 0, y: 0, corner: true },
      { x: w, y: 0, corner: true },
      { x: w, y: h, corner: true },
      { x: 0, y: h, corner: true },
    ]);
  }
  const c = (r: number) => r * KAPPA;
  const anchors: VectorAnchor[] = [
    { x: tl, y: 0, inHandle: { x: -c(tl), y: 0 } }, // P1 (after TL arc)
    { x: w - tr, y: 0, outHandle: { x: c(tr), y: 0 } }, // P2
    { x: w, y: tr, inHandle: { x: 0, y: -c(tr) } }, // P3
    { x: w, y: h - br, outHandle: { x: 0, y: c(br) } }, // P4
    { x: w - br, y: h, inHandle: { x: c(br), y: 0 } }, // P5
    { x: bl, y: h, outHandle: { x: -c(bl), y: 0 } }, // P6
    { x: 0, y: h - bl, inHandle: { x: 0, y: c(bl) } }, // P7
    { x: 0, y: tl, outHandle: { x: 0, y: -c(tl) } }, // P8 (before TL arc)
  ];
  return closed(anchors);
}

function ellipsePath(w: number, h: number): VectorPath {
  const rx = w / 2;
  const ry = h / 2;
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return closed([
    { x: w, y: ry, inHandle: { x: 0, y: -ky }, outHandle: { x: 0, y: ky } }, // right
    { x: rx, y: h, inHandle: { x: kx, y: 0 }, outHandle: { x: -kx, y: 0 } }, // bottom
    { x: 0, y: ry, inHandle: { x: 0, y: ky }, outHandle: { x: 0, y: -ky } }, // left
    { x: rx, y: 0, inHandle: { x: -kx, y: 0 }, outHandle: { x: kx, y: 0 } }, // top
  ]);
}

function regularPolygon(w: number, h: number, sides: number): VectorPath {
  const n = Math.max(3, Math.floor(sides));
  const cx = w / 2;
  const cy = h / 2;
  const anchors: VectorAnchor[] = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    anchors.push({ x: cx + Math.cos(a) * (w / 2), y: cy + Math.sin(a) * (h / 2), corner: true });
  }
  return closed(anchors);
}

function starPath(w: number, h: number, points: number, innerRatio: number): VectorPath {
  const n = Math.max(3, Math.floor(points));
  const cx = w / 2;
  const cy = h / 2;
  const inner = Math.max(0.05, Math.min(1, innerRatio));
  const anchors: VectorAnchor[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const r = i % 2 === 0 ? 1 : inner;
    anchors.push({ x: cx + Math.cos(a) * (w / 2) * r, y: cy + Math.sin(a) * (h / 2) * r, corner: true });
  }
  return closed(anchors);
}

function linePath(length: number, angleDeg: number): VectorPath {
  const a = angleDeg * DEG;
  return {
    subpaths: [
      {
        closed: false,
        anchors: [
          { x: 0, y: 0, corner: true },
          { x: Math.cos(a) * length, y: Math.sin(a) * length, corner: true },
        ],
      },
    ],
    fillRule: "nonzero",
  };
}

export function shapeToPath(shape: ParametricShape): VectorPath {
  switch (shape.kind) {
    case "rect":
      return roundedRect(shape.width, shape.height, shape.radius);
    case "ellipse":
      return ellipsePath(shape.width, shape.height);
    case "polygon":
      return regularPolygon(shape.width, shape.height, shape.sides);
    case "star":
      return starPath(shape.width, shape.height, shape.points, shape.innerRatio);
    case "line":
      return linePath(shape.length, shape.angle);
  }
}

/** Bridge the doc-02 flat ShapeNode to a ParametricShape, or null for custom/path. */
export function shapeNodeToParametric(node: ShapeNode): ParametricShape | null {
  const { width: w, height: h } = node.size;
  switch (node.shape) {
    case "rect": {
      const cr = node.cornerRadius;
      const radius: [number, number, number, number] = cr
        ? [cr.topLeft, cr.topRight, cr.bottomRight, cr.bottomLeft]
        : [0, 0, 0, 0];
      return { kind: "rect", width: w, height: h, radius };
    }
    case "ellipse":
      return { kind: "ellipse", width: w, height: h };
    case "triangle":
      return { kind: "polygon", width: w, height: h, sides: 3 };
    case "polygon":
      return { kind: "polygon", width: w, height: h, sides: node.sides ?? 5 };
    case "star":
      return { kind: "star", width: w, height: h, points: node.sides ?? 5, innerRatio: node.innerRadius ?? 0.5 };
    default:
      return null; // "custom" uses pathData
  }
}

export { type SubPath, type VectorAnchor, type VectorPath };
