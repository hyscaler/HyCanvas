import { describe, expect, it } from "vitest";
import { createBlankDesign, createNode, repairCornerRadius, validate } from "../index";
import type { GroupNode, ShapeNode } from "../schema";

function deckWithNumericRadius() {
  const file = createBlankDesign({ title: "legacy", width: 1920, height: 1080 });
  const rule = createNode("shape", { name: "Accent", shape: "rect" }) as ShapeNode;
  (rule as unknown as { cornerRadius: unknown }).cornerRadius = 4;
  const inner = createNode("shape", { name: "Panel", shape: "rect" }) as ShapeNode;
  (inner as unknown as { cornerRadius: unknown }).cornerRadius = 30;
  const group = createNode("group", { name: "Card", children: [inner] }) as GroupNode;
  const plain = createNode("shape", { name: "Square", shape: "rect" }) as ShapeNode;
  file.pages[0].children.push(rule, group, plain);
  return { file, rule, inner, plain };
}

describe("repairCornerRadius", () => {
  it("turns a bare-number radius into the per-corner record, through groups, and leaves the rest alone", () => {
    const { file, rule, inner, plain } = deckWithNumericRadius();
    expect(validate(file).ok).toBe(false);
    const out = repairCornerRadius(file);
    expect(out).toBe(file); // in place
    expect(rule.cornerRadius).toEqual({ topLeft: 4, topRight: 4, bottomRight: 4, bottomLeft: 4 });
    expect(inner.cornerRadius).toEqual({ topLeft: 30, topRight: 30, bottomRight: 30, bottomLeft: 30 });
    expect(plain.cornerRadius).toBeUndefined();
    expect(validate(file).ok).toBe(true);
  });

  it("is idempotent and keeps unknown keys on the node", () => {
    const { file, rule } = deckWithNumericRadius();
    (rule as unknown as { futureKey: string }).futureKey = "kept";
    repairCornerRadius(repairCornerRadius(file));
    expect(rule.cornerRadius).toEqual({ topLeft: 4, topRight: 4, bottomRight: 4, bottomLeft: 4 });
    expect((rule as unknown as { futureKey: string }).futureKey).toBe("kept");
  });
});
