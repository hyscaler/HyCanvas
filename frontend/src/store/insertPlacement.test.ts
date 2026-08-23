// Regression gate for panel inserts on stacked multi-page documents. A new
// element must land at the CENTER OF ITS PAGE artboard, on the page the user is
// looking at. Pages are stacked vertically in world space while node
// coordinates are page-LOCAL. Two historical bugs this guards: (1) the world-Y
// viewport center was treated as page-local, so on page 2 shapes were pinned to
// the page bottom and icon groups landed entirely off the artboard; (2) even
// once on-page, elements were centered on the VIEWPORT, so a panned/zoomed view
// dropped them away from the page center.

import { describe, it, expect, beforeEach } from "vitest";
import { createBlankDesign } from "@hc/schema";
import { useEditor } from "./editor";
import { pageGap } from "@/lib/pageLayout";

const PAGE_W = 800;
const PAGE_H = 600;

function loadTwoPageDoc() {
  const doc = createBlankDesign({ title: "t", width: PAGE_W, height: PAGE_H });
  const p2 = structuredClone(doc.pages[0]);
  p2.id = "page-2";
  p2.name = "Page 2";
  doc.pages.push(p2);
  useEditor.getState().loadDoc(doc);
}

/** Point the viewport (1000x700, zoom 1) at the center of the given page. */
function lookAtPage(index: number) {
  const st = useEditor.getState();
  st.setViewportSize(1000, 700);
  const top = index * (PAGE_H + pageGap);
  st.setViewport({
    zoom: 1,
    panX: PAGE_W / 2 - 1000 / 2, // world center x = page center (pages share x=0)
    panY: top + PAGE_H / 2 - 700 / 2, // world center y = this page's center
  });
}

const kids = (i: number) => useEditor.getState().doc.pages[i].children;

describe("panel inserts on stacked pages", () => {
  beforeEach(loadTwoPageDoc);

  it("addNode centers on page 2 when the viewport shows page 2", () => {
    useEditor.getState().setActivePage(1);
    lookAtPage(1);
    useEditor.getState().addNode("shape", {});
    expect(kids(0).length).toBe(0);
    expect(kids(1).length).toBe(1);
    const n = kids(1)[0] as unknown as { transform: { x: number; y: number }; size: { width: number; height: number } };
    // Centered on the page (page-local coordinates), not clamped to an edge.
    expect(n.transform.x).toBeCloseTo(PAGE_W / 2 - n.size.width / 2, 1);
    expect(n.transform.y).toBeCloseTo(PAGE_H / 2 - n.size.height / 2, 1);
  });

  it("centers on the PAGE, not the viewport, when panned/zoomed to a corner", () => {
    // Look at the top-left corner of page 2, zoomed in. Viewport center is
    // nowhere near the page center; the element must still land at page center.
    useEditor.getState().setActivePage(1);
    const st = useEditor.getState();
    st.setViewportSize(1000, 700);
    const top = 1 * (PAGE_H + pageGap);
    st.setViewport({ zoom: 2, panX: 20, panY: top + 20 }); // top-left of page 2
    useEditor.getState().addNode("shape", {});
    expect(kids(1).length).toBe(1);
    const n = kids(1)[0] as unknown as { transform: { x: number; y: number }; size: { width: number; height: number } };
    expect(n.transform.x).toBeCloseTo(PAGE_W / 2 - n.size.width / 2, 1);
    expect(n.transform.y).toBeCloseTo(PAGE_H / 2 - n.size.height / 2, 1);
  });

  it("scroll then insert: the element lands on the page scrolled into view", () => {
    // Scrolling moves the active page (nothing selected) and inserts target
    // the ACTIVE page, so the element lands on the page in view.
    useEditor.getState().setActivePage(0);
    lookAtPage(1);
    useEditor.getState().addNode("shape", {});
    expect(kids(0).length).toBe(0);
    expect(kids(1).length).toBe(1);
    expect(useEditor.getState().activePage).toBe(1);
  });

  it("scrolling makes the page under the viewport center active (no selection)", () => {
    useEditor.getState().setActivePage(0);
    lookAtPage(1); // selection is empty, so the active page follows the scroll
    expect(useEditor.getState().activePage).toBe(1);
    lookAtPage(0);
    expect(useEditor.getState().activePage).toBe(0);
  });

  it("scrolling does NOT move the active page while a selection is live", () => {
    // The gizmo (and crop/text overlays) measure in active-page space, and a
    // selection always lives on the active page; a scroll must not break that.
    useEditor.getState().setActivePage(1);
    lookAtPage(1);
    useEditor.getState().addNode("shape", {}); // selects the new node on page 2
    expect(useEditor.getState().selection.length).toBe(1);
    lookAtPage(0);
    expect(useEditor.getState().activePage).toBe(1);
  });

  it("inserts go to the ACTIVE page, and the view scrolls back to it", () => {
    // A live selection pins the active page; inserting while scrolled to
    // another page must land on the ACTIVE page (not the viewed one) and
    // bring that page back into view so the new element is visible.
    useEditor.getState().setActivePage(1);
    lookAtPage(1);
    useEditor.getState().addNode("shape", {}); // selects on page 2, pinning it
    lookAtPage(0); // active stays 1 (selection live)
    expect(useEditor.getState().activePage).toBe(1);
    useEditor.getState().addNode("shape", {});
    expect(kids(0).length).toBe(0);
    expect(kids(1).length).toBe(2);
    // The insert scrolled page 2's band back under the viewport center.
    const st = useEditor.getState();
    const centerY = st.viewport.panY + 700 / 2 / st.viewport.zoom;
    const top = 1 * (PAGE_H + pageGap);
    expect(centerY).toBeGreaterThanOrEqual(top);
    expect(centerY).toBeLessThanOrEqual(top + PAGE_H);
  });

  it("goToPage activates the page and scrolls its band into view", () => {
    useEditor.getState().setActivePage(0);
    lookAtPage(0);
    useEditor.getState().goToPage(1);
    const st = useEditor.getState();
    expect(st.activePage).toBe(1);
    const centerY = st.viewport.panY + 700 / 2 / st.viewport.zoom;
    const top = 1 * (PAGE_H + pageGap);
    expect(centerY).toBeGreaterThanOrEqual(top);
    expect(centerY).toBeLessThanOrEqual(top + PAGE_H);
  });

  it("addIconSvg lands inside the viewed page's artboard", () => {
    useEditor.getState().setActivePage(1);
    lookAtPage(1);
    useEditor.getState().addIconSvg('<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" fill="#ff0000"/></svg>');
    expect(kids(1).length).toBe(1);
    const g = kids(1)[0] as unknown as {
      transform: { x: number; y: number; scaleX: number; scaleY: number };
      size: { width: number; height: number };
    };
    const w = g.size.width * g.transform.scaleX;
    const h = g.size.height * g.transform.scaleY;
    // Fully inside the page, centered (the old code placed this at world-Y,
    // hundreds of pixels below the artboard).
    expect(g.transform.x).toBeGreaterThanOrEqual(0);
    expect(g.transform.y).toBeGreaterThanOrEqual(0);
    expect(g.transform.x + w).toBeLessThanOrEqual(PAGE_W);
    expect(g.transform.y + h).toBeLessThanOrEqual(PAGE_H);
    expect(g.transform.x + w / 2).toBeCloseTo(PAGE_W / 2, 1);
    expect(g.transform.y + h / 2).toBeCloseTo(PAGE_H / 2, 1);
  });

  it("undo removes the node and restores the pre-insert active page", () => {
    useEditor.getState().setActivePage(0);
    lookAtPage(1); // follow-scroll already makes page 2 active here
    useEditor.getState().addNode("shape", {});
    expect(useEditor.getState().activePage).toBe(1);
    useEditor.getState().undo();
    expect(kids(1).length).toBe(0);
    // The pre-insert active page IS page 2 (the scroll moved it), so undo
    // keeps it: undo reverts the edit, not the user's scrolling.
    expect(useEditor.getState().activePage).toBe(1);
  });

  it("falls back to the active page's center before the viewport is measured", () => {
    useEditor.getState().setActivePage(1);
    useEditor.getState().setViewportSize(0, 0);
    useEditor.getState().addNode("shape", {});
    expect(kids(1).length).toBe(1);
    const n = kids(1)[0] as unknown as { transform: { x: number; y: number }; size: { width: number; height: number } };
    expect(n.transform.x).toBeCloseTo(PAGE_W / 2 - n.size.width / 2, 1);
    expect(n.transform.y).toBeCloseTo(PAGE_H / 2 - n.size.height / 2, 1);
  });
});
