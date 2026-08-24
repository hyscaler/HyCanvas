import { describe, expect, it } from "vitest";
import {
  parseDataMatrix,
  looksTabular,
  coerceNumber,
  chartColumnSelectionSchema,
  buildChartFromSelection,
  firstTabularSource,
} from "../index";

const CSV = `Region,Revenue,Units
North,"1,200",30
South,900,22
East,1500.5,41`;

const SHEET = `[Sheet 1]
Quarter\tRevenue\tCosts
Q1\t100\t80
Q2\t120\t85
Q3\t140\t90`;

describe("parseDataMatrix", () => {
  it("detects the header, delimiter, and numeric columns (CSV)", () => {
    const m = parseDataMatrix(CSV)!;
    expect(m.headers).toEqual(["Region", "Revenue", "Units"]);
    expect(m.rows).toHaveLength(3);
    expect(m.numericColumns).toEqual([1, 2]);
  });

  it("handles the xlsx extractor's tab-separated sheet blocks", () => {
    const m = parseDataMatrix(SHEET)!;
    expect(m.headers).toEqual(["Quarter", "Revenue", "Costs"]);
    expect(m.rows).toHaveLength(3);
  });

  it("synthesizes headers when the first row is data", () => {
    const m = parseDataMatrix("10,20\n30,40\n50,60")!;
    expect(m.headers).toEqual(["Column 1", "Column 2"]);
    expect(m.rows).toHaveLength(3);
  });

  it("returns null for prose", () => {
    expect(parseDataMatrix("This is a paragraph.\nAnother paragraph of text here.")).toBeNull();
    expect(looksTabular("just words")).toBe(false);
    expect(looksTabular(CSV)).toBe(true);
  });
});

describe("coerceNumber", () => {
  it("handles thousands separators, currency, percents", () => {
    expect(coerceNumber('1,200')).toBe(1200);
    expect(coerceNumber("$4,500.25")).toBe(4500.25);
    expect(coerceNumber("37%")).toBe(37);
    expect(coerceNumber("Region")).toBeNull();
    expect(coerceNumber("")).toBeNull();
  });
});

describe("buildChartFromSelection", () => {
  const m = parseDataMatrix(CSV)!;

  it("computes values from the DATA per the model's column choices", () => {
    const chart = buildChartFromSelection(m, { chartType: "line", categoryColumn: "Region", valueColumns: ["Revenue"] });
    expect(chart.chartType).toBe("line");
    expect(chart.categories).toEqual(["North", "South", "East"]);
    expect(chart.series).toEqual([{ name: "Revenue", values: [1200, 900, 1500.5] }]);
  });

  it("repairs invented or invalid choices deterministically", () => {
    const chart = buildChartFromSelection(m, { chartType: "sparkle", categoryColumn: "Ghost", valueColumns: ["Nope", "Region"] });
    expect(chart.chartType).toBe("bar");
    expect(chart.categories).toEqual(["North", "South", "East"]); // first non-numeric column
    expect(chart.series[0].name).toBe("Revenue"); // first numeric column
  });

  it("keeps series aligned 1:1 with categories (missing cells become 0)", () => {
    const gappy = parseDataMatrix("A,B\nx,1\ny,\nz,3")!;
    const chart = buildChartFromSelection(gappy, { chartType: "bar", categoryColumn: "A", valueColumns: ["B"] });
    expect(chart.series[0].values).toEqual([1, 0, 3]);
    expect(chart.series[0].values).toHaveLength(chart.categories.length);
  });

  it("the selection schema enumerates only real columns", () => {
    const schema = chartColumnSelectionSchema(m) as { properties: { categoryColumn: { enum: string[] }; valueColumns: { items: { enum: string[] } } } };
    expect(schema.properties.categoryColumn.enum).toEqual(["Region", "Revenue", "Units"]);
    expect(schema.properties.valueColumns.items.enum).toEqual(["Revenue", "Units"]);
  });
});

describe("firstTabularSource", () => {
  it("finds the first source that reads as data", () => {
    const hit = firstTabularSource([{ name: "notes.md", text: "prose only here" }, { name: "q.xlsx", text: SHEET }]);
    expect(hit?.name).toBe("q.xlsx");
    expect(firstTabularSource([{ name: "n", text: "prose" }])).toBeNull();
    expect(firstTabularSource(undefined)).toBeNull();
  });
});

describe("coerceNumber hardening", () => {
  it("parses accounting negatives and rejects malformed grouping", async () => {
    const { coerceNumber } = await import("../index");
    expect(coerceNumber("(500)")).toBe(-500);
    expect(coerceNumber("($1,250.75)")).toBe(-1250.75);
    expect(coerceNumber("1,2,3")).toBeNull(); // NOT 123
    expect(coerceNumber("12,34")).toBeNull();
    expect(coerceNumber("1,234,567.5")).toBe(1234567.5);
  });
});
