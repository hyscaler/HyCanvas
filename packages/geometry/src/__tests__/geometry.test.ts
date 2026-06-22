import { describe, it, expect } from "vitest";
import { createNode, type ShapeNode, type VectorPath } from "@hc/schema";
import {
  booleanOp,
  bounds,
  pointInPath,
  routeConnector,
  shapeNodeToParametric,
  shapeToPath,
} from "../index";

function rectPath(x: number, y: number, w: number, h: number): VectorPath {
  return {
    subpaths: [
      {
        closed: true,
        anchors: [
          { x, y, corner: true },
          { x: x + w, y, corner: true },
          { x: x + w, y: y + h, corner: true },
          { x, y: y + h, corner: true },
        ],
      },
    ],
    fillRule: "nonzero",
  };
}

describe("shapeToPath (FR-2)", () => {
  it("produces the expected anchor structure per shape", () => {
    expect(shapeToPath({ kind: "rect", width: 100, height: 60, radius: [0, 0, 0, 0] }).subpaths[0].anchors).toHaveLength(4);
    expect(shapeToPath({ kind: "rect", width: 100, height: 60, radius: [8, 8, 8, 8] }).subpaths[0].anchors).toHaveLength(8);
    expect(shapeToPath({ kind: "ellipse", width: 100, height: 60 }).subpaths[0].anchors).toHaveLength(4);
    expect(shapeToPath({ kind: "polygon", width: 100, height: 100, sides: 6 }).subpaths[0].anchors).toHaveLength(6);
    expect(shapeToPath({ kind: "star", width: 100, height: 100, points: 5, innerRatio: 0.5 }).subpaths[0].anchors).toHaveLength(10);
    const line = shapeToPath({ kind: "line", length: 50, angle: 0 });
    expect(line.subpaths[0].closed).toBe(false);
    expect(line.subpaths[0].anchors).toHaveLength(2);
  });

  it("ellipse bounds match its box within flattening tolerance", () => {
    const b = bounds(shapeToPath({ kind: "ellipse", width: 100, height: 60 }));
    expect(b.x).toBeCloseTo(0, 1);
    expect(b.width).toBeCloseTo(100, 1);
    expect(b.height).toBeCloseTo(60, 1);
  });

  it("bridges the doc-02 ShapeNode to a ParametricShape", () => {
    const node = createNode("shape", { id: "s", shape: "ellipse", size: { width: 40, height: 20 } } as Partial<ShapeNode>) as ShapeNode;
    expect(shapeNodeToParametric(node)).toEqual({ kind: "ellipse", width: 40, height: 20 });
    const tri = createNode("shape", { id: "t", shape: "triangle", size: { width: 30, height: 30 } } as Partial<ShapeNode>) as ShapeNode;
    expect(shapeNodeToParametric(tri)).toEqual({ kind: "polygon", width: 30, height: 30, sides: 3 });
    const custom = createNode("shape", { id: "c", shape: "custom" } as Partial<ShapeNode>) as ShapeNode;
    expect(shapeNodeToParametric(custom)).toBeNull();
  });
});

describe("point-in-path (FR-15 hit-testing)", () => {
  it("tests a rectangle", () => {
    const r = rectPath(0, 0, 100, 100);
    expect(pointInPath(r, { x: 50, y: 50 })).toBe(true);
    expect(pointInPath(r, { x: 150, y: 50 })).toBe(false);
  });
  it("tests an ellipse (corner is outside)", () => {
    const e = shapeToPath({ kind: "ellipse", width: 100, height: 100 });
    expect(pointInPath(e, { x: 50, y: 50 })).toBe(true);
    expect(pointInPath(e, { x: 3, y: 3 })).toBe(false);
  });
});

describe("boolean operations (FR-14)", () => {
  const a = rectPath(0, 0, 100, 100);
  const b = rectPath(50, 0, 100, 100);

  it("union spans both operands", () => {
    const u = bounds(booleanOp("union", [a, b]));
    expect(u.x).toBeCloseTo(0, 6);
    expect(u.width).toBeCloseTo(150, 6);
  });
  it("intersect is the overlap", () => {
    const i = bounds(booleanOp("intersect", [a, b]));
    expect(i.x).toBeCloseTo(50, 6);
    expect(i.width).toBeCloseTo(50, 6);
  });
  it("subtract removes the overlap from the first", () => {
    const s = bounds(booleanOp("subtract", [a, b]));
    expect(s.x).toBeCloseTo(0, 6);
    expect(s.width).toBeCloseTo(50, 6); // 0..50 remains
  });
  it("exclude (xor) spans both", () => {
    const x = booleanOp("exclude", [a, b]);
    expect(x.subpaths.length).toBeGreaterThan(0);
  });

  it("treats disjoint subpaths in one operand as separate filled shapes (not holes)", () => {
    const disjoint: VectorPath = {
      fillRule: "nonzero",
      subpaths: [...rectPath(0, 0, 40, 40).subpaths, ...rectPath(100, 0, 40, 40).subpaths],
    };
    const u = booleanOp("union", [disjoint]);
    // The second rect must remain filled (it would read as empty if mis-encoded as a hole).
    expect(pointInPath(u, { x: 120, y: 20 })).toBe(true);
    expect(pointInPath(u, { x: 20, y: 20 })).toBe(true);
    expect(pointInPath(u, { x: 70, y: 20 })).toBe(false); // the gap between them
  });
});

describe("connector routing (FR-4)", () => {
  const s = { x: 0, y: 0 };
  const e = { x: 100, y: 80 };
  it("straight has two anchors", () => {
    expect(routeConnector(s, e, "straight").subpaths[0].anchors).toHaveLength(2);
  });
  it("elbow is orthogonal with four anchors", () => {
    const r = routeConnector(s, e, "elbow");
    expect(r.subpaths[0].anchors).toHaveLength(4);
    expect(r.subpaths[0].anchors[1].y).toBe(s.y); // first leg horizontal
  });
  it("curved carries bezier handles", () => {
    const r = routeConnector(s, e, "curved");
    expect(r.subpaths[0].anchors[0].outHandle).toBeDefined();
    expect(r.subpaths[0].anchors[1].inHandle).toBeDefined();
  });
  it("a vertical curved connector still bows (handle is non-zero)", () => {
    const r = routeConnector({ x: 0, y: 0 }, { x: 0, y: 100 }, "curved");
    expect(r.subpaths[0].anchors[0].outHandle?.x).not.toBe(0);
  });
});
