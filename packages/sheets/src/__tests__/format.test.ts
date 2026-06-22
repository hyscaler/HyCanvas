import { describe, it, expect } from "vitest";
import {
  formatNumber,
  formatDate,
  formatValue,
  applyConditionalFormat,
} from "../format";
import type { ConditionalRule } from "../model";
import { dateToSerial } from "@hc/formula";

describe("formatNumber", () => {
  it("plain / General", () => {
    expect(formatNumber(1234.5, "")).toBe("1234.5");
    expect(formatNumber(42, "General")).toBe("42");
  });
  it("fixed decimals", () => {
    expect(formatNumber(3.14159, "0.00")).toBe("3.14");
    expect(formatNumber(3, "0.000")).toBe("3.000");
    expect(formatNumber(2.5, "0")).toBe("3");
  });
  it("thousands", () => {
    expect(formatNumber(1234567, "#,##0")).toBe("1,234,567");
    expect(formatNumber(1234.5, "#,##0.00")).toBe("1,234.50");
  });
  it("percent", () => {
    expect(formatNumber(0.25, "0%")).toBe("25%");
    expect(formatNumber(0.1234, "0.00%")).toBe("12.34%");
  });
  it("currency", () => {
    expect(formatNumber(1234.5, "$#,##0.00")).toBe("$1,234.50");
    expect(formatNumber(1000, "$#,##0")).toBe("$1,000");
  });
  it("negatives", () => {
    expect(formatNumber(-1234.5, "#,##0.00")).toBe("-1,234.50");
    expect(formatNumber(-0.5, "0%")).toBe("-50%");
  });
});

describe("formatDate", () => {
  it("formats a date-serial", () => {
    const serial = dateToSerial(2020, 1, 5);
    expect(formatNumber(serial, "yyyy-mm-dd")).toBe("2020-01-05");
  });
  it("formats an ISO string", () => {
    expect(formatDate("2021-12-31T00:00:00Z", "yyyy-mm-dd")).toBe("2021-12-31");
  });
});

describe("formatValue", () => {
  it("handles errors / null / bool", () => {
    expect(formatValue({ error: "#DIV/0!" })).toBe("#DIV/0!");
    expect(formatValue(null)).toBe("");
    expect(formatValue(true)).toBe("TRUE");
  });
  it("applies number format to numbers", () => {
    expect(formatValue(0.5, "0%")).toBe("50%");
  });
});

describe("applyConditionalFormat", () => {
  const rules: ConditionalRule[] = [
    {
      id: "r1",
      range: "A1:A10",
      when: { op: "gt", value: 100 },
      style: { fill: "#ff0000" },
    },
    {
      id: "r2",
      range: "A1:A10",
      when: { op: "between", value: 0, value2: 50 },
      style: { fill: "#00ff00" },
    },
  ];

  it("matches gt rule in range", () => {
    expect(applyConditionalFormat(150, rules, "A1")).toEqual({ fill: "#ff0000" });
  });
  it("matches between rule", () => {
    expect(applyConditionalFormat(25, rules, "A5")).toEqual({ fill: "#00ff00" });
  });
  it("no match returns undefined", () => {
    expect(applyConditionalFormat(75, rules, "A5")).toBeUndefined();
  });
  it("out-of-range cell never matches", () => {
    expect(applyConditionalFormat(150, rules, "B1")).toBeUndefined();
  });
  it("contains operator", () => {
    const r: ConditionalRule[] = [
      {
        id: "c",
        range: "A1:A1",
        when: { op: "contains", value: "err" },
        style: { fill: "#000" },
      },
    ];
    expect(applyConditionalFormat("error!", r, "A1")).toEqual({ fill: "#000" });
    expect(applyConditionalFormat("ok", r, "A1")).toBeUndefined();
  });
  it("last matching rule wins", () => {
    const r: ConditionalRule[] = [
      { id: "a", range: "A1:A1", when: { op: "gt", value: 0 }, style: { fill: "#1" } },
      { id: "b", range: "A1:A1", when: { op: "gt", value: 0 }, style: { fill: "#2" } },
    ];
    expect(applyConditionalFormat(5, r, "A1")).toEqual({ fill: "#2" });
  });
});
