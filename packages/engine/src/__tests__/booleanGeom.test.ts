// F40 Phase 1: the engine derives a boolean node's geometry from its operands.
//
// The point of these is the SPACE rule. The store combines operands in page
// space, normalizes the result to its own bounds minimum, and puts that minimum
// in the node's transform, while storing the operands unchanged. So a
// recomputation that forgets to re-normalize, or that applies the node's
// transform on top, produces geometry that is the right shape in the wrong
// place, which renders as artwork that has silently drifted rather than as an
// obvious failure.

import { describe, expect, it } from "vitest";
import { booleanGeometry } from "../booleanGeom";
import type { BooleanNode, ShapeNode } from "@hc/schema";

function rect(id: string, x: number, y: number, w: number, h: number): ShapeNode {
  return {
    id,
    type: "shape",
    name: id,
    shape: "rect",
    transform: { x, y, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: w, height: h },
    fills: [{ type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } }],
  } as unknown as ShapeNode;
}

function boolNode(op: BooleanNode["op"], operands: ShapeNode[]): BooleanNode {
  return {
    id: "b1",
    type: "boolean",
    name: "bool",
    op,
    operands,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 1, height: 1 },
  } as unknown as BooleanNode;
}

function boundsOf(vp: NonNullable<ReturnType<typeof booleanGeometry>>) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const sp of vp.subpaths) {
    for (const a of sp.anchors) {
      minX = Math.min(minX, a.x); minY = Math.min(minY, a.y);
      maxX = Math.max(maxX, a.x); maxY = Math.max(maxY, a.y);
    }
  }
  return { minX, minY, maxX, maxY };
}

describe("booleanGeometry", () => {
  it("unions two overlapping rects into one normalized region", () => {
    // (10,10)-(60,60) and (40,40)-(90,90): union spans 80x80 from (10,10).
    const g = booleanGeometry(boolNode("union", [rect("a", 10, 10, 50, 50), rect("b", 40, 40, 50, 50)]));
    expect(g).not.toBeNull();
    const b = boundsOf(g!);
    // Normalized: the geometry starts at the origin, NOT at the page position.
    expect(b.minX).toBeCloseTo(0, 6);
    expect(b.minY).toBeCloseTo(0, 6);
    expect(b.maxX).toBeCloseTo(80, 6);
    expect(b.maxY).toBeCloseTo(80, 6);
  });

  it("respects each operand's own transform", () => {
    // Moving one operand changes the combined extent, which proves the operand
    // transform is being applied rather than every shape being read at origin.
    const near = booleanGeometry(boolNode("union", [rect("a", 0, 0, 50, 50), rect("b", 25, 0, 50, 50)]));
    const far = booleanGeometry(boolNode("union", [rect("a", 0, 0, 50, 50), rect("b", 200, 0, 50, 50)]));
    expect(boundsOf(near!).maxX).toBeCloseTo(75, 6);
    expect(boundsOf(far!).maxX).toBeCloseTo(250, 6);
  });

  it("intersects to the overlap only", () => {
    const g = booleanGeometry(boolNode("intersect", [rect("a", 0, 0, 50, 50), rect("b", 30, 30, 50, 50)]));
    expect(g).not.toBeNull();
    const b = boundsOf(g!);
    expect(b.maxX - b.minX).toBeCloseTo(20, 6);
    expect(b.maxY - b.minY).toBeCloseTo(20, 6);
  });

  it("returns null rather than guessing when the shapes do not intersect", () => {
    // An empty clip result must not become an empty path the caller draws as
    // nothing; the caller keeps its own fallback for this.
    expect(booleanGeometry(boolNode("intersect", [rect("a", 0, 0, 10, 10), rect("b", 500, 500, 10, 10)]))).toBeNull();
  });

  it("returns null for fewer than two operands and for non-parametric shapes", () => {
    expect(booleanGeometry(boolNode("union", [rect("a", 0, 0, 10, 10)]))).toBeNull();
    const custom = { ...rect("c", 0, 0, 10, 10), shape: "custom", pathData: "M0 0 L10 10" } as unknown as ShapeNode;
    expect(booleanGeometry(boolNode("union", [rect("a", 0, 0, 10, 10), custom]))).toBeNull();
  });

  it("is independent of the node's own transform", () => {
    // The node transform positions the artwork; it must not also be folded into
    // the geometry, or a moved boolean node would drift by twice its offset.
    const operands = [rect("a", 10, 10, 50, 50), rect("b", 40, 40, 50, 50)];
    const atOrigin = booleanGeometry(boolNode("union", operands));
    const moved = boolNode("union", operands);
    (moved as { transform: { x: number; y: number } }).transform = { x: 500, y: 300, scaleX: 1, scaleY: 1, rotation: 0 } as never;
    expect(boundsOf(booleanGeometry(moved)!)).toEqual(boundsOf(atOrigin!));
  });
});
