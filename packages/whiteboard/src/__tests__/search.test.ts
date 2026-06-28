import { describe, it, expect } from "vitest";
import { createNode } from "@hc/schema";
import type { Node } from "@hc/schema";
import { searchNodes, nodeSearchText } from "../search";

function sticky(id: string, text: string): Node {
  return createNode("sticky", { id, text } as Partial<Node>);
}

describe("nodeSearchText", () => {
  it("reads sticky text, connector label, frame name/header, and text runs", () => {
    expect(nodeSearchText(sticky("s", "Hello world"))).toBe("Hello world");
    expect(
      nodeSearchText(createNode("connector", { id: "c", label: { text: "approves" } } as Partial<Node>)),
    ).toBe("approves");
    expect(
      nodeSearchText(createNode("frame", { id: "f", name: "Ideas", header: { title: "Backlog" } } as Partial<Node>)),
    ).toBe("Ideas Backlog");
    const t = createNode("text", { id: "t" } as Partial<Node>);
    (t as unknown as { content: unknown }).content = [
      { runs: [{ text: "Quarterly " }, { text: "plan" }], style: {} },
    ];
    expect(nodeSearchText(t)).toBe("Quarterly plan");
    // Shapes carry no text.
    expect(nodeSearchText(createNode("shape", { id: "r", shape: "rect" } as Partial<Node>))).toBe("");
  });
});

describe("searchNodes", () => {
  it("matches case-insensitively in document order and descends into frames", () => {
    const frame = createNode("frame", { id: "f", name: "Risks", children: [sticky("inner", "data RISK here")] } as Partial<Node>);
    const nodes: Node[] = [sticky("a", "Apple"), sticky("b", "banana"), frame];
    const hits = searchNodes(nodes, "risk");
    // The frame ("Risks") and the nested sticky ("data RISK here") both match.
    expect(hits.map((h) => h.nodeId)).toEqual(["f", "inner"]);
    expect(hits[0].kind).toBe("frame");
    expect(hits[1].kind).toBe("sticky");
  });

  it("a blank query returns nothing; no match returns empty", () => {
    const nodes = [sticky("a", "Apple")];
    expect(searchNodes(nodes, "   ")).toEqual([]);
    expect(searchNodes(nodes, "zebra")).toEqual([]);
  });

  it("each node appears at most once", () => {
    const hits = searchNodes([sticky("a", "go go go")], "go");
    expect(hits).toHaveLength(1);
  });
});
