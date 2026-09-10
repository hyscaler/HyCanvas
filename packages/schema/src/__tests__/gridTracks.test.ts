// Schema v25: GridNode.colWidths / rowHeights (#40) - relative track sizes, so
// one cell can take more of a photo grid than its neighbours.
//
// They are OPTIONAL and mean "equal tracks" when absent, which is exactly how
// every grid laid out before they existed. That is what lets an older file open
// untouched and an older client keep rendering a newer file's grid sensibly
// rather than showing a hole.

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

describe("migration to v25", () => {
  it("pins the exact version pair (see the Go twin in v25_test.go)", () => {
    // The paired EXACT pins are the cross-language drift alarm: a future bump
    // must update this line, the Go pin, and both currentSchemaVersion mirrors
    // in the SAME change (CLAUDE.md bump protocol). A >= assertion would let
    // the mirrors drift apart silently.
    expect(currentSchemaVersion).toBe(25);
  });

  it("is a pure no-op on a v24 document", () => {
    // Purely additive: no existing node needs transforming, so the only change
    // is the stamp. Anything else here would mean older files are being rewritten.
    const before = { ...createBlankDesign(), schemaVersion: 24 } as Record<string, unknown>;
    const after = migrate(structuredClone(before) as never, 25) as unknown as Record<string, unknown>;
    expect(after.schemaVersion).toBe(25);
    expect({ ...after, schemaVersion: 24 }).toEqual(before);
  });
});

describe("v25 grid track sizes", () => {
  it("accepts a grid with no track sizes, the shape every existing design has", () => {
    expect(GridNodeSchema.safeParse(grid()).success).toBe(true);
  });

  it("accepts weights for either axis, or both", () => {
    expect(GridNodeSchema.safeParse(grid({ colWidths: [2, 1] })).success).toBe(true);
    expect(GridNodeSchema.safeParse(grid({ rowHeights: [1, 3] })).success).toBe(true);
    expect(GridNodeSchema.safeParse(grid({ colWidths: [2, 1], rowHeights: [1, 3] })).success).toBe(true);
  });

  it("rejects a weight that would collapse or invert a track", () => {
    // Unreachable from the UI, but this data can come from another client.
    expect(GridNodeSchema.safeParse(grid({ colWidths: [1, 0] })).success).toBe(false);
    expect(GridNodeSchema.safeParse(grid({ colWidths: [1, -1] })).success).toBe(false);
  });

  it("keeps a whole file valid with track sizes present", () => {
    const file = createBlankDesign();
    (file.pages[0].children as Node[]).push(grid({ colWidths: [3, 1] }));
    expect(validate(file).ok).toBe(true);
  });

  // The rule that matters for Zero Data Loss: a v24 client must still open a
  // v25 file. It can, because the grid's own schema branch treats the new keys
  // as unknown extras rather than a different node type.
  it("leaves a grid recognisable as a grid, not an unknown node", () => {
    const parsed = GridNodeSchema.safeParse(grid({ colWidths: [2, 1] }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.type).toBe("grid");
  });
});
