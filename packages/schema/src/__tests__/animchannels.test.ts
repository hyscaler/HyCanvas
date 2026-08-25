// Schema v23: animation depth channels (F28 completion C11/C12/C13/C15) -
// Keyframe color/width/height, KeyframeTrack path/orient, AnimationClip
// spring parameters, and the NodeAnimation media trigger. All optional and
// additive.

import { describe, expect, it } from "vitest";
import { createBlankDesign, createNode, migrate, validate, type Node } from "../index";

describe("migration to v23", () => {
  // The exact version pin lives with the LATEST bump (interactions.test.ts),
  // so there is exactly one drift alarm per side at any time.

  it("is a pure no-op on a v22 document", () => {
    const before = { ...createBlankDesign(), schemaVersion: 22 } as Record<string, unknown>;
    const after = migrate(structuredClone(before) as never, 23) as unknown as Record<string, unknown>;
    expect(after.schemaVersion).toBe(23);
    expect({ ...after, schemaVersion: 22 }).toEqual(before);
  });
});

describe("v23 animation fields", () => {
  it("a document carrying every new field validates whole", () => {
    const file = createBlankDesign();
    const node = createNode("shape", {
      shape: "rect",
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 100, height: 100 },
      fills: [{ type: "solid", color: { srgb: { r: 1, g: 0, b: 0, a: 1 } } }],
    } as Partial<Node>);
    (node as unknown as { animation: unknown }).animation = {
      entrance: { preset: "fade", durationMs: 400, delayMs: 0, easing: "spring", spring: { stiffness: 14, damping: 0.5 } },
      custom: {
        durationMs: 2000,
        path: [{ x: 0, y: 0 }, { x: 200, y: -50 }, { x: 400, y: 0 }],
        orient: true,
        keyframes: [
          { t: 0, color: { srgb: { r: 1, g: 0, b: 0, a: 1 } }, width: 100, height: 100 },
          { t: 2000, color: { srgb: { r: 0, g: 0, b: 1, a: 1 } }, width: 200, height: 150 },
        ],
      },
      trigger: { mediaNodeId: "vid-1", atMs: 3000 },
    };
    file.pages[0].children = [node];
    const check = validate(file);
    expect(check.ok, "ok" in check && !check.ok ? `${check.pointer}: ${check.message}` : "").toBe(true);
  });

  it("all new fields stay optional: a bare animation still validates", () => {
    const file = createBlankDesign();
    const node = createNode("shape", {
      shape: "rect",
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 10, height: 10 },
      fills: [],
    } as Partial<Node>);
    (node as unknown as { animation: unknown }).animation = { entrance: { preset: "fade", durationMs: 300, delayMs: 0, easing: "ease-out" } };
    file.pages[0].children = [node];
    expect(validate(file).ok).toBe(true);
  });
});
