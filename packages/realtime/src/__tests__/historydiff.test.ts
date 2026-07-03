import { describe, it, expect } from "vitest";
import type { DesignFile } from "@hc/schema";
import { diffLabel } from "../historydiff";

// Minimal DesignFile builder: one page with the given nodes.
function design(nodes: Array<Record<string, unknown>>): DesignFile {
  return { schemaVersion: 10, pages: [{ id: "p1", children: nodes }] } as unknown as DesignFile;
}

function rect(id: string, x = 0, y = 0, w = 100, h = 100, extra: Record<string, unknown> = {}) {
  return { id, type: "shape", shape: "rect", transform: { x, y, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: w, height: h }, ...extra };
}

describe("diffLabel", () => {
  it("labels an added element", () => {
    const before = design([rect("a")]);
    const after = design([rect("a"), rect("b", 200, 0)]);
    expect(diffLabel(before, after)).toBe("Added 1 element");
  });

  it("labels deleted elements (plural)", () => {
    const before = design([rect("a"), rect("b"), rect("c")]);
    const after = design([rect("a")]);
    expect(diffLabel(before, after)).toBe("Deleted 2 elements");
  });

  it("labels a move (transform x/y change only)", () => {
    const before = design([rect("a", 0, 0)]);
    const after = design([rect("a", 50, 20)]);
    expect(diffLabel(before, after)).toBe("Moved 1 element");
  });

  it("labels a resize (size change takes priority over position)", () => {
    const before = design([rect("a", 0, 0, 100, 100)]);
    const after = design([rect("a", 0, 0, 160, 100)]);
    expect(diffLabel(before, after)).toBe("Resized 1 element");
  });

  it("labels a scale change as a resize (group/multi-select path)", () => {
    const before = design([rect("g", 0, 0, 100, 100, { transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 } })]);
    const after = design([rect("g", 0, 0, 100, 100, { transform: { x: 0, y: 0, scaleX: 2, scaleY: 2, rotation: 0 } })]);
    expect(diffLabel(before, after)).toBe("Resized 1 element");
  });

  it("labels a rotation distinctly from a move", () => {
    const before = design([rect("a", 0, 0, 100, 100, { transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 } })]);
    const after = design([rect("a", 0, 0, 100, 100, { transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 45 } })]);
    expect(diffLabel(before, after)).toBe("Rotated 1 element");
  });

  it("labels a content edit (fill change, same transform + size)", () => {
    const before = design([rect("a", 0, 0, 100, 100, { fills: [{ type: "solid", color: "#fff" }] })]);
    const after = design([rect("a", 0, 0, 100, 100, { fills: [{ type: "solid", color: "#000" }] })]);
    expect(diffLabel(before, after)).toBe("Edited 1 element");
  });

  it("enumerates a mix of change kinds in priority order", () => {
    const before = design([rect("a", 0, 0), rect("b", 100, 0)]);
    // a moves, c is added -> two different kinds (added listed before moved)
    const after = design([rect("a", 40, 0), rect("b", 100, 0), rect("c", 300, 0)]);
    expect(diffLabel(before, after)).toBe("Added 1, moved 1");
  });

  it("returns empty string when nothing node-level changed", () => {
    const before = design([rect("a")]);
    const after = design([rect("a")]);
    expect(diffLabel(before, after)).toBe("");
  });

  it("labels an added page when nodes are unchanged", () => {
    const before = { schemaVersion: 10, pages: [{ id: "p1", children: [] }] } as unknown as DesignFile;
    const after = { schemaVersion: 10, pages: [{ id: "p1", children: [] }, { id: "p2", children: [] }] } as unknown as DesignFile;
    expect(diffLabel(before, after)).toBe("Added 1 page");
  });

  it("labels a page rename", () => {
    const before = { schemaVersion: 10, pages: [{ id: "p1", name: "Page 1", width: 800, height: 600, children: [] }] } as unknown as DesignFile;
    const after = { schemaVersion: 10, pages: [{ id: "p1", name: "Cover", width: 800, height: 600, children: [] }] } as unknown as DesignFile;
    expect(diffLabel(before, after)).toBe("Renamed 1 page");
  });

  it("labels a page resize and a background change", () => {
    const base = { id: "p1", name: "P", width: 800, height: 600, children: [] as unknown[] };
    const resized = { schemaVersion: 10, pages: [{ ...base, width: 1080 }] } as unknown as DesignFile;
    const before = { schemaVersion: 10, pages: [base] } as unknown as DesignFile;
    expect(diffLabel(before, resized)).toBe("Resized 1 page");
    const recolored = { schemaVersion: 10, pages: [{ ...base, background: { type: "solid", color: "#eee" } }] } as unknown as DesignFile;
    expect(diffLabel(before, recolored)).toBe("Changed page background");
  });

  it("detects changes to nodes nested inside a group", () => {
    const group = (childX: number) => ({ id: "g", type: "group", transform: { x: 0, y: 0, rotation: 0 }, children: [rect("child", childX, 0)] });
    const before = design([group(0)]);
    const after = design([group(60)]);
    expect(diffLabel(before, after)).toBe("Moved 1 element");
  });
});
