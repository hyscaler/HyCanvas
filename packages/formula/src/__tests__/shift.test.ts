import { describe, it, expect } from "vitest";
import { shiftRefs } from "../shift";

describe("shiftRefs", () => {
  describe("row insert", () => {
    it("shifts refs at or below the insert point down", () => {
      // insert a row at index 1 (between row 1 and row 2)
      expect(shiftRefs("=A2", { axis: "row", at: 1, delta: 1 })).toBe("=A3");
      expect(shiftRefs("=A5+B10", { axis: "row", at: 1, delta: 1 })).toBe(
        "=A6+B11"
      );
    });

    it("leaves refs above the insert point untouched", () => {
      expect(shiftRefs("=A1", { axis: "row", at: 1, delta: 1 })).toBe("=A1");
    });

    it("shifts a ref exactly at the insert point", () => {
      // an insert at index 1 pushes row index 1 (A2) down
      expect(shiftRefs("=A2", { axis: "row", at: 1, delta: 1 })).toBe("=A3");
    });
  });

  describe("row delete", () => {
    it("shifts refs below the deleted row up", () => {
      // delete row index 1 (row "2")
      expect(shiftRefs("=A3", { axis: "row", at: 1, delta: -1 })).toBe("=A2");
      expect(shiftRefs("=A10+B5", { axis: "row", at: 1, delta: -1 })).toBe(
        "=A9+B4"
      );
    });

    it("turns a ref to the exact deleted row into #REF!", () => {
      expect(shiftRefs("=A2", { axis: "row", at: 1, delta: -1 })).toBe(
        "=#REF!"
      );
    });

    it("leaves refs above the deleted row untouched", () => {
      expect(shiftRefs("=A1", { axis: "row", at: 1, delta: -1 })).toBe("=A1");
    });
  });

  describe("col insert", () => {
    it("shifts refs at or right of the insert point", () => {
      // insert a column at index 1 (col "B")
      expect(shiftRefs("=B1", { axis: "col", at: 1, delta: 1 })).toBe("=C1");
      expect(shiftRefs("=A1", { axis: "col", at: 1, delta: 1 })).toBe("=A1");
      expect(shiftRefs("=Z1", { axis: "col", at: 1, delta: 1 })).toBe("=AA1");
    });
  });

  describe("col delete", () => {
    it("shifts refs right of the deleted column left", () => {
      expect(shiftRefs("=C1", { axis: "col", at: 1, delta: -1 })).toBe("=B1");
    });

    it("turns a ref to the exact deleted column into #REF!", () => {
      expect(shiftRefs("=B1", { axis: "col", at: 1, delta: -1 })).toBe(
        "=#REF!"
      );
    });
  });

  describe("absolute references", () => {
    it("shifts the index but keeps the $ markers", () => {
      expect(shiftRefs("=$A$2", { axis: "row", at: 1, delta: 1 })).toBe(
        "=$A$3"
      );
      expect(shiftRefs("=$B$1", { axis: "col", at: 1, delta: 1 })).toBe(
        "=$C$1"
      );
      expect(shiftRefs("=$A2", { axis: "row", at: 1, delta: 1 })).toBe("=$A3");
      expect(shiftRefs("=A$2", { axis: "row", at: 1, delta: 1 })).toBe("=A$3");
    });

    it("absolute ref to the deleted row still becomes #REF!", () => {
      expect(shiftRefs("=$A$2", { axis: "row", at: 1, delta: -1 })).toBe(
        "=#REF!"
      );
    });
  });

  describe("ranges", () => {
    it("shifts both endpoints of a range", () => {
      expect(shiftRefs("=SUM(A1:B3)", { axis: "row", at: 1, delta: 1 })).toBe(
        "=SUM(A1:B4)"
      );
      expect(shiftRefs("=SUM(A2:B3)", { axis: "row", at: 1, delta: 1 })).toBe(
        "=SUM(A3:B4)"
      );
    });

    it("shifts a range on a column edit", () => {
      expect(shiftRefs("=SUM(B1:D1)", { axis: "col", at: 1, delta: 1 })).toBe(
        "=SUM(C1:E1)"
      );
    });

    it("turns a range with a deleted endpoint into #REF!", () => {
      // delete row 1 (index 0): A1 endpoint vanishes
      expect(shiftRefs("=SUM(A1:A5)", { axis: "row", at: 0, delta: -1 })).toBe(
        "=SUM(#REF!)"
      );
    });
  });

  describe("non-reference tokens stay intact", () => {
    it("leaves function names untouched", () => {
      // LOG10 looks ref-like but is a function name
      expect(
        shiftRefs("=LOG10(A2)", { axis: "row", at: 1, delta: 1 })
      ).toBe("=LOG10(A3)");
      expect(shiftRefs("=SUM(A1)", { axis: "row", at: 5, delta: 1 })).toBe(
        "=SUM(A1)"
      );
    });

    it("leaves numbers and operators untouched", () => {
      expect(
        shiftRefs("=A2*2+10", { axis: "row", at: 1, delta: 1 })
      ).toBe("=A3*2+10");
    });

    it("leaves quoted strings untouched even if they look like refs", () => {
      expect(
        shiftRefs('=CONCAT("A2",A2)', { axis: "row", at: 1, delta: 1 })
      ).toBe('=CONCAT("A2",A3)');
    });

    it("preserves the leading equals and works without one", () => {
      expect(shiftRefs("A2", { axis: "row", at: 1, delta: 1 })).toBe("A3");
      expect(shiftRefs("=A2", { axis: "row", at: 1, delta: 1 })).toBe("=A3");
    });
  });
});
