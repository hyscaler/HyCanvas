import { describe, it, expect } from "vitest";
import { extractRefs, buildDependencyGraph, recompute } from "../graph";
import { cellKey } from "../refs";
import { isError, CellValue } from "../functions";

describe("extractRefs", () => {
  it("extracts single refs", () => {
    expect(extractRefs("=A1+B2").sort()).toEqual(["A1", "B2"]);
  });
  it("expands ranges", () => {
    expect(extractRefs("=SUM(A1:A3)").sort()).toEqual(["A1", "A2", "A3"]);
  });
  it("absolute refs normalize to canonical keys", () => {
    expect(extractRefs("=$A$1+$B2")).toContain("A1");
    expect(extractRefs("=$A$1+$B2")).toContain("B2");
  });
});

describe("buildDependencyGraph", () => {
  it("records dependents and precedents", () => {
    const cells = new Map<string, string>([
      ["B1", "=A1+1"],
      ["C1", "=B1*2"],
    ]);
    const g = buildDependencyGraph(cells);
    expect([...(g.dependents.get("A1") ?? [])]).toEqual(["B1"]);
    expect([...(g.dependents.get("B1") ?? [])]).toEqual(["C1"]);
    expect([...(g.precedents.get("C1") ?? [])]).toEqual(["B1"]);
  });
});

// literal resolver factory
function literalResolver(literals: Record<string, CellValue>) {
  return (col: number, row: number): CellValue => {
    const key = cellKey(col, row);
    return key in literals ? literals[key] : null;
  };
}

describe("recompute", () => {
  it("recomputes only dependents of changed keys", () => {
    const cells = new Map<string, string>([
      ["B1", "=A1+1"],
      ["C1", "=B1*2"],
      ["D1", "=Z1+1"], // independent
    ]);
    const literals = { A1: 10 as CellValue, Z1: 100 as CellValue };
    // A1 changed: B1 and C1 should recompute; D1 should NOT be in the result
    const res = recompute(cells, ["A1"], literalResolver(literals));
    expect(res.get("B1")).toBe(11);
    expect(res.get("C1")).toBe(22);
    expect(res.has("D1")).toBe(false);
  });

  it("full chain recompute", () => {
    const cells = new Map<string, string>([
      ["A2", "=A1*2"],
      ["A3", "=A2*2"],
      ["A4", "=A3*2"],
    ]);
    const res = recompute(cells, ["A1"], literalResolver({ A1: 1 }));
    expect(res.get("A2")).toBe(2);
    expect(res.get("A3")).toBe(4);
    expect(res.get("A4")).toBe(8);
  });

  it("a changed formula cell recomputes itself", () => {
    const cells = new Map<string, string>([["B1", "=A1+5"]]);
    const res = recompute(cells, ["B1"], literalResolver({ A1: 10 }));
    expect(res.get("B1")).toBe(15);
  });

  it("detects a direct cycle -> #CIRCULAR! for all in cycle", () => {
    const cells = new Map<string, string>([
      ["A1", "=B1"],
      ["B1", "=A1"],
    ]);
    const res = recompute(cells, ["A1"], literalResolver({}));
    const a = res.get("A1");
    const b = res.get("B1");
    expect(isError(a) && a.error).toBe("#CIRCULAR!");
    expect(isError(b) && b.error).toBe("#CIRCULAR!");
  });

  it("detects a longer cycle and poisons downstream cells", () => {
    const cells = new Map<string, string>([
      ["A1", "=C1"],
      ["B1", "=A1"],
      ["C1", "=B1"],
      ["D1", "=A1+1"], // depends on a cyclic cell -> poisoned
    ]);
    const res = recompute(cells, ["A1"], literalResolver({}));
    for (const k of ["A1", "B1", "C1", "D1"]) {
      const v = res.get(k);
      expect(isError(v) && v.error).toBe("#CIRCULAR!");
    }
  });

  it("non-cyclic cells still compute when a separate cycle exists", () => {
    const cells = new Map<string, string>([
      ["A1", "=B1"],
      ["B1", "=A1"], // cycle
      ["X1", "=Y1+1"], // healthy
    ]);
    const res = recompute(
      cells,
      ["A1", "Y1"],
      literalResolver({ Y1: 41 })
    );
    expect(res.get("X1")).toBe(42);
  });
});
