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

  // #83: a post resized to a story stacked the subtitle on the title, because
  // each block was anchored on its own and the centered title grew downward.
  const boxOf = (n: Node) => ({ x: n.transform.x, y: n.transform.y, w: n.size.width, h: n.size.height });
  const overlaps = (a: Node, b: Node) => {
    const p = boxOf(a);
    const q = boxOf(b);
    return Math.min(p.x + p.w, q.x + q.w) > Math.max(p.x, q.x) && Math.min(p.y + p.h, q.y + q.h) > Math.max(p.y, q.y);
  };

  it("keeps stacked text blocks apart and in order on post -> story (#83)", () => {
    // The "We're Hiring" layout: kicker near the top, a big centered title, a
    // subtitle below it, a button (pill + label) near the bottom.
    const src = pageOf(1080, 1080, [
      text("kicker", 140, 150, 800, 40, 30),
      text("title", 110, 280, 860, 340, 100),
      text("sub", 190, 710, 700, 40, 28),
      shape("pill", 360, 840, 360, 92),
      text("cta", 360, 840, 360, 92, 28),
    ]);
    const out = resizePage(src, { width: 1080, height: 1920 });
    const byId = Object.fromEntries(out.children.map((n) => [n.id, n]));
    const order = ["kicker", "title", "sub", "pill"];
    for (let i = 0; i < order.length - 1; i++) {
      const a = byId[order[i]];
      const b = byId[order[i + 1]];
      expect(overlaps(a, b)).toBe(false);
      expect(a.transform.y + a.size.height).toBeLessThanOrEqual(b.transform.y + 1e-6);
    }
    // The label stays on its pill.
    expect(boxOf(byId.cta)).toEqual(boxOf(byId.pill));
    // Everything stays on the page.
    for (const n of out.children) {
      expect(n.transform.x).toBeGreaterThanOrEqual(-1e-6);
      expect(n.transform.x + n.size.width).toBeLessThanOrEqual(1080 + 1e-6);
      expect(n.transform.y + n.size.height).toBeLessThanOrEqual(1920 + 1e-6);
    }
  });

  it("never widens text past the target's proportional side margins (#83)", () => {
    // 860 wide with 110 margins on a 1080 page; a story is just as wide, so
    // growing the font by the area factor would push the box off both sides.
    const src = pageOf(1080, 1080, [text("t", 110, 280, 860, 340, 100)]);
    const out = resizePage(src, { width: 1080, height: 1920 });
    const n = out.children[0] as TextNode;
    expect(n.transform.x).toBeGreaterThanOrEqual(110 - 1e-6);
    expect(n.transform.x + n.size.width).toBeLessThanOrEqual(970 + 1e-6);
    // Font, width and height share one scale, so the text wraps as before.
    const k = n.size.width / 860;
    expect(n.content[0].runs[0].style.fontSize).toBeCloseTo(100 * k, 3);
    expect(n.size.height).toBeCloseTo(340 * k, 3);
  });

  it("puts side-by-side columns back apart on slide -> story (#83)", () => {
    const src = pageOf(1920, 1080, [text("left", 150, 300, 480, 40, 32), text("right", 710, 300, 480, 40, 32), text("far", 1270, 300, 480, 40, 32)]);
    const out = resizePage(src, { width: 1080, height: 1920 });
    const [l, r, f] = out.children;
    expect(overlaps(l, r)).toBe(false);
    expect(overlaps(r, f)).toBe(false);
    expect(l.transform.x).toBeLessThan(r.transform.x);
    expect(r.transform.x).toBeLessThan(f.transform.x);
    expect(f.transform.x + f.size.width).toBeLessThanOrEqual(1080 + 1e-6);
  });

  it("keeps two stacked bleed lines apart (#83)", () => {
    // Big outline words hanging off the left edge, one under the other.
    const src = pageOf(1080, 1920, [text("a", -75, 609, 1200, 170, 150), text("b", -57, 779, 1200, 170, 150)]);
    for (const [w, h] of [[1080, 1080], [1920, 1080], [1200, 628]]) {
      const [a, b] = resizePage(src, { width: w, height: h }).children;
      expect(overlaps(a, b)).toBe(false);
      expect(a.transform.y).toBeLessThan(b.transform.y);
    }
  });

  it("never makes content overlap that did not overlap in the source (#83)", () => {
    // A dense slide: a title and a 4x3 grid of labelled cards.
    const kids: Node[] = [text("title", 96, 80, 1500, 90, 64)];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        kids.push(shape(`card${r}${c}`, 96 + c * 440, 220 + r * 270, 400, 240));
        kids.push(text(`label${r}${c}`, 116 + c * 440, 240 + r * 270, 360, 40, 28));
      }
    }
    const src = pageOf(1920, 1080, kids);
    for (const [w, h] of [[1080, 1920], [1080, 1080], [1200, 628], [1080, 1350]]) {
      const out = resizePage(src, { width: w, height: h });
      for (let i = 0; i < kids.length; i++) {
        for (let j = i + 1; j < kids.length; j++) {
          if (overlaps(kids[i], kids[j])) continue;
          expect(overlaps(out.children[i], out.children[j]), `${kids[i].id} x ${kids[j].id} at ${w}x${h}`).toBe(false);
        }
      }
    }
  });

  it("keeps the text on a large card inside the card on landscape -> story (#92)", () => {
    // A link card covering most of a 1200x630 social card, with a title,
    // a subtitle and a button on it.
    const kids: Node[] = [
      shape("bg", 0, 0, 1200, 630),
      shape("card", 90, 80, 1020, 470),
      text("title", 150, 248, 530, 64, 48),
      text("subtitle", 150, 338, 500, 64, 22),
      shape("button", 150, 444, 250, 56),
    ];
    const src = pageOf(1200, 630, kids);
    const inside = (outer: Node, inner: Node) => {
      const cx = inner.transform.x + inner.size.width / 2;
      const cy = inner.transform.y + inner.size.height / 2;
      return (
        cx >= outer.transform.x && cx <= outer.transform.x + outer.size.width &&
        cy >= outer.transform.y && cy <= outer.transform.y + outer.size.height
      );
    };
    for (const [w, h] of [[1080, 1920], [1080, 1080], [1080, 1350]]) {
      const out = resizePage(src, { width: w, height: h }).children;
      for (const i of [2, 3, 4]) expect(inside(out[1], out[i]), `${kids[i].id} at ${w}x${h}`).toBe(true);
    }
  });
});
