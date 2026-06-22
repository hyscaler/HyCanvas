import { describe, it, expect } from "vitest";
import {
  colToIndex,
  indexToCol,
  parseRef,
  parseRange,
  cellKey,
  rangeKeys,
  isCellRef,
} from "../refs";

describe("refs", () => {
  it("colToIndex / indexToCol round-trip incl AA/AB", () => {
    expect(colToIndex("A")).toBe(0);
    expect(colToIndex("Z")).toBe(25);
    expect(colToIndex("AA")).toBe(26);
    expect(colToIndex("AB")).toBe(27);
    expect(colToIndex("BA")).toBe(52);
    expect(indexToCol(0)).toBe("A");
    expect(indexToCol(25)).toBe("Z");
    expect(indexToCol(26)).toBe("AA");
    expect(indexToCol(27)).toBe("AB");
    expect(indexToCol(701)).toBe("ZZ");
    for (const i of [0, 1, 25, 26, 27, 51, 52, 700, 701, 702]) {
      expect(colToIndex(indexToCol(i))).toBe(i);
    }
  });

  it("parseRef yields 0-based col/row", () => {
    expect(parseRef("B3")).toMatchObject({ col: 1, row: 2 });
    expect(parseRef("A1")).toMatchObject({ col: 0, row: 0 });
    expect(parseRef("AA10")).toMatchObject({ col: 26, row: 9 });
  });

  it("parseRef handles absolute refs and tracks flags", () => {
    const r = parseRef("$A$1");
    expect(r).toMatchObject({ col: 0, row: 0, colAbsolute: true, rowAbsolute: true });
    const r2 = parseRef("$B2");
    expect(r2).toMatchObject({ col: 1, row: 1, colAbsolute: true, rowAbsolute: false });
  });

  it("parseRange normalizes to top-left start", () => {
    expect(parseRange("A1:B3")).toEqual({
      start: expect.objectContaining({ col: 0, row: 0 }),
      end: expect.objectContaining({ col: 1, row: 2 }),
    });
    // reversed order normalizes
    const rev = parseRange("B3:A1");
    expect(rev.start.col).toBe(0);
    expect(rev.start.row).toBe(0);
    expect(rev.end.col).toBe(1);
    expect(rev.end.row).toBe(2);
  });

  it("cellKey builds A1 strings", () => {
    expect(cellKey(0, 0)).toBe("A1");
    expect(cellKey(1, 2)).toBe("B3");
    expect(cellKey(26, 9)).toBe("AA10");
  });

  it("rangeKeys expands row-major", () => {
    expect(rangeKeys(parseRange("A1:B2"))).toEqual(["A1", "B1", "A2", "B2"]);
  });

  it("isCellRef recognizes valid refs", () => {
    expect(isCellRef("A1")).toBe(true);
    expect(isCellRef("$A$1")).toBe(true);
    expect(isCellRef("SUM")).toBe(false);
  });

  it("throws on invalid refs", () => {
    expect(() => parseRef("1A")).toThrow();
    expect(() => parseRange("A1")).toThrow();
  });
});
