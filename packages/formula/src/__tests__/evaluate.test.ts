import { describe, it, expect } from "vitest";
import { evaluate, EvalContext } from "../evaluate";
import { cellKey } from "../refs";
import { dateToSerial, isError, CellValue } from "../functions";

function ctxFrom(cells: Record<string, CellValue>, now?: number): EvalContext {
  return {
    getCell(col, row) {
      const key = cellKey(col, row);
      return key in cells ? cells[key] : null;
    },
    now,
  };
}

describe("evaluate - arithmetic & precedence", () => {
  const ctx = ctxFrom({});
  it("basic arithmetic", () => {
    expect(evaluate("=1+2", ctx)).toBe(3);
    expect(evaluate("=10-4", ctx)).toBe(6);
    expect(evaluate("=3*4", ctx)).toBe(12);
    expect(evaluate("=12/4", ctx)).toBe(3);
  });

  it("respects precedence", () => {
    expect(evaluate("=1+2*3", ctx)).toBe(7);
    expect(evaluate("=(1+2)*3", ctx)).toBe(9);
    expect(evaluate("=2+3*4-1", ctx)).toBe(13);
  });

  it("exponent is right-associative and high precedence", () => {
    expect(evaluate("=2^3", ctx)).toBe(8);
    expect(evaluate("=2^3^2", ctx)).toBe(512); // 2^(3^2)
    expect(evaluate("=2*3^2", ctx)).toBe(18);
  });

  it("unary minus/plus", () => {
    expect(evaluate("=-5", ctx)).toBe(-5);
    expect(evaluate("=-2^2", ctx)).toBe(4); // (-2)^2 in this engine (unary binds first)
    expect(evaluate("=3+-2", ctx)).toBe(1);
  });
});

describe("evaluate - concat & comparison", () => {
  const ctx = ctxFrom({});
  it("& concatenation", () => {
    expect(evaluate('="foo"&"bar"', ctx)).toBe("foobar");
    expect(evaluate('="x"&1', ctx)).toBe("x1");
  });

  it("comparisons", () => {
    expect(evaluate("=1<2", ctx)).toBe(true);
    expect(evaluate("=2<=2", ctx)).toBe(true);
    expect(evaluate("=3>4", ctx)).toBe(false);
    expect(evaluate("=5>=5", ctx)).toBe(true);
    expect(evaluate("=1=1", ctx)).toBe(true);
    expect(evaluate("=1<>2", ctx)).toBe(true);
    expect(evaluate('="a"="a"', ctx)).toBe(true);
  });
});

describe("evaluate - refs & ranges", () => {
  const ctx = ctxFrom({ A1: 10, A2: 20, A3: 30, B1: 5 });
  it("reads single refs", () => {
    expect(evaluate("=A1", ctx)).toBe(10);
    expect(evaluate("=A1+B1", ctx)).toBe(15);
  });
  it("absolute refs resolve same as relative", () => {
    expect(evaluate("=$A$1+$B$1", ctx)).toBe(15);
  });
});

describe("functions over ranges", () => {
  const ctx = ctxFrom({ A1: 1, A2: 2, A3: 3, A4: 4 });
  it("SUM / AVERAGE", () => {
    expect(evaluate("=SUM(A1:A4)", ctx)).toBe(10);
    expect(evaluate("=AVERAGE(A1:A4)", ctx)).toBe(2.5);
    expect(evaluate("=SUM(A1:A4,10)", ctx)).toBe(20);
  });
  it("MIN / MAX", () => {
    expect(evaluate("=MIN(A1:A4)", ctx)).toBe(1);
    expect(evaluate("=MAX(A1:A4)", ctx)).toBe(4);
  });
  it("COUNT / COUNTA", () => {
    const c = ctxFrom({ A1: 1, A2: "x", A3: 3 });
    expect(evaluate("=COUNT(A1:A3)", c)).toBe(2);
    expect(evaluate("=COUNTA(A1:A3)", c)).toBe(3);
  });
  it("ROUND", () => {
    expect(evaluate("=ROUND(3.14159,2)", ctx)).toBe(3.14);
    expect(evaluate("=ROUND(2.5,0)", ctx)).toBe(3);
    expect(evaluate("=ROUND(1.005,2)", ctx)).toBe(1.01);
  });
  it("ABS", () => {
    expect(evaluate("=ABS(-7)", ctx)).toBe(7);
  });
});

describe("logical functions", () => {
  const ctx = ctxFrom({ A1: 5 });
  it("IF", () => {
    expect(evaluate('=IF(A1>3,"big","small")', ctx)).toBe("big");
    expect(evaluate('=IF(A1>10,"big","small")', ctx)).toBe("small");
    expect(evaluate("=IF(TRUE,1)", ctx)).toBe(1);
    expect(evaluate("=IF(FALSE,1)", ctx)).toBe(false);
  });
  it("AND / OR / NOT", () => {
    expect(evaluate("=AND(TRUE,TRUE,1=1)", ctx)).toBe(true);
    expect(evaluate("=AND(TRUE,FALSE)", ctx)).toBe(false);
    expect(evaluate("=OR(FALSE,FALSE,1>0)", ctx)).toBe(true);
    expect(evaluate("=NOT(FALSE)", ctx)).toBe(true);
  });
});

describe("text functions", () => {
  const ctx = ctxFrom({ A1: "Hello World" });
  it("CONCAT / CONCATENATE", () => {
    expect(evaluate('=CONCAT("a","b","c")', ctx)).toBe("abc");
    expect(evaluate('=CONCATENATE("x",1,TRUE)', ctx)).toBe("x1TRUE");
  });
  it("LEN/LEFT/RIGHT/MID", () => {
    expect(evaluate("=LEN(A1)", ctx)).toBe(11);
    expect(evaluate("=LEFT(A1,5)", ctx)).toBe("Hello");
    expect(evaluate("=RIGHT(A1,5)", ctx)).toBe("World");
    expect(evaluate("=MID(A1,7,5)", ctx)).toBe("World");
  });
  it("UPPER/LOWER/TRIM", () => {
    expect(evaluate('=UPPER("abc")', ctx)).toBe("ABC");
    expect(evaluate('=LOWER("ABC")', ctx)).toBe("abc");
    expect(evaluate('=TRIM("  a   b  ")', ctx)).toBe("a b");
  });
});

describe("lookup functions", () => {
  // table: A=key, B=value
  const ctx = ctxFrom({
    A1: 1, B1: "one",
    A2: 2, B2: "two",
    A3: 3, B3: "three",
  });
  it("VLOOKUP exact match", () => {
    expect(evaluate("=VLOOKUP(2,A1:B3,2,FALSE)", ctx)).toBe("two");
    expect(evaluate("=VLOOKUP(3,A1:B3,2,FALSE)", ctx)).toBe("three");
  });
  it("VLOOKUP not found -> #N/A", () => {
    const r = evaluate("=VLOOKUP(9,A1:B3,2,FALSE)", ctx);
    expect(isError(r) && r.error).toBe("#N/A");
  });
  it("VLOOKUP bad column -> #REF!", () => {
    const r = evaluate("=VLOOKUP(2,A1:B3,5,FALSE)", ctx);
    expect(isError(r) && r.error).toBe("#REF!");
  });
  it("LOOKUP approximate", () => {
    expect(evaluate("=LOOKUP(2,A1:A3,B1:B3)", ctx)).toBe("two");
    expect(evaluate("=LOOKUP(2.5,A1:A3,B1:B3)", ctx)).toBe("two");
  });
});

describe("date functions", () => {
  it("DATE produces a serial", () => {
    expect(evaluate("=DATE(2020,1,1)", ctxFrom({}))).toBe(
      dateToSerial(2020, 1, 1)
    );
  });
  it("TODAY uses injected now", () => {
    const now = Date.UTC(2026, 5, 11);
    const r = evaluate("=TODAY()", ctxFrom({}, now));
    expect(r).toBe(dateToSerial(2026, 6, 11));
  });
  it("NOW uses injected now and carries the time-of-day fraction", () => {
    // noon UTC on 2026-06-11: whole part == TODAY's serial, fraction == 0.5.
    const now = Date.UTC(2026, 5, 11, 12, 0, 0);
    const r = evaluate("=NOW()", ctxFrom({}, now));
    expect(r).toBe(dateToSerial(2026, 6, 11) + 0.5);
  });
});

describe("error handling", () => {
  const ctx = ctxFrom({ A1: 10 });
  it("#DIV/0!", () => {
    const r = evaluate("=1/0", ctx);
    expect(isError(r) && r.error).toBe("#DIV/0!");
  });
  it("#NAME? for unknown function", () => {
    const r = evaluate("=BOGUS(1)", ctx);
    expect(isError(r) && r.error).toBe("#NAME?");
  });
  it("#VALUE! for non-numeric arithmetic", () => {
    const c = ctxFrom({ A1: "abc" });
    const r = evaluate("=A1*2", c);
    expect(isError(r) && r.error).toBe("#VALUE!");
  });
  it("error propagates through SUM", () => {
    const r = evaluate("=SUM(1/0,2)", ctx);
    expect(isError(r) && r.error).toBe("#DIV/0!");
  });
});
