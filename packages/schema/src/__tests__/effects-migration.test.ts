import { describe, it, expect } from "vitest";
import { createBlankDesign } from "../factory";
import { migrate } from "../migrate";
import { validate } from "../validate";
import { CURRENT_SCHEMA_VERSION, type DesignFile } from "../schema";

/** A v13 file carrying the two legacy effect shapes the v14 step normalizes:
 *  a node shadow written without a type (early panels) and a text shadow whose
 *  opacity knob was never rendered. */
function legacyV13(): DesignFile {
  const file = createBlankDesign({ title: "Old", width: 800, height: 600 });
  const page = file.pages[0] as unknown as { children: unknown[] };
  page.children.push(
    {
      id: "r1", type: "shape", shape: "rect",
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 100, height: 100 }, opacity: 1, blendMode: "normal",
      fills: [{ type: "solid", color: { srgb: { r: 1, g: 1, b: 1, a: 1 } } }],
      effects: [{ kind: "shadow", color: { srgb: { r: 0, g: 0, b: 0, a: 0.35 } }, offsetX: 0, offsetY: 4, blur: 6, spread: 0 }],
    },
    {
      id: "g1", type: "group",
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      size: { width: 200, height: 100 }, opacity: 1, blendMode: "normal",
      children: [{
        id: "t1", type: "text",
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        size: { width: 200, height: 40 }, opacity: 1, blendMode: "normal",
        box: { mode: "fixed", width: 200, height: 40, autoFit: { enabled: false, min: 8, max: 512 }, verticalAlign: "top" },
        content: [{ runs: [{ text: "Hi", style: { fontFamily: "Inter", fontStyle: "Regular", fontSize: 20, fill: { type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } } } }], style: { align: "left", direction: "auto" } }],
        textEffects: [{ kind: "shadow", dx: 4, dy: 4, blur: 6, color: { type: "solid", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } } }, opacity: 0.4 }],
      }],
    },
  );
  return { ...file, schemaVersion: 13 } as DesignFile;
}

describe("v13 -> v14 effect normalization", () => {
  it("stamps typeless node shadows as drop and bakes text-shadow opacity to 1", () => {
    const migrated = migrate(legacyV13() as unknown as DesignFile);
    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    const rect = migrated.pages[0].children[0] as unknown as { effects: { type?: string }[] };
    expect(rect.effects[0].type).toBe("drop");
    const text = (migrated.pages[0].children[1] as unknown as { children: { textEffects: { opacity: number }[] }[] }).children[0];
    // opacity was never rendered, so 1 is the value users actually saw.
    expect(text.textEffects[0].opacity).toBe(1);
    expect(validate(migrated).ok).toBe(true);
  });

  it("is idempotent and leaves already-typed shadows alone", () => {
    const once = migrate(legacyV13() as unknown as DesignFile);
    const twice = migrate(JSON.parse(JSON.stringify(once)) as DesignFile);
    expect(twice).toEqual(once);
    const inner = { kind: "shadow", type: "inner", color: { srgb: { r: 0, g: 0, b: 0, a: 1 } }, offsetX: 0, offsetY: 2, blur: 4, spread: 0 };
    const f = legacyV13();
    (f.pages[0].children[0] as unknown as { effects: unknown[] }).effects = [inner];
    const m = migrate(f as unknown as DesignFile);
    expect((m.pages[0].children[0] as unknown as { effects: { type?: string }[] }).effects[0].type).toBe("inner");
  });

  it("still validates a typeless shadow that reaches validation unmigrated", () => {
    // Defensive widening: files written by the buggy panel exist in the wild.
    const res = validate(migrate(legacyV13() as unknown as DesignFile));
    expect(res.ok).toBe(true);
  });
});
