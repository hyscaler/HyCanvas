// DiagramSpec normalization + Mermaid round-trip (doc 30 Phase 3).
import { describe, expect, it } from "vitest";
import { diagramToMermaid, mermaidToDiagram, normalizeDiagramSpec } from "../diagram";

describe("normalizeDiagramSpec", () => {
  it("keeps valid nodes/edges, drops junk, caps labels", () => {
    const spec = normalizeDiagramSpec({
      kind: "flowchart",
      nodes: [
        { id: "a", label: "Start" },
        { id: "a", label: "dupe" }, // duplicate id dropped
        { id: "", label: "no id" },
        { id: "b", label: "x".repeat(500) },
        { id: "c" }, // label falls back to id
      ],
      edges: [
        { from: "a", to: "b", label: "yes" },
        { from: "a", to: "a" }, // self loop dropped
        { from: "a", to: "ghost" }, // unknown target dropped
        { from: 1, to: "b" }, // junk dropped
      ],
    });
    expect(spec).not.toBeNull();
    expect(spec!.nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(spec!.nodes[1].label.length).toBe(120);
    expect(spec!.nodes[2].label).toBe("c");
    expect(spec!.edges).toEqual([{ from: "a", to: "b", label: "yes" }]);
  });

  it("rejects unusable input", () => {
    expect(normalizeDiagramSpec(null)).toBeNull();
    expect(normalizeDiagramSpec({ nodes: [] })).toBeNull();
    expect(normalizeDiagramSpec({ nodes: [{ id: "" }] })).toBeNull();
  });
});

describe("mermaid round-trip", () => {
  it("exports a flowchart and parses it back equivalently", () => {
    const spec = normalizeDiagramSpec({
      kind: "flowchart",
      direction: "right",
      nodes: [
        { id: "start", label: "Kick off" },
        { id: "review", label: "Design review" },
        { id: "ship", label: "Ship it" },
      ],
      edges: [
        { from: "start", to: "review" },
        { from: "review", to: "ship", label: "approved" },
      ],
    })!;
    const src = diagramToMermaid(spec);
    expect(src).toContain("flowchart LR");
    expect(src).toContain('start["Kick off"]');
    expect(src).toContain("review -->|approved| ship");

    const back = mermaidToDiagram(src);
    expect(back).not.toBeNull();
    expect(back!.direction).toBe("right");
    expect(back!.nodes.map((n) => n.label)).toEqual(["Kick off", "Design review", "Ship it"]);
    expect(back!.edges).toEqual([
      { from: "start", to: "review" },
      { from: "review", to: "ship", label: "approved" },
    ]);
  });

  it("parses hand-written mermaid with mixed shapes and semicolons", () => {
    const spec = mermaidToDiagram(`graph TD
      A[Plan] --> B(Build);
      B --> C{Test?}
      C -->|pass| D[Release]
      C -->|fail| B
      lonely[Unconnected]
    `);
    expect(spec).not.toBeNull();
    expect(spec!.nodes.map((n) => n.id)).toEqual(["A", "B", "C", "D", "lonely"]);
    expect(spec!.nodes[2].label).toBe("Test?");
    expect(spec!.edges).toHaveLength(4);
    expect(spec!.edges[1]).toEqual({ from: "B", to: "C" });
  });

  it("returns null for non-mermaid text (falls back to AI prompting)", () => {
    expect(mermaidToDiagram("draw me a flowchart of a coffee machine")).toBeNull();
    expect(mermaidToDiagram("")).toBeNull();
  });

  it("serializes a mindmap as an indented tree with cycle guard", () => {
    const spec = normalizeDiagramSpec({
      kind: "mindmap",
      nodes: [
        { id: "r", label: "Root" },
        { id: "k1", label: "Branch one" },
        { id: "k2", label: "Branch two" },
        { id: "k1a", label: "Leaf" },
      ],
      edges: [
        { from: "r", to: "k1" },
        { from: "r", to: "k2" },
        { from: "k1", to: "k1a" },
        { from: "k1a", to: "r" }, // cycle: guarded
      ],
    })!;
    const src = diagramToMermaid(spec);
    const lines = src.split("\n");
    expect(lines[0]).toBe("mindmap");
    expect(lines[1]).toBe("  Root");
    expect(lines).toContain("    Branch one");
    expect(lines).toContain("      Leaf");
  });
});

describe("label escaping", () => {
  it("keeps Mermaid parseable when labels contain its delimiters", () => {
    const spec = normalizeDiagramSpec({
      kind: "flowchart",
      nodes: [
        { id: "a", label: "Ship [v2] (beta)" },
        { id: "b", label: "Review {draft} | notes" },
      ],
      edges: [{ from: "a", to: "b", label: "then" }],
    });
    const mermaid = diagramToMermaid(spec);
    // Round-trips: the delimiters would otherwise end the token early and the
    // node or edge would be dropped on re-parse.
    const back = mermaidToDiagram(mermaid);
    expect(back.nodes).toHaveLength(2);
    expect(back.edges).toHaveLength(1);
    expect(back.nodes.map((n) => n.label)).toEqual(["Ship v2 beta", "Review draft notes"]);
  });

  it("falls back to the node id when a label escapes to nothing", () => {
    // Indentation IS the tree in a mindmap, so a blank line would orphan
    // everything under it.
    const spec = normalizeDiagramSpec({
      kind: "mindmap",
      nodes: [{ id: "root", label: "Roadmap (2026)" }, { id: "empty", label: "()" }, { id: "leaf", label: "Ship it" }],
      edges: [{ from: "root", to: "empty" }, { from: "empty", to: "leaf" }],
    });
    const mermaid = diagramToMermaid(spec);
    expect(mermaid.split("\n").some((l) => l.trim() === "")).toBe(false);
    expect(mermaid).toContain("empty");
  });
});
