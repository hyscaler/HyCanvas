import { describe, it, expect } from "vitest";
import { SpatialIndex } from "../spatial";

describe("SpatialIndex (FR-27)", () => {
  it("returns only rects intersecting the query, across cell boundaries", () => {
    const idx = new SpatialIndex(100);
    idx.insert("a", { x: 0, y: 0, width: 50, height: 50 });
    idx.insert("b", { x: 1000, y: 1000, width: 50, height: 50 });
    idx.insert("c", { x: 90, y: 90, width: 40, height: 40 }); // straddles cell (0,0)/(1,1)
    expect(idx.queryRect({ x: 10, y: 10, width: 20, height: 20 }).sort()).toEqual(["a"]);
    // A query overlapping c's cells but not c's AABB excludes it (precise filter).
    expect(idx.queryRect({ x: 0, y: 95, width: 20, height: 20 })).toEqual([]);
    expect(idx.queryRect({ x: 95, y: 95, width: 10, height: 10 })).toEqual(["c"]);
    expect(idx.queryRect({ x: 990, y: 990, width: 100, height: 100 })).toEqual(["b"]);
  });

  it("dedupes a rect spanning many cells and supports remove", () => {
    const idx = new SpatialIndex(50);
    idx.insert("big", { x: 0, y: 0, width: 500, height: 500 }); // spans 100 cells
    expect(idx.queryRect({ x: 10, y: 10, width: 480, height: 480 })).toEqual(["big"]);
    expect(idx.size).toBe(1);
    idx.remove("big");
    expect(idx.size).toBe(0);
    expect(idx.queryRect({ x: 10, y: 10, width: 480, height: 480 })).toEqual([]);
  });

  it("re-inserting an id replaces its prior rect (no stale buckets)", () => {
    const idx = new SpatialIndex(100);
    idx.insert("x", { x: 0, y: 0, width: 10, height: 10 });
    idx.insert("x", { x: 500, y: 500, width: 10, height: 10 });
    expect(idx.queryRect({ x: 0, y: 0, width: 20, height: 20 })).toEqual([]);
    expect(idx.queryRect({ x: 495, y: 495, width: 20, height: 20 })).toEqual(["x"]);
  });
});
