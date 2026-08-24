// Placeholder capacity hints (schema v21, F28 T11): optional maxChars/minChars
// and, for list-capable roles, minItems/maxItems, telling layout-grounded
// generation how much text a slot comfortably holds. Rendering never reads
// them, so their presence or absence cannot change how a document draws.

import { describe, expect, it } from "vitest";
import { currentSchemaVersion, PlaceholderSchema } from "../schema";
import { builtinMasterAndLayouts, capacityForPlaceholder } from "../theme";
import { migrate } from "../migrate";
import { validate } from "../validate";
import { createBlankDesign } from "../factory";

const PAGE = { width: 1920, height: 1080 };

describe("the fields are additive", () => {
  const base = { id: "ph", role: "content", rect: { x: 0, y: 0, width: 100, height: 100 } };

  it("accepts a placeholder with no capacities, exactly as before", () => {
    expect(PlaceholderSchema.safeParse(base).success).toBe(true);
  });

  it("accepts full capacities", () => {
    const r = PlaceholderSchema.safeParse({ ...base, maxChars: 400, minChars: 200, minItems: 2, maxItems: 6 });
    expect(r.success).toBe(true);
  });

  it("refuses non-integers and non-positive ceilings", () => {
    expect(PlaceholderSchema.safeParse({ ...base, maxChars: 10.5 }).success).toBe(false);
    expect(PlaceholderSchema.safeParse({ ...base, maxChars: 0 }).success).toBe(false);
    expect(PlaceholderSchema.safeParse({ ...base, maxItems: -1 }).success).toBe(false);
  });
});

describe("migration to v21", () => {
  it("is a pure no-op on a v20 document", () => {
    const before = { ...createBlankDesign(), schemaVersion: 20 } as Record<string, unknown>;
    const after = migrate(structuredClone(before) as never, 21) as unknown as Record<string, unknown>;
    expect(after.schemaVersion).toBe(21);
    expect({ ...after, schemaVersion: 20 }).toEqual(before);
  });

  it("is idempotent", () => {
    const once = migrate({ ...createBlankDesign(), schemaVersion: 20 } as never, 21);
    const twice = migrate(structuredClone(once) as never, 21);
    expect(twice).toEqual(once);
  });

  it("a migrated older file validates at the current version", () => {
    const d = migrate({ ...createBlankDesign(), schemaVersion: 20 } as never, currentSchemaVersion);
    expect(validate(d).ok).toBe(true);
  });

  it("preserves unknown keys on placeholders (a newer client's extras survive)", () => {
    const d = createBlankDesign() as unknown as Record<string, unknown>;
    d.schemaVersion = 20;
    d.layouts = [{
      id: "l1", masterId: "m1", name: "X",
      placeholders: [{ id: "p1", role: "title", rect: { x: 0, y: 0, width: 10, height: 10 }, futureKey: "kept" }],
    }];
    const after = migrate(structuredClone(d) as never, 21) as unknown as {
      layouts: { placeholders: Record<string, unknown>[] }[];
    };
    expect(after.layouts[0].placeholders[0].futureKey).toBe("kept");
  });
});

describe("capacityForPlaceholder", () => {
  it("derives sane headline and body capacities from the rect", () => {
    const title = capacityForPlaceholder("title", { width: PAGE.width * 0.8, height: PAGE.height * 0.18 }, PAGE);
    expect(title.maxChars).toBeGreaterThanOrEqual(20);
    expect(title.maxChars).toBeLessThanOrEqual(60);
    // The floor is about half the ceiling (the reference invariant).
    expect(title.minChars).toBe(Math.round(title.maxChars! / 2));

    const half = capacityForPlaceholder("content", { width: PAGE.width * 0.42, height: PAGE.height * 0.6 }, PAGE);
    const full = capacityForPlaceholder("content", { width: PAGE.width * 0.88, height: PAGE.height * 0.6 }, PAGE);
    expect(half.maxChars!).toBeLessThan(full.maxChars!);
    expect(half.minItems).toBe(2);
    expect(half.maxItems!).toBeGreaterThanOrEqual(3);
  });

  it("gives non-text roles no capacity", () => {
    expect(capacityForPlaceholder("picture", { width: 500, height: 500 }, PAGE)).toEqual({});
    expect(capacityForPlaceholder("footer", { width: 500, height: 50 }, PAGE)).toEqual({});
  });
});

describe("built-in layouts carry capacities", () => {
  it("every text-capable built-in placeholder is capped and consistent", () => {
    const { layouts } = builtinMasterAndLayouts(PAGE);
    expect(layouts.length).toBeGreaterThanOrEqual(5);
    for (const layout of layouts) {
      for (const ph of layout.placeholders) {
        expect(PlaceholderSchema.safeParse(ph).success).toBe(true);
        if (ph.role === "title" || ph.role === "body" || ph.role === "content") {
          expect(ph.maxChars, `${layout.id}/${ph.id}`).toBeGreaterThan(0);
          expect(ph.minChars!).toBeLessThanOrEqual(ph.maxChars!);
        }
        if (ph.role === "content") {
          expect(ph.minItems!).toBeLessThanOrEqual(ph.maxItems!);
        }
      }
    }
  });
});
