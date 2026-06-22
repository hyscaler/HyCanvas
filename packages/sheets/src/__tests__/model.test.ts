import { describe, it, expect } from "vitest";
import {
  createGrid,
  getCell,
  setCell,
  cellDisplayValue,
  type Grid,
} from "../model";

describe("model", () => {
  it("createGrid produces an empty grid", () => {
    const g = createGrid("g1", "Sheet 1");
    expect(g.id).toBe("g1");
    expect(g.cells).toEqual({});
    expect(g.rows).toBe(100);
    expect(g.cols).toBe(26);
  });

  it("setCell is immutable and getCell reads back", () => {
    const g0 = createGrid("g1", "S");
    const g1 = setCell(g0, "A1", { v: 5 });
    expect(g0.cells).toEqual({}); // original untouched
    expect(getCell(g1, "A1")).toEqual({ v: 5 });
    expect(getCell(g1, "B2")).toBeUndefined();
  });

  it("setCell with undefined clears a cell", () => {
    const g1 = setCell(createGrid("g", "S"), "A1", { v: 5 });
    const g2 = setCell(g1, "A1", undefined);
    expect(getCell(g2, "A1")).toBeUndefined();
    expect(getCell(g1, "A1")).toEqual({ v: 5 }); // immutability
  });

  it("cellDisplayValue prefers computed for formula cells", () => {
    expect(cellDisplayValue({ f: "=A1+1", v: 99 }, 42)).toBe(42);
    expect(cellDisplayValue({ v: 7 })).toBe(7);
    expect(cellDisplayValue(undefined)).toBe(null);
    expect(cellDisplayValue({ f: "=A1" })).toBe(null);
  });
});
