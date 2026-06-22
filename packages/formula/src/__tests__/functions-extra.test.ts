import { describe, it, expect } from "vitest";
import { evaluate, EvalContext } from "../evaluate";
import { cellKey } from "../refs";
import { isError, CellValue } from "../functions";

function ctxFrom(cells: Record<string, CellValue>): EvalContext {
  return {
    getCell(col, row) {
      const key = cellKey(col, row);
      return key in cells ? cells[key] : null;
    },
  };
}

describe("formula - extended math", () => {
  const ctx = ctxFrom({});
  it("MOD/POWER/SQRT/INT", () => {
    expect(evaluate("=MOD(10,3)", ctx)).toBe(1);
    expect(evaluate("=MOD(-1,3)", ctx)).toBe(2); // sign follows divisor
    expect(evaluate("=POWER(2,10)", ctx)).toBe(1024);
    expect(evaluate("=SQRT(144)", ctx)).toBe(12);
    expect(isError(evaluate("=SQRT(-1)", ctx))).toBe(true);
    expect(evaluate("=INT(4.9)", ctx)).toBe(4);
    expect(evaluate("=INT(-4.1)", ctx)).toBe(-5);
  });
  it("rounding family", () => {
    expect(evaluate("=ROUNDUP(2.1,0)", ctx)).toBe(3);
    expect(evaluate("=ROUNDDOWN(2.9,0)", ctx)).toBe(2);
    expect(evaluate("=ROUNDUP(-2.1,0)", ctx)).toBe(-3);
    expect(evaluate("=CEILING(2.5,1)", ctx)).toBe(3);
    expect(evaluate("=FLOOR(2.5,1)", ctx)).toBe(2);
  });
  it("PRODUCT/MEDIAN over ranges", () => {
    const c = ctxFrom({ A1: 2, A2: 3, A3: 4 });
    expect(evaluate("=PRODUCT(A1:A3)", c)).toBe(24);
    expect(evaluate("=MEDIAN(A1:A3)", c)).toBe(3);
    expect(evaluate("=MEDIAN(1,2,3,4)", ctx)).toBe(2.5);
  });
});

describe("formula - branching & errors", () => {
  const ctx = ctxFrom({});
  it("IFERROR/IFNA", () => {
    expect(evaluate("=IFERROR(1/0,42)", ctx)).toBe(42);
    expect(evaluate("=IFERROR(5,42)", ctx)).toBe(5);
    const c = ctxFrom({ A1: "a", A2: "b" });
    expect(evaluate('=IFNA(MATCH("zzz",A1:A2,0),"x")', c)).toBe("x"); // MATCH miss => #N/A
    expect(evaluate('=IFNA(7,"x")', ctx)).toBe(7);
  });
  it("IFS/SWITCH", () => {
    expect(evaluate("=IFS(FALSE,1,TRUE,2)", ctx)).toBe(2);
    expect(evaluate('=SWITCH(2,1,"a",2,"b","z")', ctx)).toBe("b");
    expect(evaluate('=SWITCH(9,1,"a","default")', ctx)).toBe("default");
  });
  it("IS* predicates", () => {
    const c = ctxFrom({ A1: 5, A2: "hi", A3: null });
    expect(evaluate("=ISNUMBER(A1)", c)).toBe(true);
    expect(evaluate("=ISTEXT(A2)", c)).toBe(true);
    expect(evaluate("=ISBLANK(A3)", c)).toBe(true);
    expect(evaluate("=ISERROR(1/0)", c)).toBe(true);
  });
});

describe("formula - conditional aggregation", () => {
  const ctx = ctxFrom({ A1: 10, A2: 20, A3: 30, B1: "x", B2: "y", B3: "x" });
  it("SUMIF/COUNTIF/AVERAGEIF with operators and matching", () => {
    expect(evaluate("=SUMIF(A1:A3,\">15\")", ctx)).toBe(50);
    expect(evaluate("=COUNTIF(A1:A3,\">=20\")", ctx)).toBe(2);
    expect(evaluate('=COUNTIF(B1:B3,"x")', ctx)).toBe(2);
    expect(evaluate('=SUMIF(B1:B3,"x",A1:A3)', ctx)).toBe(40); // A1+A3
    expect(evaluate("=AVERAGEIF(A1:A3,\">=20\")", ctx)).toBe(25);
  });
});

describe("formula - text functions", () => {
  const ctx = ctxFrom({});
  it("SUBSTITUTE/REPLACE/FIND/SEARCH/TEXT", () => {
    expect(evaluate('=SUBSTITUTE("a-b-c","-","+")', ctx)).toBe("a+b+c");
    expect(evaluate('=SUBSTITUTE("a-b-c","-","+",2)', ctx)).toBe("a-b+c");
    expect(evaluate('=REPLACE("abcdef",2,3,"XY")', ctx)).toBe("aXYef");
    expect(evaluate('=FIND("c","abcabc")', ctx)).toBe(3);
    expect(evaluate('=SEARCH("C","abcabc")', ctx)).toBe(3);
    expect(evaluate("=TEXT(3.14159,\"0.00\")", ctx)).toBe("3.14");
  });
});

describe("formula - lookup", () => {
  const ctx = ctxFrom({
    A1: "apple", B1: 1, A2: "banana", B2: 2, A3: "cherry", B3: 3,
  });
  it("INDEX/MATCH/HLOOKUP", () => {
    expect(evaluate("=MATCH(\"banana\",A1:A3,0)", ctx)).toBe(2);
    expect(evaluate("=INDEX(B1:B3,2)", ctx)).toBe(2);
    expect(evaluate("=INDEX(A1:B3,3,2)", ctx)).toBe(3);
    // HLOOKUP across a horizontal header row.
    const h = ctxFrom({ A1: "q1", B1: "q2", C1: "q3", A2: 100, B2: 200, C2: 300 });
    expect(evaluate('=HLOOKUP("q2",A1:C2,2,FALSE)', h)).toBe(200);
  });
});
