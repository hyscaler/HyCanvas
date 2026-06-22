import { describe, it, expect } from "vitest";
import { resolveBinding } from "../binding";
import { createGrid, setCell, type Grid } from "../model";
import type { ChartBinding } from "../model";

// Grid for binding:
//        B1=Q1  C1=Q2
//   A2=North B2=10 C2=20
//   A3=South B3=30 C3=40
function buildGrid(): Grid {
  let g = createGrid("g", "S");
  const data: [string, string | number][] = [
    ["A1", ""], ["B1", "Q1"], ["C1", "Q2"],
    ["A2", "North"], ["B2", 10], ["C2", 20],
    ["A3", "South"], ["B3", 30], ["C3", 40],
  ];
  for (const [k, v] of data) g = setCell(g, k, { v });
  return g;
}

describe("resolveBinding", () => {
  it("columns orientation: series per column, categories from first column", () => {
    const binding: ChartBinding = {
      id: "b",
      chartId: "c",
      gridId: "g",
      range: "A1:C3",
      orientation: "columns",
    };
    const res = resolveBinding(buildGrid(), binding);
    expect(res.categories).toEqual(["North", "South"]);
    expect(res.series).toEqual([
      { name: "Q1", values: [10, 30] },
      { name: "Q2", values: [20, 40] },
    ]);
  });

  it("rows orientation: series per row, categories from first row", () => {
    const binding: ChartBinding = {
      id: "b",
      chartId: "c",
      gridId: "g",
      range: "A1:C3",
      orientation: "rows",
    };
    const res = resolveBinding(buildGrid(), binding);
    expect(res.categories).toEqual(["Q1", "Q2"]);
    expect(res.series).toEqual([
      { name: "North", values: [10, 20] },
      { name: "South", values: [30, 40] },
    ]);
  });

  it("uses computed values for formula cells", () => {
    let g = buildGrid();
    g = setCell(g, "B2", { f: "=5+5" });
    const binding: ChartBinding = {
      id: "b",
      chartId: "c",
      gridId: "g",
      range: "A1:C3",
      orientation: "columns",
    };
    const res = resolveBinding(g, binding, { B2: 10 });
    expect(res.series[0].values[0]).toBe(10);
  });

  it("coerces non-numeric cells to 0 in series values", () => {
    let g = buildGrid();
    g = setCell(g, "B2", { v: "n/a" });
    const binding: ChartBinding = {
      id: "b",
      chartId: "c",
      gridId: "g",
      range: "A1:C3",
      orientation: "columns",
    };
    const res = resolveBinding(g, binding);
    expect(res.series[0].values[0]).toBe(0);
  });
});
