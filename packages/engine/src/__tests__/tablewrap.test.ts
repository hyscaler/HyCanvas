import { describe, expect, it } from "vitest";
import { wrapCellLines, cellLineHeight } from "../tablewrap";

// Ten units per character: a plain measure that makes the breaks readable.
const measure = (s: string) => s.length * 10;

describe("a table cell wraps like a paragraph", () => {
  it("breaks greedily by words at the cell width", () => {
    expect(wrapCellLines("Live GPS map, updated every 30 sec", 150, measure)).toEqual(["Live GPS map,", "updated every", "30 sec"]);
  });
  it("keeps a short value on one line and an empty one on none", () => {
    expect(wrapCellLines("12 min", 150, measure)).toEqual(["12 min"]);
    expect(wrapCellLines("   ", 150, measure)).toEqual([]);
  });
  it("lets a word wider than the cell stand alone rather than dropping it", () => {
    expect(wrapCellLines("a supercalifragilistic word", 100, measure)).toEqual(["a", "supercalifragilistic", "word"]);
  });
  it("sets lines on a pitch a quarter above the size", () => {
    expect(cellLineHeight(28)).toBe(35);
  });
});
