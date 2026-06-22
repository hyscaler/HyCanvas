import { describe, it, expect } from "vitest";
import type { VectorPath } from "@hc/schema";
import { strokeToOutline, recognizeShape, type Point } from "../index";

function line(ax: number, ay: number, bx: number, by: number): VectorPath {
  return { subpaths: [{ closed: false, anchors: [{ x: ax, y: ay }, { x: bx, y: by }] }], fillRule: "nonzero" };
}

describe("strokeToOutline", () => {
  it("thickens a line into a filled region", () => {
    const out = strokeToOutline(line(0, 0, 100, 0), 10);
    expect(out.subpaths.length).toBeGreaterThan(0);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const sp of out.subpaths) for (const a of sp.anchors) {
      minX = Math.min(minX, a.x); maxX = Math.max(maxX, a.x);
      minY = Math.min(minY, a.y); maxY = Math.max(maxY, a.y);
    }
    // ~100 long, ~10 tall (plus the round caps), centered on y=0.
    expect(maxX - minX).toBeGreaterThan(95);
    expect(maxY - minY).toBeGreaterThan(8);
    expect(maxY - minY).toBeLessThan(20);
  });

  it("returns empty for an empty path", () => {
    expect(strokeToOutline({ subpaths: [], fillRule: "nonzero" }, 5).subpaths.length).toBe(0);
  });
});

function rectPts(w: number, h: number): Point[] {
  const pts: Point[] = [];
  for (let x = 0; x <= w; x += w / 10) pts.push({ x, y: 0 });
  for (let y = 0; y <= h; y += h / 10) pts.push({ x: w, y });
  for (let x = w; x >= 0; x -= w / 10) pts.push({ x, y: h });
  for (let y = h; y >= 0; y -= h / 10) pts.push({ x: 0, y });
  return pts;
}
function circlePts(r: number): Point[] {
  return Array.from({ length: 40 }, (_, i) => {
    const a = (i / 40) * Math.PI * 2;
    return { x: r + r * Math.cos(a), y: r + r * Math.sin(a) };
  }).concat([{ x: 2 * r, y: r }]);
}

describe("recognizeShape", () => {
  it("recognizes a straight line", () => {
    const r = recognizeShape([{ x: 0, y: 0 }, { x: 50, y: 25 }, { x: 100, y: 50 }]);
    expect(r?.kind).toBe("line");
  });
  it("recognizes a rectangle", () => {
    const r = recognizeShape(rectPts(120, 80));
    expect(r?.kind).toBe("rect");
  });
  it("recognizes a triangle", () => {
    const r = recognizeShape([{ x: 50, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 50, y: 0 }]);
    expect(r?.kind).toBe("triangle");
  });
  it("recognizes an ellipse", () => {
    const r = recognizeShape(circlePts(50));
    expect(r?.kind).toBe("ellipse");
  });
  it("returns null for too-few points", () => {
    expect(recognizeShape([{ x: 0, y: 0 }])).toBeNull();
  });
});
