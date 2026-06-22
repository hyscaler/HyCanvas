import { describe, it, expect } from "vitest";
import { printRects, cropMarks } from "../geometry";

describe("cropMarks", () => {
  const rects = printRects(100, 50, 3, 2); // 100x50mm trim, 3mm bleed, 2mm safe

  it("produces two strokes per corner (8 total)", () => {
    expect(cropMarks(rects).length).toBe(8);
  });

  it("marks sit in the bleed margin, never crossing into the trim", () => {
    const marks = cropMarks(rects, { markLengthMm: 2, offsetMm: 0.5 });
    const t = rects.trim;
    for (const m of marks) {
      const horizontal = m.y1 === m.y2;
      if (horizontal) {
        // a horizontal mark lies on a trim edge and extends left/right of trim
        const onEdge = m.y1 === t.y || m.y1 === t.y + t.height;
        expect(onEdge).toBe(true);
        const outsideX = (m.x1 <= t.x && m.x2 <= t.x) || (m.x1 >= t.x + t.width && m.x2 >= t.x + t.width);
        expect(outsideX).toBe(true);
      } else {
        const onEdge = m.x1 === t.x || m.x1 === t.x + t.width;
        expect(onEdge).toBe(true);
        const outsideY = (m.y1 <= t.y && m.y2 <= t.y) || (m.y1 >= t.y + t.height && m.y2 >= t.y + t.height);
        expect(outsideY).toBe(true);
      }
    }
  });

  it("clamps marks within the bleed sheet bounds", () => {
    const marks = cropMarks(rects, { markLengthMm: 100, offsetMm: 0 }); // absurdly long
    const s = rects.bleed;
    for (const m of marks) {
      expect(m.x1).toBeGreaterThanOrEqual(s.x);
      expect(m.x2).toBeGreaterThanOrEqual(s.x);
      expect(m.x1).toBeLessThanOrEqual(s.x + s.width);
      expect(m.y1).toBeLessThanOrEqual(s.y + s.height);
    }
  });
});
