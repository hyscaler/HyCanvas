import { describe, it, expect } from "vitest";
import { createBlankDesign, createNode, type Node, type Page, type TextNode } from "@hc/schema";
import { resizePage } from "../resize";

// Build a single-page design at a given size and return its (only) page so the
// tests work on a real Page with a white background, like the editor produces.
function pageOf(width: number, height: number, children: Node[]): Page {
  const d = createBlankDesign({ width, height });
  d.pages[0].children = children;
  return d.pages[0];
}

function shape(id: string, x: number, y: number, w: number, h: number): Node {
  return createNode("shape", {
    id,
    shape: "rect",
    transform: { x, y, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: w, height: h },
  } as Partial<Node>);
}

function text(id: string, x: number, y: number, w: number, h: number, fontSize: number): TextNode {
  return createNode("text", {
    id,
    transform: { x, y, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: w, height: h },
    box: { mode: "fixed", width: w, height: h, autoFit: { enabled: false, min: 8, max: 200 }, verticalAlign: "top" },
    content: [
      {
        runs: [{ text: "Hello", style: { fontFamily: "system", fontStyle: "Regular", fontSize, fill: { type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } } } }],
        style: { align: "left", direction: "auto" },
      },
    ],
  } as Partial<Node>) as TextNode;
}

describe("resizePage (F22 FR-1/FR-2)", () => {
  it("scales a line node's polyline with its mapped box (the stroke draws from points)", () => {
    const line = createNode("line", {
      id: "ln",
      points: [{ x: 0, y: 0 }, { x: 240, y: 0 }],
      transform: { x: 100, y: 100, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 240, height: 4 },
      stroke: { fill: { type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } }, width: 4, align: "center", cap: "butt", join: "miter" },
      startCap: "none",
      endCap: "arrow",
    } as Partial<Node>);
    const src = pageOf(1000, 1000, [line]);
    const out = resizePage(src, { width: 2000, height: 2000 });
    const n = out.children[0] as unknown as { size: { width: number }; points: { x: number; y: number }[] };
    // The polyline's reach must match the mapped box, not the source length.
    expect(n.points[1].x).toBeCloseTo(n.size.width, 5);
    expect(n.points[0].x).toBe(0);
  });


  it("preserves node count, z-order, and ids", () => {
    const src = pageOf(1000, 1000, [shape("a", 10, 10, 100, 100), shape("b", 500, 500, 100, 100), shape("c", 800, 50, 50, 50)]);
    const out = resizePage(src, { width: 1920, height: 1080 });
    expect(out.children.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(out.width).toBe(1920);
    expect(out.height).toBe(1080);
    // source is untouched
    expect(src.width).toBe(1000);
  });

  it("keeps a centered node centered", () => {
    // 200x200 box centered on a 1000x1000 page (origin 400,400).
    const src = pageOf(1000, 1000, [shape("c", 400, 400, 200, 200)]);
    const out = resizePage(src, { width: 800, height: 1600 });
    const n = out.children[0];
    const cx = n.transform.x + n.size.width / 2;
    const cy = n.transform.y + n.size.height / 2;
    expect(cx).toBeCloseTo(400, 3); // 800/2
    expect(cy).toBeCloseTo(800, 3); // 1600/2
  });

  it("keeps a bottom-anchored node at the bottom with the same margin", () => {
    // Box hugging the bottom: 100 tall at y=860 on a 1000-tall page -> 40px bottom margin.
    const src = pageOf(1000, 1000, [shape("foot", 100, 860, 200, 100)]);
    const out = resizePage(src, { width: 1000, height: 2000 });
    const n = out.children[0];
    const bottomMargin = out.height - (n.transform.y + n.size.height);
    expect(bottomMargin).toBeCloseTo(40, 3);
  });

  it("stretches a full-bleed background to fill the new size", () => {
    const src = pageOf(1000, 1000, [shape("bg", 0, 0, 1000, 1000)]);
    const out = resizePage(src, { width: 1920, height: 600 });
    const n = out.children[0];
    expect(n.transform.x).toBeCloseTo(0, 3);
    expect(n.transform.y).toBeCloseTo(0, 3);
    expect(n.size.width).toBeCloseTo(1920, 3);
    expect(n.size.height).toBeCloseTo(600, 3);
  });

  it("scales text font size within the configured clamp and syncs the box", () => {
    const src = pageOf(1000, 1000, [text("t", 100, 100, 400, 100, 40)]);
    // 4x area-ish downscale: factor = sqrt((250/1000)*(250/1000)) = 0.25.
    const out = resizePage(src, { width: 250, height: 250 });
    const n = out.children[0] as TextNode;
    const fs = n.content[0].runs[0].style.fontSize;
    // 40 * 0.25 = 10, above the min of 8, so no clamp.
    expect(fs).toBeCloseTo(10, 3);
    // box width tracks the node's new mapped width so the text reflows.
    expect(n.box.width).toBeCloseTo(n.size.width, 3);
  });

  it("respects the box autoFit font min when downscaling hard", () => {
    const src = pageOf(2000, 2000, [text("t", 100, 100, 400, 100, 40)]);
    // factor = sqrt((100/2000)^2) = 0.05; 40*0.05 = 2, below the min of 8.
    const out = resizePage(src, { width: 100, height: 100 });
    const n = out.children[0] as TextNode;
    expect(n.content[0].runs[0].style.fontSize).toBeCloseTo(8, 3);
  });

  it("handles portrait -> landscape (centered element stays on-canvas and centered)", () => {
    const src = pageOf(1080, 1920, [shape("c", 340, 860, 400, 200)]); // centered-ish
    const out = resizePage(src, { width: 1920, height: 1080 });
    const n = out.children[0];
    expect(n.transform.x).toBeGreaterThanOrEqual(0);
    expect(n.transform.y).toBeGreaterThanOrEqual(0);
    expect(n.transform.x + n.size.width).toBeLessThanOrEqual(1920 + 1e-6);
    expect(n.transform.y + n.size.height).toBeLessThanOrEqual(1080 + 1e-6);
  });

  it("scales ruler guides proportionally with their axis", () => {
    const src = pageOf(1000, 500, [shape("a", 0, 0, 100, 100)]);
    // An "x" guide is a vertical line (position along the width); a "y" guide
    // is horizontal (position along the height).
    src.guides = [
      { axis: "x", position: 250 },
      { axis: "y", position: 100 },
    ];
    const out = resizePage(src, { width: 2000, height: 1500 });
    expect(out.guides).toEqual([
      { axis: "x", position: 500 },
      { axis: "y", position: 300 },
    ]);
  });

  it("handles landscape -> portrait keeping group identity (re-places as a unit)", () => {
    const child = shape("child", 20, 20, 60, 60);
    const grp = createNode("group", {
      id: "g",
      transform: { x: 200, y: 100, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 300, height: 200 },
      children: [child],
    } as Partial<Node>);
    const src = pageOf(1920, 1080, [grp]);
    const out = resizePage(src, { width: 1080, height: 1920 });
    const g = out.children[0] as unknown as { id: string; type: string; children: Node[] };
    expect(g.id).toBe("g");
    expect(g.type).toBe("group");
    expect(g.children).toHaveLength(1);
    expect(g.children[0].id).toBe("child");
    // child stays relative to the group (unchanged local transform/size).
    expect(g.children[0].transform.x).toBe(20);
    expect(g.children[0].size.width).toBe(60);
  });
});
