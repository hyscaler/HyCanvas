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
  // The exact version pin lives with the LATEST bump (transitions.test.ts),
  // so there is exactly one drift alarm per side at any time.

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

describe("layout library expansion (F40 E09)", () => {
  it("ships 16 layouts with unique ids and unchanged originals", () => {
    const { layouts } = builtinMasterAndLayouts(PAGE);
    expect(layouts).toHaveLength(16);
    const ids = layouts.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The original five keep their ids AND their order (linked pages resolve
    // by id; generation fallbacks index layouts[0]).
    expect(ids.slice(0, 5)).toEqual([
      "layout-title", "layout-title-content", "layout-two-content", "layout-comparison", "layout-picture",
    ]);
    // Every placeholder rect stays inside the page.
    for (const l of layouts) {
      for (const ph of l.placeholders) {
        expect(ph.rect.x, `${l.id}/${ph.id} x`).toBeGreaterThanOrEqual(0);
        expect(ph.rect.y, `${l.id}/${ph.id} y`).toBeGreaterThanOrEqual(0);
        expect(ph.rect.x + ph.rect.width, `${l.id}/${ph.id} right`).toBeLessThanOrEqual(PAGE.width + 0.5);
        expect(ph.rect.y + ph.rect.height, `${l.id}/${ph.id} bottom`).toBeLessThanOrEqual(PAGE.height + 0.5);
      }
    }
    // No two placeholders inside one layout overlap (a slot fighting another
    // slot for the same area produces unreadable fills).
    for (const l of layouts) {
      const phs = l.placeholders;
      for (let i = 0; i < phs.length; i++) {
        for (let j = i + 1; j < phs.length; j++) {
          const a = phs[i].rect, b = phs[j].rect;
          const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
          expect(overlap, `${l.id}: ${phs[i].id} overlaps ${phs[j].id}`).toBe(false);
        }
      }
    }
  });
});
