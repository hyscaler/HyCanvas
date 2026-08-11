// The effect stack renders in order, and a disabled effect renders as nothing
// (F40 FR-17, AC-2).
//
// Order was already load-bearing before any of this: CSS filter functions
// compose left to right, so the array order has always decided the picture.
// What was missing was a way to change it and a way to switch one row off.
// These pin both, plus the two places a disabled effect could still leak into
// output through a reader that forgot to filter.

import { describe, expect, it } from "vitest";
import type { Effect, TextEffect } from "@hc/schema";
import { enabledTextEffects } from "@hc/schema";
import { effectsFilter, outlineSpecs, duotoneEffect } from "../effects";
import { effectBleed } from "../scene";
import type { Node } from "@hc/schema";

const blur = (radius: number): Effect => ({ kind: "blur", radius });
const bright = (value: number): Effect => ({ kind: "adjustment", ops: [{ name: "brightness", value }] });
const outline = (): Effect => ({ kind: "outline", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } }, width: 3 });

describe("order is the render order (AC-2)", () => {
  it("produces a different filter chain when two effects swap", () => {
    const a = effectsFilter([blur(4), bright(1.5)]);
    const b = effectsFilter([bright(1.5), blur(4)]);
    expect(a).not.toBe(b);
    // And specifically: each is the other reversed, not an arbitrary reshuffle.
    expect(a.split(" ").reverse().join(" ")).toBe(b);
  });
});

describe("a disabled effect renders as nothing", () => {
  it("is absent from the filter chain", () => {
    expect(effectsFilter([{ ...blur(4), enabled: false }])).toBe("none");
    expect(effectsFilter([blur(4), { ...bright(1.5), enabled: false }])).toBe("blur(4px)");
  });

  it("is absent from outline strokes", () => {
    expect(outlineSpecs([{ ...outline(), enabled: false }])).toEqual([]);
    expect(outlineSpecs([outline()])).toHaveLength(1);
  });

  it("is absent from the duotone lookup", () => {
    const duo = { kind: "duotone", shadow: { srgb: { r: 0, g: 0, b: 0, a: 1 } }, highlight: { srgb: { r: 1, g: 1, b: 1, a: 1 } }, intensity: 1 } as unknown as Effect;
    expect(duotoneEffect([duo])).toBeDefined();
    expect(duotoneEffect([{ ...duo, enabled: false }])).toBeUndefined();
  });

  it("stops reserving bounds bleed", () => {
    // A switched-off blur that still inflated bounds would leave a ring of
    // stale invalidation and culling slack around the node.
    const node = (effects: Effect[]) => ({ type: "shape", effects } as unknown as Node);
    expect(effectBleed(node([blur(10)]))).toBeGreaterThan(0);
    expect(effectBleed(node([{ ...blur(10), enabled: false }]))).toBe(0);
  });
});

describe("absent means enabled", () => {
  it("renders effects authored before the field existed", () => {
    // Every effect in every existing document omits `enabled`. If absent were
    // read as off, every shadow in every saved design would vanish on upgrade.
    expect(effectsFilter([blur(4)])).toBe("blur(4px)");
    expect(effectsFilter([{ ...blur(4), enabled: true }])).toBe("blur(4px)");
  });
});

describe("text effects take the same enable", () => {
  it("filters a disabled text effect", () => {
    // `NodeBase.effects` and `TextNode.textEffects` are stored apart to avoid a
    // name clash, but a user sees one idea. Giving only one of them an enable
    // would mean switching off a shadow works on a shape and silently does
    // nothing on a text node.
    const shadow = { kind: "shadow", dx: 1, dy: 1, blur: 2, opacity: 1,
      color: { type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } } } as unknown as TextEffect;
    expect(enabledTextEffects([shadow])).toHaveLength(1);
    expect(enabledTextEffects([{ ...shadow, enabled: false }])).toHaveLength(0);
    expect(enabledTextEffects([{ ...shadow, enabled: true }])).toHaveLength(1);
  });

  it("treats absent as enabled", () => {
    // Every text effect in every existing document omits the field.
    expect(enabledTextEffects(undefined)).toEqual([]);
    const e = { kind: "lift", intensity: 0.5 } as unknown as TextEffect;
    expect(enabledTextEffects([e])).toHaveLength(1);
  });
});
