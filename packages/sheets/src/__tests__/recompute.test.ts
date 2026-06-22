import { describe, it, expect } from "vitest";
import { recomputeGrid, recomputeChanged, isError } from "../recompute";
import { createGrid, setCell, type Grid } from "../model";

function build(cells: Record<string, { v?: number | string | boolean; f?: string }>): Grid {
  let g = createGrid("g", "S");
  for (const [k, c] of Object.entries(cells)) g = setCell(g, k, c);
  return g;
}

describe("recomputeGrid", () => {
  it("computes formula cells over literals", () => {
    const g = build({
      A1: { v: 10 },
      A2: { v: 20 },
      A3: { f: "=SUM(A1:A2)" },
      B1: { f: "=A3*2" },
    });
    const res = recomputeGrid(g);
    expect(res["A3"]).toBe(30);
    expect(res["B1"]).toBe(60);
  });

  it("returns empty map when no formula cells", () => {
    const g = build({ A1: { v: 1 }, A2: { v: 2 } });
    expect(recomputeGrid(g)).toEqual({});
  });

  it("surfaces circular references as #CIRCULAR!", () => {
    const g = build({ A1: { f: "=B1" }, B1: { f: "=A1" } });
    const res = recomputeGrid(g);
    expect(isError(res["A1"]) && (res["A1"] as any).error).toBe("#CIRCULAR!");
    expect(isError(res["B1"]) && (res["B1"] as any).error).toBe("#CIRCULAR!");
  });

  it("recomputeChanged only touches dependents", () => {
    const g = build({
      A1: { v: 1 },
      B1: { f: "=A1+1" },
      C1: { f: "=Z1+1" }, // independent of A1
    });
    const res = recomputeChanged(g, ["A1"]);
    expect(res["B1"]).toBe(2);
    expect("C1" in res).toBe(false);
  });
});
