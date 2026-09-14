// Schema v26: GridNode.masonry (#39) - pack a photo grid's images into columns
// sized to each image's own aspect ratio instead of a fixed row/column lattice.
//
// A FLAG on the existing grid node rather than a new node type or a new member
// of an existing enum. That choice is the thing worth testing: an older client
// must still open and render the file, laying the SAME cells out on its regular
// lattice. A different arrangement of the same images is a graceful fallback; a
// rejected file or an unrendered hole would not be.

import { describe, expect, it } from "vitest";
import { createBlankDesign, createNode, currentSchemaVersion, GridNodeSchema, migrate, validate, type Node } from "../index";

const grid = (extra: Record<string, unknown> = {}) =>
  createNode("grid", {
    rows: 2,
    cols: 2,
    gap: 8,
    cells: [
      { row: 0, col: 0, rowSpan: 1, colSpan: 1 },
      { row: 0, col: 1, rowSpan: 1, colSpan: 1 },
    ],
    children: [],
    ...extra,
  } as Partial<Node>);

describe("migration to v26", () => {
  it("pins the exact version pair (see the Go twin in v26_test.go)", () => {
    // The paired EXACT pins are the cross-language drift alarm: a future bump
    // must update this line, the Go pin, and both currentSchemaVersion mirrors
    // in the SAME change (CLAUDE.md bump protocol). A >= assertion would let
    // the mirrors drift apart silently.
    expect(currentSchemaVersion).toBe(26);
  });

  it("is a pure no-op on a v25 document", () => {
    // Purely additive: no existing node needs transforming, so the only change
    // is the stamp. Anything else would mean older files are being rewritten.
    const before = { ...createBlankDesign(), schemaVersion: 25 } as Record<string, unknown>;
    const after = migrate(structuredClone(before) as never, 26) as unknown as Record<string, unknown>;
    expect(after.schemaVersion).toBe(26);
    expect({ ...after, schemaVersion: 25 }).toEqual(before);
  });

  it("carries a v1 document all the way up without dropping its grid", () => {
    // The long path matters more than the single step: a self-hoster who skips
    // several releases migrates across every intermediate version at once.
    const old = { ...createBlankDesign(), schemaVersion: 1 } as Record<string, unknown>;
    (old.pages as { children: Node[] }[])[0].children = [grid() as Node];
    const after = migrate(structuredClone(old) as never, 26) as unknown as Record<string, unknown>;
    expect(after.schemaVersion).toBe(26);
    expect(((after.pages as { children: Node[] }[])[0].children[0] as Node).type).toBe("grid");
  });
});

describe("v26 masonry", () => {
  it("accepts a grid with no masonry flag, the shape every existing design has", () => {
    expect(GridNodeSchema.safeParse(grid()).success).toBe(true);
  });

  it("accepts the flag either way", () => {
    expect(GridNodeSchema.safeParse(grid({ masonry: true })).success).toBe(true);
    expect(GridNodeSchema.safeParse(grid({ masonry: false })).success).toBe(true);
  });

  it("rejects a non-boolean, so a stray value cannot reach the layout", () => {
    expect(GridNodeSchema.safeParse(grid({ masonry: "yes" })).success).toBe(false);
    expect(GridNodeSchema.safeParse(grid({ masonry: 1 })).success).toBe(false);
  });

  it("keeps the row/column lattice alongside the flag", () => {
    // This is what an older client lays out, so it has to stay valid and
    // authoritative rather than being cleared when masonry is switched on.
    const g = grid({ masonry: true }) as unknown as Record<string, unknown>;
    expect(g.rows).toBe(2);
    expect(g.cols).toBe(2);
    expect((g.cells as unknown[]).length).toBe(2);
  });

  it("coexists with track sizes rather than replacing them", () => {
    // Turning masonry off has to return the grid exactly as it was, so the
    // weights stay on the node while masonry ignores them.
    expect(GridNodeSchema.safeParse(grid({ masonry: true, colWidths: [2, 1], rowHeights: [1, 1] })).success).toBe(true);
  });

  it("validates a whole document carrying the flag, and one without it", () => {
    const file = createBlankDesign();
    file.pages[0].children = [grid({ masonry: true }) as Node];
    expect(validate(file).ok).toBe(true);
    file.pages[0].children = [grid() as Node];
    expect(validate(file).ok).toBe(true);
  });
});
