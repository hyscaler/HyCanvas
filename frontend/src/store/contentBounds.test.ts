// Locks the per-page content-bounds primitive the MiniMap relies on. Each page's
// bounds must be computed in that page's OWN local space (Y from 0), independent
// of where the page sits in the stacked world layout, so the minimap overview
// and its "you are here" rectangle line up on page 2+ (the bug where the box was
// pinned to an edge). Also verifies contentBounds() tracks the active page.

import { describe, it, expect } from "vitest";
import { createBlankDesign, type DesignFile, type Node } from "@hc/schema";
import { useEditor } from "./editor";

const PAGE_W = 800;
const PAGE_H = 600;

/** A minimal shape node at an explicit position (for AABB math). */
function shapeAt(id: string, x: number, y: number, w: number, h: number): Node {
  return {
    id,
    type: "shape",
    shape: "rect",
    transform: { x, y, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: w, height: h },
    opacity: 1,
    blendMode: "normal",
    fills: [{ type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } }],
  } as unknown as Node;
}

/** Two pages; page 2 optionally carries an overflow node parked past the edge. */
function twoPageDoc(page2Node?: Node): DesignFile {
  const doc = createBlankDesign({ title: "t", width: PAGE_W, height: PAGE_H });
  const p2 = structuredClone(doc.pages[0]);
  p2.id = "page-2";
  if (page2Node) p2.children.push(page2Node);
  doc.pages.push(p2);
  return doc;
}

describe("pageContentBounds is per-page and page-local", () => {
  it("an empty page's bounds are just its own artboard, in local coords", () => {
    useEditor.getState().loadDoc(twoPageDoc());
    for (const i of [0, 1]) {
      expect(useEditor.getState().pageContentBounds(i)).toMatchObject({ x: 0, y: 0, width: PAGE_W, height: PAGE_H });
    }
  });

  it("content parked past page 2's edge grows only page 2, still local (y from 0)", () => {
    // Node at x=700..1100 overflows the 800-wide artboard to the right.
    useEditor.getState().loadDoc(twoPageDoc(shapeAt("n1", 700, 100, 400, 120)));
    // Page 1 untouched.
    expect(useEditor.getState().pageContentBounds(0)).toMatchObject({ x: 0, y: 0, width: PAGE_W, height: PAGE_H });
    const b2 = useEditor.getState().pageContentBounds(1)!;
    expect(b2.x).toBe(0); // local origin, NOT page-2's stacked world offset
    expect(b2.y).toBe(0);
    expect(b2.width).toBe(1100); // artboard (800) unioned with the node's right edge (1100)
    expect(b2.height).toBe(PAGE_H);
  });

  it("contentBounds() follows the active page", () => {
    useEditor.getState().loadDoc(twoPageDoc(shapeAt("n1", 700, 100, 400, 120)));
    useEditor.getState().setActivePage(1);
    expect(useEditor.getState().contentBounds()!.width).toBe(1100);
    useEditor.getState().setActivePage(0);
    expect(useEditor.getState().contentBounds()).toMatchObject({ x: 0, y: 0, width: PAGE_W, height: PAGE_H });
  });
});
