import { describe, it, expect } from "vitest";
import { createBlankDesign, createNode, type Node } from "@hc/schema";
import { siblingAABBs, worldAABB } from "../tree";

const shape = (x: number, y: number, w: number, h: number, rotation = 0): Node =>
  createNode("shape", { shape: "rect", transform: { x, y, scaleX: 1, scaleY: 1, rotation }, size: { width: w, height: h } } as unknown as Partial<Node>);

describe("siblingAABBs", () => {
  it("matches worldAABB for a page's own children, rotated ones included", () => {
    const file = createBlankDesign({ title: "t", width: 1000, height: 800 });
    const kids = [shape(10, 20, 100, 50), shape(300, 200, 80, 40, 30), shape(500, 600, 20, 20, 90)];
    file.pages[0].children = kids;
    const boxes = siblingAABBs(file, kids, null);
    expect(boxes).toHaveLength(3);
    kids.forEach((k, i) => {
      const w = worldAABB(file, k.id)!;
      expect(boxes[i].x).toBeCloseTo(w.x, 6);
      expect(boxes[i].y).toBeCloseTo(w.y, 6);
      expect(boxes[i].width).toBeCloseTo(w.width, 6);
      expect(boxes[i].height).toBeCloseTo(w.height, 6);
    });
  });

  it("matches worldAABB for the children of a moved, scaled, rotated group", () => {
    const file = createBlankDesign({ title: "t", width: 1000, height: 800 });
    const inner = [shape(5, 5, 40, 30), shape(60, 10, 20, 20, 45)];
    const group = createNode("group", {
      transform: { x: 200, y: 100, scaleX: 1.5, scaleY: 0.5, rotation: 20 },
      size: { width: 100, height: 60 },
      children: inner,
    } as unknown as Partial<Node>);
    file.pages[0].children = [group];
    const boxes = siblingAABBs(file, inner, group);
    inner.forEach((k, i) => {
      const w = worldAABB(file, k.id)!;
      expect(boxes[i].x).toBeCloseTo(w.x, 6);
      expect(boxes[i].y).toBeCloseTo(w.y, 6);
      expect(boxes[i].width).toBeCloseTo(w.width, 6);
      expect(boxes[i].height).toBeCloseTo(w.height, 6);
    });
  });
});
