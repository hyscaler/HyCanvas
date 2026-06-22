import { describe, it, expect } from "vitest";
import { layoutFlowchart, layoutMindMap } from "../layout";

describe("layoutFlowchart", () => {
  it("layers a simple DAG by longest path", () => {
    // a -> b -> c, a -> c. c should be deeper than b.
    const pos = layoutFlowchart(
      { nodes: ["a", "b", "c"], edges: [["a", "b"], ["b", "c"], ["a", "c"]] },
      { direction: "down", layerGap: 100 },
    );
    expect(pos.a.y).toBeLessThan(pos.b.y);
    expect(pos.b.y).toBeLessThan(pos.c.y);
    // a is a source at layer 0
    expect(pos.a.y).toBe(0);
    // c is at layer 2 (longest path a->b->c)
    expect(pos.c.y).toBe(200);
  });

  it("respects direction=right (layers grow along x)", () => {
    const pos = layoutFlowchart(
      { nodes: ["a", "b"], edges: [["a", "b"]] },
      { direction: "right", layerGap: 120 },
    );
    expect(pos.a.x).toBe(0);
    expect(pos.b.x).toBe(120);
    expect(pos.a.y).toBe(pos.b.y);
  });

  it("terminates and produces positions for a cyclic graph", () => {
    const pos = layoutFlowchart({
      nodes: ["a", "b", "c"],
      edges: [["a", "b"], ["b", "c"], ["c", "a"]],
    });
    expect(Object.keys(pos).sort()).toEqual(["a", "b", "c"]);
    // the back-edge c->a is broken, so a..c are laid out across layers
    expect(pos.a.y).toBeLessThan(pos.c.y);
  });

  it("places multiple nodes in a layer spread across the within-layer axis", () => {
    const pos = layoutFlowchart(
      { nodes: ["root", "x", "y"], edges: [["root", "x"], ["root", "y"]] },
      { direction: "down", nodeGap: 100 },
    );
    expect(pos.x.y).toBe(pos.y.y); // same layer
    expect(pos.x.x).not.toBe(pos.y.x); // different positions
    expect(Math.abs(pos.x.x - pos.y.x)).toBe(100);
  });

  it("handles an empty graph", () => {
    expect(layoutFlowchart({ nodes: [], edges: [] })).toEqual({});
  });

  it("ignores edges referencing unknown nodes and self-loops", () => {
    const pos = layoutFlowchart({
      nodes: ["a", "b"],
      edges: [["a", "b"], ["a", "a"], ["a", "ghost"]],
    });
    expect(pos.a.y).toBeLessThan(pos.b.y);
  });
});

describe("layoutMindMap", () => {
  it("places root at the origin", () => {
    const pos = layoutMindMap("r", { nodes: ["r", "a"], edges: [["r", "a"]] });
    expect(pos.r).toEqual({ x: 0, y: 0 });
  });

  it("places level-N nodes on a circle of radius N*radiusStep", () => {
    const pos = layoutMindMap(
      "r",
      { nodes: ["r", "a", "b"], edges: [["r", "a"], ["a", "b"]] },
      { radiusStep: 100 },
    );
    const ra = Math.hypot(pos.a.x, pos.a.y);
    const rb = Math.hypot(pos.b.x, pos.b.y);
    expect(ra).toBeCloseTo(100, 6);
    expect(rb).toBeCloseTo(200, 6);
  });

  it("distributes siblings around the circle at the same radius", () => {
    const pos = layoutMindMap(
      "r",
      { nodes: ["r", "a", "b", "c"], edges: [["r", "a"], ["r", "b"], ["r", "c"]] },
      { radiusStep: 150 },
    );
    for (const id of ["a", "b", "c"]) {
      expect(Math.hypot(pos[id].x, pos[id].y)).toBeCloseTo(150, 6);
    }
    // distinct angular positions
    const xs = new Set([pos.a.x.toFixed(3), pos.b.x.toFixed(3), pos.c.x.toFixed(3)]);
    expect(xs.size).toBeGreaterThan(1);
  });

  it("returns empty when root is not in the graph", () => {
    expect(layoutMindMap("missing", { nodes: ["a"], edges: [] })).toEqual({});
  });
});
