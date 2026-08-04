// "Set as background" / "Detach from background" / adjust for image nodes.
// The background is a regular image node reshaped to a PAGE-SIZED box at
// scale 1 with fit "cover" (the same model as every other image box, and the
// shape the crop overlay requires), sent to the back of the stack, and
// locked; the pre-background transform/size/fit and z-index are saved under
// `data.backgroundRestore` so detach (and undo) put the image back exactly
// where it was. A hand-built background (locked, bottom-of-stack,
// page-covering image with no flag) must be recognized too, and detach then
// simply unlocks it in place. While locked, the background stays adjustable:
// setImageCrop must accept it (the crop overlay is its edit surface).

import { describe, it, expect, beforeEach } from "vitest";
import { createBlankDesign, createNode, type ImageNode, type Node, type Transform } from "@hc/schema";
import { useEditor } from "./editor";

const PAGE_W = 800;
const PAGE_H = 600;

const IMG_TRANSFORM: Transform = { x: 100, y: 50, scaleX: 1, scaleY: 1, rotation: 0 };
const IMG_SIZE = { width: 400, height: 400 };

function loadDocWith(nodes: Node[]) {
  const doc = createBlankDesign({ title: "t", width: PAGE_W, height: PAGE_H });
  doc.pages[0].children.push(...nodes);
  useEditor.getState().loadDoc(doc);
}

function image(id: string, init?: Partial<Node>) {
  return createNode("image", {
    id,
    transform: { ...IMG_TRANSFORM },
    size: { ...IMG_SIZE },
    source: { assetId: `asset-${id}`, naturalWidth: 400, naturalHeight: 400 },
    fit: "cover",
    ...init,
  });
}

const kids = () => useEditor.getState().doc.pages[0].children;
const node = (id: string) => kids().find((n) => n.id === id)! as ImageNode;

describe("set image as page background", () => {
  beforeEach(() => loadDocWith([createNode("shape", { id: "shape" }), image("img")]));

  it("reshapes to a page-sized cover box, moves to the back, locks, and flags", () => {
    useEditor.getState().setImageAsBackground("img");
    expect(kids().map((n) => n.id)).toEqual(["img", "shape"]);
    const img = node("img");
    expect(img.locked).toBe(true);
    expect((img.data as { background?: boolean }).background).toBe(true);
    // Page-sized box at scale 1 (adjustable by the crop overlay), source covering.
    expect(img.size).toEqual({ width: PAGE_W, height: PAGE_H });
    expect(img.transform).toEqual({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 });
    expect(img.fit).toBe("cover");
    expect(useEditor.getState().isBackgroundImage("img")).toBe(true);
  });

  it("keeps a horizontal flip while spanning the page exactly", () => {
    node("img").transform.scaleX = -1;
    useEditor.getState().setImageAsBackground("img");
    const t = node("img").transform;
    expect(t.scaleX).toBe(-1);
    // Box spans x + scaleX*w .. x = 0 .. 800: still exactly the page.
    expect(t.x).toBe(PAGE_W);
    expect(t.x + t.scaleX * node("img").size.width).toBe(0);
  });

  it("detach restores the saved transform, size, stack position, and lock state", () => {
    useEditor.getState().setImageAsBackground("img");
    useEditor.getState().detachImageBackground("img");
    expect(kids().map((n) => n.id)).toEqual(["shape", "img"]);
    const img = node("img");
    expect(img.locked).toBe(false);
    expect(img.transform).toEqual(IMG_TRANSFORM);
    expect(img.size).toEqual(IMG_SIZE);
    expect(img.data).toBeUndefined();
    expect(useEditor.getState().isBackgroundImage("img")).toBe(false);
  });

  it("set is a single undo step restoring transform, size, order, and data", () => {
    useEditor.getState().setImageAsBackground("img");
    useEditor.getState().undo();
    expect(kids().map((n) => n.id)).toEqual(["shape", "img"]);
    const img = node("img");
    expect(img.locked).toBe(false);
    expect(img.transform).toEqual(IMG_TRANSFORM);
    expect(img.size).toEqual(IMG_SIZE);
    expect(img.data).toBeUndefined();
  });

  it("setting a new background detaches and restores the previous one", () => {
    loadDocWith([createNode("shape", { id: "shape" }), image("a"), image("b")]);
    useEditor.getState().setImageAsBackground("a");
    useEditor.getState().setImageAsBackground("b");
    expect(kids()[0].id).toBe("b");
    expect(useEditor.getState().isBackgroundImage("b")).toBe(true);
    // The old background popped back to its pre-background spot, unlocked.
    const a = node("a");
    expect(a.locked).toBe(false);
    expect(a.transform).toEqual(IMG_TRANSFORM);
    expect(a.size).toEqual(IMG_SIZE);
    expect(useEditor.getState().isBackgroundImage("a")).toBe(false);
    expect(kids().map((n) => n.id)).toEqual(["b", "shape", "a"]);
  });
});

describe("adjusting the background image", () => {
  beforeEach(() => loadDocWith([createNode("shape", { id: "shape" }), image("img")]));

  it("setImageCrop applies to the locked background (the adjust path)", () => {
    useEditor.getState().setImageAsBackground("img");
    useEditor.getState().setImageCrop("img", { x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
    const img = node("img");
    expect(img.crop).toEqual({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
    expect(img.fit).toBe("cover");
    // Adjusting never unlocks or unflags the background.
    expect(img.locked).toBe(true);
    expect(useEditor.getState().isBackgroundImage("img")).toBe(true);
  });

  it("setImageCrop still refuses a plain locked image", () => {
    node("img").locked = true;
    useEditor.getState().setImageCrop("img", { x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
    expect(node("img").crop).toBeUndefined();
  });

  it("detach keeps an applied crop (it is image content, not background state)", () => {
    useEditor.getState().setImageAsBackground("img");
    useEditor.getState().setImageCrop("img", { x: 0, y: 0, width: 0.5, height: 0.5 });
    useEditor.getState().detachImageBackground("img");
    const img = node("img");
    expect(img.crop).toEqual({ x: 0, y: 0, width: 0.5, height: 0.5 });
    expect(img.size).toEqual(IMG_SIZE);
  });
});

describe("hand-built background (no flag)", () => {
  beforeEach(() =>
    loadDocWith([
      image("bg", {
        locked: true,
        transform: { x: 0, y: -100, scaleX: 2, scaleY: 2, rotation: 0 },
      }),
      createNode("shape", { id: "shape" }),
    ]),
  );

  it("is recognized when locked, bottom-of-stack, and page-covering", () => {
    expect(useEditor.getState().isBackgroundImage("bg")).toBe(true);
    expect(useEditor.getState().isBackgroundImage("shape")).toBe(false);
  });

  it("detach unlocks it in place (nothing saved to restore)", () => {
    useEditor.getState().detachImageBackground("bg");
    const bg = node("bg");
    expect(bg.locked).toBe(false);
    expect(kids()[0].id).toBe("bg");
    expect(bg.transform.scaleX).toBe(2);
    expect(useEditor.getState().isBackgroundImage("bg")).toBe(false);
  });
});
