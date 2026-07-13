import { describe, it, expect } from "vitest";
import { createBlankDesign, createNode, type DesignFile, type Node } from "@hc/schema";
import { checkAccessibility } from "../index";

function image(id: string, extra: Record<string, unknown> = {}): Node {
  const n = createNode("image", {
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 40, height: 40 },
  } as unknown as Partial<Node>) as Node;
  (n as { id: string }).id = id;
  Object.assign(n as object, extra);
  return n;
}
function withImages(nodes: Node[]): DesignFile {
  const f = createBlankDesign({ title: "D", width: 200, height: 200 });
  f.pages[0].children = nodes;
  return f;
}

describe("alt-text check honors the v12 accessibility fields", () => {
  it("flags an undescribed image", () => {
    const issues = checkAccessibility(withImages([image("a")])).filter((i) => i.kind === "alt-text");
    expect(issues).toHaveLength(1);
  });

  it("accepts the generic altText, not just the legacy image alt", () => {
    const issues = checkAccessibility(withImages([image("a", { altText: "A cat" })])).filter((i) => i.kind === "alt-text");
    expect(issues).toHaveLength(0);
  });

  it("still accepts the legacy ImageNode.alt (older files)", () => {
    const issues = checkAccessibility(withImages([image("a", { alt: "legacy" })])).filter((i) => i.kind === "alt-text");
    expect(issues).toHaveLength(0);
  });

  it("skips a node marked decorative", () => {
    const issues = checkAccessibility(withImages([image("a", { decorative: true })])).filter((i) => i.kind === "alt-text");
    expect(issues).toHaveLength(0);
  });
});
