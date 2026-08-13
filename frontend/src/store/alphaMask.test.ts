// Background removal is non-destructive (schema v20).
//
// It used to overwrite `source` with the flattened cutout, so the original
// pixels left the document: the result could not be undone meaningfully and
// there was nothing left to refine. These pin the properties that make the
// difference, not the mechanism.

import { beforeEach, describe, expect, it } from "vitest";
import { useEditor } from "./editor";
import type { Node } from "@hc/schema";

function image(): Node {
  return {
    id: "img", type: "image",
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 100, height: 80 }, opacity: 1, blendMode: "normal",
    source: { assetId: "original", naturalWidth: 100, naturalHeight: 80 },
    fit: "cover",
  } as unknown as Node;
}

function node() {
  const st = useEditor.getState();
  return st.doc.pages[st.activePage].children.find((n) => n.id === "img") as unknown as {
    source: { assetId: string };
    alphaMask?: { assetId: string; width: number; height: number };
  };
}

beforeEach(() => {
  const st = useEditor.getState();
  const p = st.doc.pages[st.activePage];
  p.children.length = 0;
  p.children.push(image());
  useEditor.setState({ selection: ["img"], undoStack: [], redoStack: [] });
});

describe("attaching a mask", () => {
  it("leaves the original image untouched", () => {
    // The whole point: the photo stays, only its alpha is described.
    useEditor.getState().setImageAlphaMask("img", "blob:mask", 100, 80);
    expect(node().source.assetId).toBe("original");
    expect(node().alphaMask).toBeDefined();
    expect(node().alphaMask!.width).toBe(100);
  });

  it("registers the mask as a real document asset", () => {
    useEditor.getState().setImageAlphaMask("img", "blob:mask", 100, 80);
    const id = node().alphaMask!.assetId;
    expect(useEditor.getState().doc.assets.some((a) => a.id === id)).toBe(true);
  });

  it("is one undo step, and undo removes the asset too", () => {
    const before = useEditor.getState().doc.assets.length;
    useEditor.getState().setImageAlphaMask("img", "blob:mask", 100, 80);
    useEditor.getState().undo();
    expect(node().alphaMask).toBeUndefined();
    expect(node().source.assetId).toBe("original");
    // An orphaned asset per undone removal would accumulate in the document.
    expect(useEditor.getState().doc.assets).toHaveLength(before);
  });
});

describe("refining the mask (the brush's commit path)", () => {
  // The refinement brush commits each stroke as a fresh mask PNG through the
  // same setImageAlphaMask call. What matters is that a stroke is one undo
  // step, and that undoing it returns to the PREVIOUS mask, not to no mask.
  it("replaces the mask and leaves no orphaned asset behind on undo", () => {
    const st = useEditor.getState();
    st.setImageAlphaMask("img", "blob:mask-v1", 100, 80);
    const first = node().alphaMask!.assetId;
    const assetsAfterFirst = useEditor.getState().doc.assets.length;
    st.setImageAlphaMask("img", "blob:mask-v2", 100, 80);
    expect(node().alphaMask!.assetId).not.toBe(first);
    useEditor.getState().undo();
    expect(node().alphaMask?.assetId).toBe(first);
    expect(useEditor.getState().doc.assets).toHaveLength(assetsAfterFirst);
  });

  it("attaches a first mask to an image that never had one (brush from scratch)", () => {
    // The brush seeds opaque white when the node has no mask, so its first
    // commit is an ordinary attach; nothing about it may require a prior mask.
    useEditor.getState().setImageAlphaMask("img", "blob:painted", 64, 48);
    expect(node().alphaMask).toEqual(expect.objectContaining({ width: 64, height: 48 }));
    expect(node().source.assetId).toBe("original");
  });

  it("keeps redo working across a refine (undo/redo round trip)", () => {
    const st = useEditor.getState();
    st.setImageAlphaMask("img", "blob:mask-v1", 100, 80);
    st.setImageAlphaMask("img", "blob:mask-v2", 100, 80);
    const second = node().alphaMask!.assetId;
    useEditor.getState().undo();
    useEditor.getState().redo();
    expect(node().alphaMask?.assetId).toBe(second);
    expect(useEditor.getState().doc.assets.some((a) => a.id === second)).toBe(true);
  });
});

describe("restoring the background", () => {
  it("is a field clear, not a pixel operation", () => {
    const st = useEditor.getState();
    st.setImageAlphaMask("img", "blob:mask", 100, 80);
    st.setImageAlphaMask("img", null, 0, 0);
    expect(node().alphaMask).toBeUndefined();
    expect(node().source.assetId).toBe("original");
  });

  it("undoes back to the previous mask rather than to nothing", () => {
    const st = useEditor.getState();
    st.setImageAlphaMask("img", "blob:mask", 100, 80);
    const first = node().alphaMask!.assetId;
    st.setImageAlphaMask("img", null, 0, 0);
    useEditor.getState().undo();
    expect(node().alphaMask?.assetId).toBe(first);
  });
});

describe("guards", () => {
  it("ignores a locked node", () => {
    const st = useEditor.getState();
    (st.doc.pages[st.activePage].children[0] as unknown as { locked: boolean }).locked = true;
    st.setImageAlphaMask("img", "blob:mask", 100, 80);
    expect(node().alphaMask).toBeUndefined();
  });

  it("ignores a non-image node", () => {
    const st = useEditor.getState();
    st.doc.pages[st.activePage].children[0] = {
      id: "img", type: "shape", shape: "rect",
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 10, height: 10 }, opacity: 1, blendMode: "normal",
    } as unknown as Node;
    st.setImageAlphaMask("img", "blob:mask", 10, 10);
    expect((node() as unknown as { alphaMask?: unknown }).alphaMask).toBeUndefined();
  });
});
