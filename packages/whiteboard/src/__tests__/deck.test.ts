import { describe, it, expect } from "vitest";
import { createBlankDesign, createNode, newId, type DesignFile, type FrameNode, type Node } from "@hc/schema";
import { whiteboardToDeck } from "../deck";

function positioned(node: Node, x: number, y: number, w = 100, h = 100): Node {
  node.transform = { ...node.transform, x, y };
  node.size = { width: w, height: h };
  return node;
}

function frame(name: string, x: number, y: number, w: number, h: number, children: Node[]): FrameNode {
  const f = createNode("frame", { id: newId(), children, clip: true }) as FrameNode;
  f.name = name;
  f.transform = { ...f.transform, x, y };
  f.size = { width: w, height: h };
  return f;
}

function board(nodes: Node[]): DesignFile {
  const d = createBlankDesign({ title: "Board" });
  d.pages[0].children = nodes;
  d.meta = { kind: "whiteboard", whiteboard: { something: 1 } };
  return d;
}

describe("whiteboardToDeck", () => {
  it("makes one slide per top-level frame, sized to the slide", () => {
    const f1 = frame("Intro", 0, 0, 400, 300, [positioned(createNode("sticky", { id: newId(), text: "a" }), 20, 20)]);
    const f2 = frame("Body", 600, 0, 400, 300, [positioned(createNode("sticky", { id: newId(), text: "b" }), 40, 40)]);
    const deck = whiteboardToDeck(board([f1, f2]), { slideWidth: 1920, slideHeight: 1080 });

    expect(deck.pages.length).toBe(2);
    for (const page of deck.pages) {
      expect(page.width).toBe(1920);
      expect(page.height).toBe(1080);
      expect(page.background).toBeDefined();
    }
  });

  it("fills a hand-drawn section's slide with the nodes spatially inside it", () => {
    // Empty frame (no children) at (0,0,400,300) with two stickies dropped inside
    // and one well outside. Spatial containment should capture only the two.
    const f = frame("Ideas", 0, 0, 400, 300, []);
    const inA = positioned(createNode("sticky", { id: newId(), text: "a" }), 40, 40, 80, 80);
    const inB = positioned(createNode("sticky", { id: newId(), text: "b" }), 220, 160, 80, 80);
    const outside = positioned(createNode("sticky", { id: newId(), text: "c" }), 900, 40, 80, 80);
    const deck = whiteboardToDeck(board([f, inA, inB, outside]));
    expect(deck.pages.length).toBe(1);
    expect(deck.pages[0].children.length).toBe(2); // only the two inside the section
  });

  it("drops the whiteboard surface kind so it opens as a presentation", () => {
    const deck = whiteboardToDeck(board([positioned(createNode("sticky", { id: newId(), text: "x" }), 10, 10)]));
    expect((deck.meta as Record<string, unknown>).kind).toBeUndefined();
    expect((deck.meta as Record<string, unknown>).whiteboard).toBeUndefined();
  });

  it("falls back to a single slide when there are no frames", () => {
    const deck = whiteboardToDeck(
      board([
        positioned(createNode("sticky", { id: newId(), text: "a" }), 0, 0, 100, 100),
        positioned(createNode("sticky", { id: newId(), text: "b" }), 500, 300, 100, 100),
      ]),
    );
    expect(deck.pages.length).toBe(1);
    expect(deck.pages[0].children.length).toBe(2);
  });

  it("does not mutate the source design", () => {
    const src = board([frame("F", 0, 0, 200, 200, [positioned(createNode("sticky", { id: newId(), text: "a" }), 10, 10)])]);
    const before = JSON.stringify(src);
    whiteboardToDeck(src);
    expect(JSON.stringify(src)).toBe(before);
  });
});
