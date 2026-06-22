import { describe, it, expect } from "vitest";
import { createBlankDesign, createNode, newId, type DesignFile, type FrameNode, type Node } from "@hc/schema";
import { extractRegion } from "../region";

function positioned(node: Node, x: number, y: number, w = 100, h = 100): Node {
  node.transform = { ...node.transform, x, y };
  node.size = { width: w, height: h };
  return node;
}

function designWith(nodes: Node[]): DesignFile {
  const d = createBlankDesign({ title: "Board" });
  d.pages[0].children = nodes;
  d.meta = { kind: "whiteboard" };
  return d;
}

describe("extractRegion", () => {
  it("does not mutate the input design", () => {
    const sticky = positioned(createNode("sticky", { id: newId(), text: "x" }), 50, 50);
    const design = designWith([sticky]);
    const before = JSON.stringify(design);
    extractRegion(design, { nodeIds: [sticky.id] });
    expect(JSON.stringify(design)).toBe(before);
  });

  it("nodeIds: one page, ids regenerated, coordinates localized to bounds", () => {
    const a = positioned(createNode("sticky", { id: newId(), text: "a" }), 100, 200, 80, 60);
    const b = positioned(createNode("sticky", { id: newId(), text: "b" }), 300, 200, 80, 60);
    const design = designWith([a, b]);

    const out = extractRegion(design, { nodeIds: [a.id, b.id] });
    expect(out.pages.length).toBe(1);
    const page = out.pages[0];
    expect(page.children.length).toBe(2);

    // ids regenerated (none match the originals)
    const origIds = new Set([a.id, b.id]);
    for (const c of page.children) expect(origIds.has(c.id)).toBe(false);

    // origin = union bounds (minX 100, minY 200). a localizes to (0,0).
    const localA = page.children.find((n) => (n as { text: string }).text === "a")!;
    expect(localA.transform.x).toBe(0);
    expect(localA.transform.y).toBe(0);
    const localB = page.children.find((n) => (n as { text: string }).text === "b")!;
    expect(localB.transform.x).toBe(200);
    expect(localB.transform.y).toBe(0);

    // page bounds = union width/height
    expect(page.width).toBe(280); // 380 - 100
    expect(page.height).toBe(60);
  });

  it("rect: includes intersecting nodes only", () => {
    const inside = positioned(createNode("sticky", { id: newId(), text: "in" }), 10, 10, 50, 50);
    const outside = positioned(createNode("sticky", { id: newId(), text: "out" }), 500, 500, 50, 50);
    const design = designWith([inside, outside]);

    const out = extractRegion(design, { rect: { x: 0, y: 0, width: 100, height: 100 } });
    expect(out.pages.length).toBe(1);
    expect(out.pages[0].children.length).toBe(1);
    expect((out.pages[0].children[0] as { text: string }).text).toBe("in");
  });

  it("frame with section sub-frames: one page per section", () => {
    const s1 = createNode("frame", { id: newId(), name: "Sec1", clip: false }) as FrameNode;
    positioned(s1, 0, 0, 200, 200);
    s1.children = [positioned(createNode("sticky", { id: newId(), text: "s1a" }), 10, 10, 40, 40)];

    const s2 = createNode("frame", { id: newId(), name: "Sec2", clip: false }) as FrameNode;
    positioned(s2, 300, 0, 200, 200);
    s2.children = [positioned(createNode("sticky", { id: newId(), text: "s2a" }), 320, 10, 40, 40)];

    const root = createNode("frame", { id: newId(), name: "Root", clip: false }) as FrameNode;
    positioned(root, 0, 0, 500, 200);
    root.children = [s1, s2];

    const design = designWith([root]);
    const out = extractRegion(design, { frameId: root.id });
    expect(out.pages.length).toBe(2);
    expect(out.pages[0].name).toBe("Sec1");
    expect(out.pages[1].name).toBe("Sec2");
    // section 2 sticky localized relative to s2 origin (300,0) -> (20,10)
    const s2child = out.pages[1].children[0];
    expect(s2child.transform.x).toBe(20);
    expect(s2child.transform.y).toBe(10);
  });

  it("plain frame: single page with the frame's children localized", () => {
    const frame = createNode("frame", { id: newId(), name: "Plain", clip: false }) as FrameNode;
    positioned(frame, 100, 100, 300, 300);
    frame.children = [positioned(createNode("sticky", { id: newId(), text: "child" }), 150, 150, 50, 50)];
    const design = designWith([frame]);

    const out = extractRegion(design, { frameId: frame.id });
    expect(out.pages.length).toBe(1);
    expect(out.pages[0].children.length).toBe(1);
    // child at (150,150) localized by frame origin (100,100) -> (50,50)
    expect(out.pages[0].children[0].transform.x).toBe(50);
    expect(out.pages[0].children[0].transform.y).toBe(50);
  });

  it("carries the target option into meta", () => {
    const a = positioned(createNode("sticky", { id: newId(), text: "a" }), 0, 0);
    const design = designWith([a]);
    const out = extractRegion(design, { nodeIds: [a.id] }, { target: "presentation" });
    expect(out.meta.extractedTarget).toBe("presentation");
    expect(out.meta.kind).toBe("whiteboard");
  });
});
