import { describe, it, expect } from "vitest";
import { parseCsvMatrix, parseCsv } from "./csv";

describe("parseCsvMatrix (bulk-create data merge)", () => {
  it("parses with a trailing newline without an extra empty row", () => {
    expect(parseCsvMatrix("a,b\nc,d\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("parses without a trailing newline", () => {
    expect(parseCsvMatrix("a,b\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("handles embedded commas, quotes, and newlines inside quoted fields", () => {
    const text = 'a,"b,c"\n"line1\nline2",d';
    expect(parseCsvMatrix(text)).toEqual([
      ["a", "b,c"],
      ["line1\nline2", "d"],
    ]);
  });

  it('unescapes doubled quotes ("") inside a quoted field', () => {
    expect(parseCsvMatrix('"say ""hi"""')).toEqual([['say "hi"']]);
  });

  it("treats CRLF as a single line break", () => {
    expect(parseCsvMatrix("a,b\r\nc,d\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("preserves a legitimate all-empty data row (a bare comma line)", () => {
    // Regression: a content-based dedup used to drop this final empty row.
    expect(parseCsvMatrix("a,b\n,\n")).toEqual([
      ["a", "b"],
      ["", ""],
    ]);
  });

  it("preserves a single-column trailing empty value", () => {
    // "a", then a blank line: the blank line is a legitimate one-cell empty row.
    expect(parseCsvMatrix("a\n\n")).toEqual([["a"], [""]]);
  });

  it("strips a leading UTF-8 BOM from the first cell", () => {
    expect(parseCsvMatrix("﻿a,b\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("returns an empty matrix for empty input", () => {
    expect(parseCsvMatrix("")).toEqual([]);
  });
});

describe("parseCsv (headers + objects)", () => {
  it("keys rows by trimmed headers, tolerating ragged rows", () => {
    const { headers, rows } = parseCsv("name, age\nAda,36\nGrace");
    expect(headers).toEqual(["name", "age"]);
    expect(rows).toEqual([
      { name: "Ada", age: "36" },
      { name: "Grace", age: "" },
    ]);
  });

  it("strips a BOM so the first header is clean", () => {
    const { headers } = parseCsv("﻿name,age\nAda,36");
    expect(headers).toEqual(["name", "age"]);
  });
});
