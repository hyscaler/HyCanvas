import { describe, it, expect } from "vitest";
import {
  MagicParseError,
  parseModelJson,
  normalizeMagicDesign,
  normalizeChartData,
  tabularToChart,
  parseNumber,
} from "./magicDesign";

describe("parseModelJson (robust model-output parsing, F22)", () => {
  it("parses plain JSON", () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips ```json code fences", () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("strips bare ``` fences", () => {
    expect(parseModelJson('```\n[1,2,3]\n```')).toEqual([1, 2, 3]);
  });

  it("recovers JSON embedded in prose", () => {
    expect(parseModelJson('Sure! Here you go: {"a":1} hope that helps')).toEqual({ a: 1 });
  });

  it("does not end a span on a brace inside a string", () => {
    expect(parseModelJson('text {"a":"}"} tail')).toEqual({ a: "}" });
  });

  it("throws MagicParseError on empty input", () => {
    expect(() => parseModelJson("   ")).toThrow(MagicParseError);
  });

  it("throws MagicParseError on non-JSON", () => {
    expect(() => parseModelJson("not json at all")).toThrow(MagicParseError);
  });
});

describe("normalizeMagicDesign (FR-4)", () => {
  it("normalizes a valid design, clamping fractions", () => {
    const spec = normalizeMagicDesign({
      background: { kind: "solid", color: "#112233" },
      elements: [
        { kind: "heading", text: "Sale", x: -1, y: 0.5, w: 2, h: 0.2, fontSize: 80 },
        { kind: "accent", x: 0.1, y: 0.1, w: 0.3, h: 0.3, color: "#ff0000" },
      ],
    });
    expect(spec.background.color).toBe("#112233");
    expect(spec.elements[0].x).toBe(0); // clamped from -1
    expect(spec.elements[0].w).toBe(1); // clamped from 2
    expect(spec.elements[1].kind).toBe("accent");
  });

  it("drops text elements with no text but keeps accents", () => {
    const spec = normalizeMagicDesign({
      background: { kind: "solid" },
      elements: [
        { kind: "heading", x: 0, y: 0, w: 1, h: 0.2 },
        { kind: "accent", x: 0, y: 0, w: 0.5, h: 0.5 },
      ],
    });
    expect(spec.elements).toHaveLength(1);
    expect(spec.elements[0].kind).toBe("accent");
  });

  it("defaults a solid white background when none is given", () => {
    const spec = normalizeMagicDesign({ elements: [{ kind: "body", text: "hi", x: 0, y: 0, w: 1, h: 0.1 }] });
    expect(spec.background.kind).toBe("solid");
    expect(spec.background.color).toBe("#ffffff");
  });

  it("throws when there are no usable elements", () => {
    expect(() => normalizeMagicDesign({ background: {}, elements: [] })).toThrow(MagicParseError);
  });
});

describe("parseNumber", () => {
  it("strips currency, separators, and percent", () => {
    expect(parseNumber("$1,234")).toBe(1234);
    expect(parseNumber("45%")).toBe(45);
  });
  it("handles parenthesized negatives", () => {
    expect(parseNumber("(20)")).toBe(-20);
  });
  it("treats blanks/garbage as 0", () => {
    expect(parseNumber("")).toBe(0);
    expect(parseNumber("n/a")).toBe(0);
  });
});

describe("tabularToChart (FR-7 pasted/CSV path)", () => {
  it("uses first column as categories and each other column as a series", () => {
    const data = tabularToChart(
      [
        ["Month", "Revenue", "Cost"],
        ["Jan", "100", "40"],
        ["Feb", "120", "50"],
      ],
      "line",
    );
    expect(data.chartType).toBe("line");
    expect(data.categories).toEqual(["Jan", "Feb"]);
    expect(data.series).toEqual([
      { name: "Revenue", values: [100, 120] },
      { name: "Cost", values: [40, 50] },
    ]);
  });

  it("tolerates ragged rows (missing cells become 0)", () => {
    const data = tabularToChart([
      ["X", "Y"],
      ["a", "1"],
      ["b"],
    ]);
    expect(data.series[0].values).toEqual([1, 0]);
  });

  it("throws when there is no data row", () => {
    expect(() => tabularToChart([["only", "header"]])).toThrow(MagicParseError);
  });

  it("throws on a single column", () => {
    expect(() => tabularToChart([["x"], ["1"]])).toThrow(MagicParseError);
  });
});

describe("normalizeChartData (FR-7 natural-language path)", () => {
  it("validates type, categories, and aligns series length", () => {
    const data = normalizeChartData({
      chartType: "line",
      categories: ["Jan", "Feb", "Mar"],
      series: [{ name: "Revenue", values: [10, 20] }], // short -> padded to 3
    });
    expect(data.chartType).toBe("line");
    expect(data.series[0].values).toEqual([10, 20, 0]);
  });

  it("falls back to bar for an unknown chart type", () => {
    const data = normalizeChartData({ chartType: "spiral", categories: ["a"], series: [{ name: "s", values: [5] }] });
    expect(data.chartType).toBe("bar");
  });

  it("coerces string values to numbers", () => {
    const data = normalizeChartData({ chartType: "bar", categories: ["a", "b"], series: [{ name: "s", values: ["3", "x"] }] });
    expect(data.series[0].values).toEqual([3, 0]);
  });

  it("throws when there are no categories", () => {
    expect(() => normalizeChartData({ chartType: "bar", categories: [], series: [] })).toThrow(MagicParseError);
  });

  it("throws when all values are zero / missing", () => {
    expect(() => normalizeChartData({ chartType: "bar", categories: ["a"], series: [{ name: "s", values: [0] }] })).toThrow(
      MagicParseError,
    );
  });
});
