import { describe, it, expect } from "vitest";
import { createBlankDesign, createNode, type Node } from "@hc/schema";
import { poseDesignAt, pageAnimationDuration } from "../pose";

function designWith(node: Node) {
  const file = createBlankDesign({ title: "Anim", width: 800, height: 600 });
  file.pages[0].children = [node];
  return file;
}
const shapeAt = (x: number) =>
  createNode("shape", {
    shape: "rect", opacity: 1,
    transform: { x, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 100, height: 100 },
    fills: [{ type: "solid", color: { srgb: { r: 1, g: 0, b: 0, a: 1 } } }],
  } as unknown as Partial<Node>) as Node;

describe("poseDesignAt", () => {
  it("applies a fade entrance over time", () => {
    const n = shapeAt(0);
    (n as unknown as { animation: unknown }).animation = { entrance: { preset: "fade", durationMs: 500, delayMs: 0, easing: "linear" } };
    const file = designWith(n);

    const atStart = poseDesignAt(file, 0, 0).pages[0].children[0];
    expect(atStart.opacity).toBeCloseTo(0, 2); // fade in: invisible at t=0

    const atEnd = poseDesignAt(file, 0, 500).pages[0].children[0];
    expect(atEnd.opacity).toBeCloseTo(1, 2); // fully visible at the end

    // The source design is untouched (pure).
    expect(file.pages[0].children[0].opacity).toBe(1);
  });

  it("reveals text progressively for a typewriter entrance", () => {
    const t = createNode("text", {
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 200, height: 40 },
      content: [{ runs: [{ text: "HELLO", style: {} }], style: {} }],
    } as unknown as Partial<Node>) as Node;
    (t as unknown as { animation: unknown }).animation = { entrance: { preset: "typewriter", durationMs: 1000, delayMs: 0, easing: "linear" } };
    const file = designWith(t);
    const chars = (n: Node) => (n as unknown as { content: { runs: { text: string }[] }[] }).content[0].runs[0].text;
    expect(chars(poseDesignAt(file, 0, 0).pages[0].children[0])).toBe("");      // nothing yet
    expect(chars(poseDesignAt(file, 0, 600).pages[0].children[0])).toBe("HEL"); // 60% of 5 -> 3
    expect(chars(poseDesignAt(file, 0, 1000).pages[0].children[0])).toBe("HELLO"); // full at end
    expect(chars(file.pages[0].children[0])).toBe("HELLO"); // source untouched
  });

  it("interpolates a custom keyframe track", () => {
    const n = shapeAt(10);
    (n as unknown as { animation: unknown }).animation = {
      custom: { durationMs: 1000, keyframes: [{ t: 0, dx: 0 }, { t: 1000, dx: 100 }] },
    };
    const file = designWith(n);
    const mid = poseDesignAt(file, 0, 500).pages[0].children[0] as unknown as { transform: { x: number } };
    expect(mid.transform.x).toBeCloseTo(60, 1); // base 10 + dx 50
  });

  it("reports the page animation duration", () => {
    const n = shapeAt(0);
    (n as unknown as { animation: unknown }).animation = { entrance: { preset: "rise", durationMs: 400, delayMs: 100, easing: "ease-out" } };
    expect(pageAnimationDuration(designWith(n))).toBe(500);
    expect(pageAnimationDuration(designWith(shapeAt(0)))).toBe(0);
  });
});
