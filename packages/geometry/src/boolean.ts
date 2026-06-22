// Boolean path operations. Curves are flattened to polygons, run
// through a robust polygon clipper, and returned as a polyline VectorPath.
// Refitting results back to beziers is a later enhancement.

import polygonClipping from "polygon-clipping";
import type { VectorPath } from "@hc/schema";
import { pathToPolylines } from "./flatten";

export type BooleanOp = "union" | "subtract" | "intersect" | "exclude";

type XY = [number, number];
type Ring = XY[];
type Poly = Ring[];
type MultiPoly = Poly[];

// Each subpath becomes its own single-ring polygon, so multiple subpaths are
// treated as disjoint shapes (the common case for boolean operands) rather than
// outer+holes. Reconstructing true holes from boolean results reused as operands
// needs ring-nesting analysis and is deferred.
function pathToMultiPoly(path: VectorPath): MultiPoly {
  return pathToPolylines(path).map((poly) => [poly.map((p) => [p.x, p.y] as XY)]);
}

function multiPolyToPath(mp: MultiPoly): VectorPath {
  const subpaths = [];
  for (const poly of mp) {
    for (const ring of poly) {
      subpaths.push({ closed: true, anchors: ring.map(([x, y]) => ({ x, y, corner: true })) });
    }
  }
  return { subpaths, fillRule: "nonzero" };
}

export function booleanOp(op: BooleanOp, paths: VectorPath[]): VectorPath {
  if (paths.length === 0) return { subpaths: [], fillRule: "nonzero" };
  const [first, ...rest] = paths.map(pathToMultiPoly);
  // polygon-clipping types are loose; cast the result to our MultiPoly shape.
  const pc = polygonClipping as unknown as Record<string, (...a: MultiPoly[]) => MultiPoly>;
  let result: MultiPoly;
  switch (op) {
    case "union":
      result = pc.union(first, ...rest);
      break;
    case "intersect":
      result = pc.intersection(first, ...rest);
      break;
    case "subtract":
      result = pc.difference(first, ...rest);
      break;
    case "exclude":
      result = pc.xor(first, ...rest);
      break;
  }
  return multiPolyToPath(result);
}
