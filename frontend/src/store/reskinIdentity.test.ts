// Re-skin to brand must preserve page/node/fill identity: many other undo
// closures capture page or node references, and the old implementation
// replaced doc.pages with structured clones (immediately at apply time AND on
// every undo/redo), detaching every captured reference. These pin the
// identity-safe rewrite: in-place mutation, per-page by-id snapshot restore,
// and no identity churn at all when nothing maps.

import { beforeEach, describe, expect, it } from "vitest";
import type { Color, Node } from "@hc/schema";
import { useEditor } from "./editor";

const c = (r: number, g: number, b: number, a = 1): Color => ({ srgb: { r, g, b, a } });
const RED = c(1, 0, 0);
const GREEN = c(0, 0.5, 0);
const BRAND_BLUE = c(0, 0, 1);

function seed() {
  const st = useEditor.getState();
  const page = st.doc.pages[st.activePage] as unknown as { background?: unknown; children: Node[] };
  page.background = { type: "solid", color: structuredClone(RED) };
  page.children.length = 0;
  page.children.push({
    id: "shape",
    type: "rect",
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 10, height: 10 },
    opacity: 1,
    blendMode: "normal",
    fills: [{ type: "solid", color: c(1, 0, 0, 0.5) }],
  } as unknown as Node);
  useEditor.setState({ selection: [], undoStack: [], redoStack: [], editingTextId: null });
}

function page() {
  const st = useEditor.getState();
  return st.doc.pages[st.activePage] as unknown as {
    background?: { color: Color };
    children: (Node & { fills?: { color: Color }[] })[];
  };
}

beforeEach(seed);

describe("reskinToBrand identity safety", () => {
  it("maps to the nearest brand color in place, alpha preserved, one undo step", () => {
    const st = useEditor.getState();
    const childrenBefore = page().children;
    const result = st.reskinToBrand({ palette: [BRAND_BLUE], fonts: [] });
    expect(result.colors.length).toBeGreaterThan(0);
    expect(page().background!.color.srgb).toEqual(BRAND_BLUE.srgb);
    expect(page().children[0].fills![0].color.srgb).toEqual({ ...BRAND_BLUE.srgb, a: 0.5 });
    expect(page().children).toBe(childrenBefore); // page identity untouched
    expect(useEditor.getState().undoStack.length).toBe(1);
    useEditor.getState().undo();
    expect(page().background!.color.srgb).toEqual(RED.srgb);
    expect(page().children[0].fills![0].color.srgb).toEqual({ ...RED.srgb, a: 0.5 });
  });

  it("a prior edit's undo survives a re-skin", () => {
    // The earlier edit's closure captured a page reference; a re-skin that
    // replaced doc.pages with clones would leave it mutating a dead object.
    const st = useEditor.getState();
    st.setPageBackground({ type: "solid", color: structuredClone(GREEN) } as never);
    st.reskinToBrand({ palette: [BRAND_BLUE], fonts: [] });
    useEditor.getState().undo(); // re-skin
    useEditor.getState().undo(); // background edit
    expect(page().background!.color.srgb).toEqual(RED.srgb);
  });

  it("an edit made after a re-skin survives an undo+redo round trip", () => {
    const st = useEditor.getState();
    st.reskinToBrand({ palette: [BRAND_BLUE], fonts: [] });
    useEditor.getState().setPageBackground({ type: "solid", color: structuredClone(GREEN) } as never);
    useEditor.getState().undo(); // background edit
    useEditor.getState().undo(); // re-skin
    expect(page().background!.color.srgb).toEqual(RED.srgb);
    useEditor.getState().redo(); // re-skin
    expect(page().background!.color.srgb).toEqual(BRAND_BLUE.srgb);
    useEditor.getState().redo(); // background edit
    expect(page().background!.color.srgb).toEqual(GREEN.srgb);
  });

  it("an on-brand document is untouched: no mutation, no undo entry", () => {
    const st = useEditor.getState();
    // Full alpha throughout: a semi-transparent red's hex carries the alpha
    // byte and legitimately maps to the opaque brand hex (same RGB), which is
    // reported as a remap - out of scope here.
    page().children[0].fills![0].color = c(1, 0, 0, 1);
    const childrenBefore = page().children;
    const bgBefore = page().background;
    const result = st.reskinToBrand({ palette: [RED], fonts: [] }); // already the nearest color
    expect(result.colors).toEqual([]);
    expect(page().children).toBe(childrenBefore);
    expect(page().background).toBe(bgBefore);
    expect(useEditor.getState().undoStack.length).toBe(0);
  });

  it("NODE identity survives undo and redo of a re-skin", () => {
    // Neighboring undo closures capture node references (page resize, sticky
    // text, find/replace); the snapshot restore must land INTO the existing
    // node objects, never replace them with clones.
    const st = useEditor.getState();
    const nodeBefore = page().children[0];
    st.reskinToBrand({ palette: [BRAND_BLUE], fonts: [] });
    expect(page().children[0]).toBe(nodeBefore); // in-place apply
    useEditor.getState().undo();
    expect(page().children[0]).toBe(nodeBefore); // undo restores into the node
    expect(page().children[0].fills![0].color.srgb).toEqual({ ...RED.srgb, a: 0.5 });
    useEditor.getState().redo();
    expect(page().children[0]).toBe(nodeBefore); // redo too
    expect(page().children[0].fills![0].color.srgb).toEqual({ ...BRAND_BLUE.srgb, a: 0.5 });
  });

  it("a recorded-but-inapplicable override leaves no dead history step", () => {
    // A malformed override hex is reported in the mapping but applies nothing;
    // the history must not gain an undo step that restores nothing.
    const st = useEditor.getState();
    page().children[0].fills![0].color = c(1, 0, 0, 1);
    const result = st.reskinToBrand({ palette: [BRAND_BLUE], fonts: [] }, { "#ff0000": "not-a-hex" });
    expect(result.colors).toEqual([{ from: "#ff0000", to: "not-a-hex" }]); // reported, per the mapping UI contract
    expect(page().background!.color.srgb).toEqual(RED.srgb); // nothing applied
    expect(useEditor.getState().undoStack.length).toBe(0); // no dead step
  });

  it("the overrides re-apply flow (undo then re-skin) still lands as one entry", () => {
    // BrandPanel's per-color override flow undoes the prior re-skin and
    // re-applies with overrides; the result must stay a single undo step
    // built from the ORIGINAL document.
    const st = useEditor.getState();
    page().children[0].fills![0].color = c(1, 0, 0, 1); // full alpha: one distinct source hex
    st.reskinToBrand({ palette: [BRAND_BLUE], fonts: [] });
    useEditor.getState().undo();
    const result = useEditor.getState().reskinToBrand({ palette: [BRAND_BLUE], fonts: [] }, { "#ff0000": "keep" });
    expect(result.colors).toEqual([]); // everything kept: nothing to remap
    expect(page().background!.color.srgb).toEqual(RED.srgb);
    expect(useEditor.getState().undoStack.length).toBe(0); // kept-everything = no entry
  });
});
