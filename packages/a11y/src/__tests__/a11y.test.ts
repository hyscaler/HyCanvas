import { describe, it, expect } from "vitest";
import { createBlankDesign, createNode, type DesignFile, type Node } from "@hc/schema";
import { checkAccessibility, summarizeAccessibility, MIN_TOUCH_TARGET } from "../index";

const solid = (r: number, g: number, b: number) => ({ type: "solid" as const, color: { srgb: { r, g, b, a: 1 } } });

function docWith(children: Node[], background?: ReturnType<typeof solid>): DesignFile {
  const d = createBlankDesign({ width: 800, height: 600 }) as unknown as DesignFile & { pages: { background?: unknown; children: Node[] }[] };
  if (background) d.pages[0].background = background;
  d.pages[0].children = children;
  return d as DesignFile;
}

function text(runs: { text: string; fontSize: number; color: [number, number, number]; wght?: number }[]): Node {
  return createNode("text", {
    id: "t",
    name: "Label",
    box: { mode: "fixed", width: 200, height: 60 },
    content: [{ runs: runs.map((r) => ({ text: r.text, style: { fontFamily: "system", fontStyle: "Regular", fontSize: r.fontSize, ...(r.wght ? { axes: { wght: r.wght } } : {}), fill: solid(r.color[0], r.color[1], r.color[2]) } })), style: { align: "left", direction: "auto" } }],
  } as Partial<Node>);
}

describe("checkAccessibility", () => {
  it("flags low-contrast text against the page background", () => {
    // light gray text (#bbb) on white fails AA (needs 4.5:1 at 16px).
    const doc = docWith([text([{ text: "hi", fontSize: 16, color: [0.73, 0.73, 0.73] }])], solid(1, 1, 1));
    const issues = checkAccessibility(doc);
    const c = issues.find((i) => i.kind === "contrast");
    expect(c).toBeTruthy();
    expect(c!.severity).toBe("error"); // below 3:1
    expect(c!.required).toBe(4.5);
  });

  it("passes high-contrast text (black on white)", () => {
    const doc = docWith([text([{ text: "hi", fontSize: 16, color: [0, 0, 0] }])], solid(1, 1, 1));
    expect(checkAccessibility(doc).some((i) => i.kind === "contrast")).toBe(false);
  });

  it("uses the relaxed 3:1 threshold for large text", () => {
    // mid-gray (#777 ~ 4.48:1 on white) fails normal (4.5) but passes large (3).
    const gray: [number, number, number] = [0.467, 0.467, 0.467];
    const small = checkAccessibility(docWith([text([{ text: "x", fontSize: 16, color: gray }])], solid(1, 1, 1)));
    const large = checkAccessibility(docWith([text([{ text: "x", fontSize: 32, color: gray }])], solid(1, 1, 1)));
    expect(small.some((i) => i.kind === "contrast")).toBe(true);
    expect(large.some((i) => i.kind === "contrast")).toBe(false);
  });

  it("flags very small text", () => {
    const doc = docWith([text([{ text: "tiny", fontSize: 9, color: [0, 0, 0] }])], solid(1, 1, 1));
    expect(checkAccessibility(doc).some((i) => i.kind === "small-text")).toBe(true);
  });

  it("flags images without alt text, and clears once alt is set", () => {
    const noAlt = createNode("image", { id: "i", source: { assetId: "a", naturalWidth: 10, naturalHeight: 10 }, fit: "cover" } as Partial<Node>);
    expect(checkAccessibility(docWith([noAlt])).some((i) => i.kind === "alt-text")).toBe(true);
    const withAlt = createNode("image", { id: "i", alt: "a cat", source: { assetId: "a", naturalWidth: 10, naturalHeight: 10 }, fit: "cover" } as Partial<Node>);
    expect(checkAccessibility(docWith([withAlt])).some((i) => i.kind === "alt-text")).toBe(false);
  });

  function linkedRect(w: number, h: number): Node {
    return createNode("shape", {
      id: "btn", name: "Button", shape: "rect",
      size: { width: w, height: h },
      link: { kind: "url", url: "https://example.com" },
    } as Partial<Node>);
  }

  it("flags interactive targets smaller than the minimum size", () => {
    const small = checkAccessibility(docWith([linkedRect(20, 20)]));
    expect(small.some((i) => i.kind === "touch-target")).toBe(true);
    const ok = checkAccessibility(docWith([linkedRect(MIN_TOUCH_TARGET + 10, MIN_TOUCH_TARGET + 10)]));
    expect(ok.some((i) => i.kind === "touch-target")).toBe(false);
  });

  it("does not flag non-interactive small shapes", () => {
    const plain = createNode("shape", { id: "s", shape: "rect", size: { width: 5, height: 5 } } as Partial<Node>);
    expect(checkAccessibility(docWith([plain])).some((i) => i.kind === "touch-target")).toBe(false);
  });

  it("summarizes issues by severity and kind", () => {
    const doc = docWith(
      [text([{ text: "hi", fontSize: 9, color: [0.73, 0.73, 0.73] }]), linkedRect(10, 10)],
      solid(1, 1, 1),
    );
    const sum = summarizeAccessibility(checkAccessibility(doc));
    expect(sum.total).toBeGreaterThan(0);
    expect(sum.errors + sum.warnings).toBe(sum.total);
    expect(sum.byKind["touch-target"]).toBe(1);
    expect(sum.passes).toBe(sum.errors === 0);
  });
});
