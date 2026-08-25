// Schema v24: Interaction.actionV2 (F28 completion C16) - newer interaction
// actions on a SEPARATE optional field with a plain-string kind, because
// widening the legacy action enum would break every older client's
// whole-file validation.

import { describe, expect, it } from "vitest";
import { createBlankDesign, createNode, currentSchemaVersion, InteractionSchema, migrate, validate, type Node } from "../index";

describe("migration to v24", () => {
  it("pins the exact version pair (see the Go twin in v24_test.go)", () => {
    // The paired EXACT pins are the cross-language drift alarm: a future bump
    // must update this line, the Go pin, and both currentSchemaVersion
    // mirrors in the SAME change (CLAUDE.md bump protocol). A >= assertion
    // would let the mirrors drift apart silently.
    expect(currentSchemaVersion).toBe(24);
  });

  it("is a pure no-op on a v23 document", () => {
    const before = { ...createBlankDesign(), schemaVersion: 23 } as Record<string, unknown>;
    const after = migrate(structuredClone(before) as never, 24) as unknown as Record<string, unknown>;
    expect(after.schemaVersion).toBe(24);
    expect({ ...after, schemaVersion: 23 }).toEqual(before);
  });
});

describe("v24 actionV2", () => {
  it("accepts ANY kind string, including ones no current runtime knows", () => {
    for (const kind of ["play-media", "toggle-media", "run-animation", "a-future-action"]) {
      const r = InteractionSchema.safeParse({ trigger: "click", action: { kind: "none" }, actionV2: { kind, targetNodeId: "n1" } });
      expect(r.success, kind).toBe(true);
    }
  });

  it("a document carrying actionV2 validates whole; the field stays optional", () => {
    const file = createBlankDesign();
    const node = createNode("shape", {
      shape: "rect",
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 10, height: 10 },
      fills: [],
    } as Partial<Node>);
    (node as unknown as { interaction: unknown }).interaction = {
      trigger: "click",
      action: { kind: "none" },
      actionV2: { kind: "toggle-media", targetNodeId: "vid-1" },
    };
    file.pages[0].children = [node];
    expect(validate(file).ok).toBe(true);
    (node as unknown as { interaction: unknown }).interaction = { trigger: "click", action: { kind: "none" } };
    expect(validate(file).ok).toBe(true);
  });
});
