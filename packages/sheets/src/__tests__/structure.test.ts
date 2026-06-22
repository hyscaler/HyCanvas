import { describe, it, expect } from "vitest";
import { createGrid, getCell, type Grid } from "../model";
import {
  insertRow,
  deleteRow,
  insertCol,
  deleteCol,
  sortRange,
} from "../structure";

function seed(cells: Record<string, { v?: number | string; f?: string }>): Grid {
  const g = createGrid("g", "S");
  return { ...g, cells: { ...cells } };
}

describe("insertRow", () => {
  it("re-keys cells at/below the insert point down and bumps rows", () => {
    const g = seed({ A1: { v: 1 }, A2: { v: 2 }, A3: { v: 3 } });
    const out = insertRow(g, 1); // insert before row "2"
    expect(getCell(out, "A1")).toEqual({ v: 1 });
    expect(getCell(out, "A2")).toBeUndefined();
    expect(getCell(out, "A3")).toEqual({ v: 2 });
    expect(getCell(out, "A4")).toEqual({ v: 3 });
    expect(out.rows).toBe(g.rows + 1);
    // immutable
    expect(getCell(g, "A2")).toEqual({ v: 2 });
  });

  it("rewrites formula refs that shift down", () => {
    const g = seed({ A2: { v: 2 }, B1: { f: "=A2+1" } });
    const out = insertRow(g, 1);
    expect(getCell(out, "B1")?.f).toBe("=A3+1");
  });
});

describe("deleteRow", () => {
  it("removes the row and shifts lower rows up", () => {
    const g = seed({ A1: { v: 1 }, A2: { v: 2 }, A3: { v: 3 } });
    const out = deleteRow(g, 1); // delete row "2"
    expect(getCell(out, "A1")).toEqual({ v: 1 });
    expect(getCell(out, "A2")).toEqual({ v: 3 });
    expect(getCell(out, "A3")).toBeUndefined();
    expect(out.rows).toBe(g.rows - 1);
  });

  it("turns a formula ref to the deleted row into #REF! and shifts later refs", () => {
    const g = seed({ B1: { f: "=A2" }, B3: { f: "=A3" } });
    const out = deleteRow(g, 1); // delete row index 1 ("2")
    expect(getCell(out, "B1")?.f).toBe("=#REF!");
    // B3 -> B2, its ref A3 -> A2
    expect(getCell(out, "B2")?.f).toBe("=A2");
  });

  it("never shrinks rows below 1", () => {
    const g = { ...createGrid("g", "S", 1, 26) };
    expect(deleteRow(g, 0).rows).toBe(1);
  });
});

describe("insertCol / deleteCol", () => {
  it("insertCol re-keys cells at/right of the point and bumps cols", () => {
    const g = seed({ A1: { v: 1 }, B1: { v: 2 }, C1: { v: 3 } });
    const out = insertCol(g, 1); // insert before column "B"
    expect(getCell(out, "A1")).toEqual({ v: 1 });
    expect(getCell(out, "B1")).toBeUndefined();
    expect(getCell(out, "C1")).toEqual({ v: 2 });
    expect(getCell(out, "D1")).toEqual({ v: 3 });
    expect(out.cols).toBe(g.cols + 1);
  });

  it("deleteCol removes the column, shifts right cols left, and updates formulas", () => {
    const g = seed({ A1: { v: 1 }, B1: { v: 2 }, C1: { v: 3 }, D1: { f: "=C1" } });
    const out = deleteCol(g, 1); // delete column "B"
    expect(getCell(out, "A1")).toEqual({ v: 1 });
    expect(getCell(out, "B1")).toEqual({ v: 3 });
    // D1 -> C1, its ref C1 -> B1
    expect(getCell(out, "C1")?.f).toBe("=B1");
    expect(out.cols).toBe(g.cols - 1);
  });

  it("deleteCol turns a ref to the deleted column into #REF!", () => {
    const g = seed({ D1: { f: "=B1" } });
    const out = deleteCol(g, 1); // delete column index 1 ("B")
    expect(getCell(out, "C1")?.f).toBe("=#REF!");
  });
});

describe("sortRange", () => {
  it("sorts rows ascending by a column", () => {
    // range A1:B3, sort by col 0 (A)
    const g = seed({
      A1: { v: 3 },
      B1: { v: "c" },
      A2: { v: 1 },
      B2: { v: "a" },
      A3: { v: 2 },
      B3: { v: "b" },
    });
    const out = sortRange(g, "A1:B3", 0, "asc");
    expect(getCell(out, "A1")?.v).toBe(1);
    expect(getCell(out, "B1")?.v).toBe("a");
    expect(getCell(out, "A2")?.v).toBe(2);
    expect(getCell(out, "B2")?.v).toBe("b");
    expect(getCell(out, "A3")?.v).toBe(3);
    expect(getCell(out, "B3")?.v).toBe("c");
  });

  it("sorts descending", () => {
    const g = seed({ A1: { v: 1 }, A2: { v: 3 }, A3: { v: 2 } });
    const out = sortRange(g, "A1:A3", 0, "desc");
    expect(getCell(out, "A1")?.v).toBe(3);
    expect(getCell(out, "A2")?.v).toBe(2);
    expect(getCell(out, "A3")?.v).toBe(1);
  });

  it("keeps the header row fixed", () => {
    const g = seed({
      A1: { v: "Name" },
      A2: { v: 3 },
      A3: { v: 1 },
      A4: { v: 2 },
    });
    const out = sortRange(g, "A1:A4", 0, "asc", { headerRow: true });
    expect(getCell(out, "A1")?.v).toBe("Name");
    expect(getCell(out, "A2")?.v).toBe(1);
    expect(getCell(out, "A3")?.v).toBe(2);
    expect(getCell(out, "A4")?.v).toBe(3);
  });

  it("sorts strings lexically and places blanks last", () => {
    const g = seed({ A1: { v: "banana" }, A2: { v: "" }, A3: { v: "apple" } });
    const out = sortRange(g, "A1:A3", 0, "asc");
    expect(getCell(out, "A1")?.v).toBe("apple");
    expect(getCell(out, "A2")?.v).toBe("banana");
    expect(getCell(out, "A3")?.v).toBe(""); // blank value sorts last
  });

  it("is immutable", () => {
    const g = seed({ A1: { v: 2 }, A2: { v: 1 } });
    sortRange(g, "A1:A2", 0, "asc");
    expect(getCell(g, "A1")?.v).toBe(2);
  });
});
