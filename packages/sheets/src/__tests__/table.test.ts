import { describe, it, expect } from "vitest";
import { applyTableView } from "../table";
import { createGrid, setCell, type Grid } from "../model";
import type { DataTable } from "../model";

// Build a grid:
//   A1=Name B1=Score
//   A2=Bob  B2=30
//   A3=Amy  B3=90
//   A4=Cal  B4=60
function buildGrid(): Grid {
  let g = createGrid("g", "S");
  const data: [string, string | number][] = [
    ["A1", "Name"], ["B1", "Score"],
    ["A2", "Bob"], ["B2", 30],
    ["A3", "Amy"], ["B3", 90],
    ["A4", "Cal"], ["B4", 60],
  ];
  for (const [k, v] of data) g = setCell(g, k, { v });
  return g;
}

const baseTable: DataTable = {
  id: "t1",
  range: "A1:B4",
  headerRow: true,
  columns: [
    { name: "Name", type: "string" },
    { name: "Score", type: "number" },
  ],
};

describe("applyTableView", () => {
  it("drops the header row", () => {
    const { rows } = applyTableView(buildGrid(), baseTable);
    expect(rows.length).toBe(3);
    expect(rows[0]).toEqual(["Bob", 30]);
  });

  it("filters rows", () => {
    const table: DataTable = {
      ...baseTable,
      filters: [{ col: 1, op: "gt", value: 50 }],
    };
    const { rows } = applyTableView(buildGrid(), table);
    expect(rows.map((r) => r[0]).sort()).toEqual(["Amy", "Cal"]);
  });

  it("sorts ascending by a numeric column", () => {
    const table: DataTable = { ...baseTable, sort: { col: 1, dir: "asc" } };
    const { rows } = applyTableView(buildGrid(), table);
    expect(rows.map((r) => r[1])).toEqual([30, 60, 90]);
  });

  it("sorts descending by a string column", () => {
    const table: DataTable = { ...baseTable, sort: { col: 0, dir: "desc" } };
    const { rows } = applyTableView(buildGrid(), table);
    expect(rows.map((r) => r[0])).toEqual(["Cal", "Bob", "Amy"]);
  });

  it("filters then sorts", () => {
    const table: DataTable = {
      ...baseTable,
      filters: [{ col: 1, op: "gte", value: 60 }],
      sort: { col: 1, dir: "desc" },
    };
    const { rows } = applyTableView(buildGrid(), table);
    expect(rows).toEqual([
      ["Amy", 90],
      ["Cal", 60],
    ]);
  });

  it("uses computed values when present", () => {
    let g = buildGrid();
    g = setCell(g, "B2", { f: "=10*10" }); // formula cell
    const computed = { B2: 100 };
    const { rows } = applyTableView(g, baseTable, computed);
    const bob = rows.find((r) => r[0] === "Bob");
    expect(bob?.[1]).toBe(100);
  });

  it("contains filter on string column", () => {
    const table: DataTable = {
      ...baseTable,
      filters: [{ col: 0, op: "contains", value: "a" }],
    };
    const { rows } = applyTableView(buildGrid(), table);
    // "Amy" and "Cal" contain 'a' (case-insensitive)
    expect(rows.map((r) => r[0]).sort()).toEqual(["Amy", "Cal"]);
  });
});
