import { describe, expect, it } from "vitest";
import type { SlideLayout } from "@hc/schema";
import {
  deriveLayoutContentSchema,
  layoutCatalogText,
  layoutSelectionSchema,
  preferredLayoutFor,
  repairLayoutSelection,
  normalizeLayoutFill,
  fillableRole,
} from "../index";

const L = (id: string, placeholders: SlideLayout["placeholders"]): SlideLayout => ({ id, masterId: "m", name: id, placeholders });
const ph = (id: string, role: string, extra: Record<string, unknown> = {}) =>
  ({ id, role, rect: { x: 0, y: 0, width: 100, height: 100 }, ...extra }) as SlideLayout["placeholders"][number];

const TITLE = L("layout-title", [ph("t", "title", { maxChars: 40, minChars: 20 }), ph("s", "body", { maxChars: 120 })]);
const CONTENT = L("layout-content", [ph("t", "title", { maxChars: 60 }), ph("c", "content", { maxChars: 400, minItems: 2, maxItems: 5 })]);
const PICTURE = L("layout-picture", [ph("t", "title"), ph("pic", "picture"), ph("cap", "body")]);
const ALL = [TITLE, CONTENT, PICTURE];

describe("deriveLayoutContentSchema", () => {
  it("walks fillable slots into required, capacity-bounded properties", () => {
    const s = deriveLayoutContentSchema(CONTENT) as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, { type: string; maxLength?: number; minItems?: number; maxItems?: number; items?: { maxLength: number } }>;
    };
    expect(s.required).toEqual(["t", "c"]);
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.t).toMatchObject({ type: "string", maxLength: 60 });
    expect(s.properties.c).toMatchObject({ type: "array", minItems: 2, maxItems: 5 });
    expect(s.properties.c.items!.maxLength).toBe(Math.max(40, Math.round(400 / 5)));
  });

  it("gives picture slots an English image-prompt string and skips footers", () => {
    const withFooter = L("x", [...PICTURE.placeholders, ph("f", "footer")]);
    const s = deriveLayoutContentSchema(withFooter) as { required: string[]; properties: Record<string, { description?: string }> };
    expect(s.required).toEqual(["t", "pic", "cap"]);
    expect(s.properties.pic.description).toContain("IN ENGLISH");
    expect(fillableRole("footer")).toBe(false);
  });

  it("defaults capacities when a slot carries none", () => {
    const bare = L("bare", [ph("t", "title"), ph("c", "content")]);
    const s = deriveLayoutContentSchema(bare) as { properties: Record<string, { maxLength?: number; maxItems?: number }> };
    expect(s.properties.t.maxLength).toBe(60);
    expect(s.properties.c.maxItems).toBe(6);
  });
});

describe("layout selection", () => {
  it("catalog lists id, name, and slot signature", () => {
    const text = layoutCatalogText(ALL);
    expect(text).toContain("- layout-content: layout-content (title+content)");
    expect(text).toContain("(title+picture+body)");
  });

  it("selection schema pins count and valid ids", () => {
    const s = layoutSelectionSchema(3, ["a", "b"]) as { properties: { layouts: { minItems: number; maxItems: number; items: { enum: string[] } } } };
    expect(s.properties.layouts.minItems).toBe(3);
    expect(s.properties.layouts.items.enum).toEqual(["a", "b"]);
  });

  it("repairs invalid ids deterministically by role preference", () => {
    const items = [{ visualRole: "cover" as const }, { visualRole: "content" as const }];
    const out = repairLayoutSelection(["nonsense", 42], items, ALL);
    expect(out).toEqual([preferredLayoutFor("cover", ALL), preferredLayoutFor("content", ALL)]);
    expect(out[0]).toBe("layout-title");
    expect(out[1]).toBe("layout-content");
  });

  it("repairs a wrong-length or non-array selection", () => {
    const items = [{ visualRole: "cover" as const }, { visualRole: "closing" as const }];
    expect(repairLayoutSelection(null, items, ALL)).toHaveLength(2);
    expect(repairLayoutSelection(["layout-title"], items, ALL)).toHaveLength(2);
  });

  it("breaks same-layout runs when an alternative suits the role (variety)", () => {
    const items = [{ visualRole: "content" as const }, { visualRole: "content" as const }];
    const twoContent = [CONTENT, L("layout-content-2", [ph("t", "title"), ph("c", "content")])];
    const out = repairLayoutSelection(["layout-content", "layout-content"], items, twoContent);
    expect(out[0]).not.toBe(out[1]);
  });

  it("allows repetition when no alternative exists", () => {
    const items = [{ visualRole: "content" as const }, { visualRole: "content" as const }];
    const out = repairLayoutSelection(["layout-content", "layout-content"], items, [CONTENT]);
    expect(out).toEqual(["layout-content", "layout-content"]);
  });
});

describe("normalizeLayoutFill", () => {
  it("clips to capacities, drops unknown keys, splits stray strings into lists", () => {
    const fill = normalizeLayoutFill(CONTENT, {
      t: "  A title that runs well past the sixty character ceiling set on this slot for sure  ",
      c: ["one", "", "two", "three", "four", "five", "six"],
      ghost: "dropped",
    });
    expect(fill.texts.t.length).toBeLessThanOrEqual(60);
    expect(fill.texts.t.endsWith(" ")).toBe(false);
    expect(fill.lists.c).toHaveLength(5); // maxItems
    expect("ghost" in fill.texts).toBe(false);
  });

  it("collects picture prompts separately", () => {
    const fill = normalizeLayoutFill(PICTURE, { t: "T", pic: "a lighthouse at dusk", cap: "Caption" });
    expect(fill.imagePrompts.pic).toBe("a lighthouse at dusk");
    expect(fill.texts.cap).toBe("Caption");
  });

  it("tolerates garbage without throwing", () => {
    expect(normalizeLayoutFill(CONTENT, null)).toEqual({ texts: {}, lists: {}, imagePrompts: {} });
    expect(normalizeLayoutFill(CONTENT, { c: 42 }).lists).toEqual({});
  });
});

describe("fallbackLayoutFill", () => {
  const item = { id: "i1", title: "Our Numbers", points: ["10k users", "92% retention", "3 markets", "NPS 61"], visualRole: "data" as const, note: "Slow down here." };

  it("routes title, splits points across content slots, prompts pictures", async () => {
    const { fallbackLayoutFill } = await import("../index");
    const two = L("two", [ph("t", "title"), ph("l", "content", { maxItems: 6 }), ph("r", "content", { maxItems: 6 })]);
    const fill = fallbackLayoutFill(two, item);
    expect(fill.texts.t).toBe("Our Numbers");
    expect(fill.lists.l).toEqual(["10k users", "92% retention"]);
    expect(fill.lists.r).toEqual(["3 markets", "NPS 61"]);

    const pic = fallbackLayoutFill(PICTURE, item);
    expect(pic.imagePrompts.pic).toContain("Our Numbers");
    expect(pic.texts.cap).toBe("10k users 92% retention 3 markets NPS 61");
  });

  it("never yields an unusable page for a pointless item", async () => {
    const { fallbackLayoutFill } = await import("../index");
    const fill = fallbackLayoutFill(TITLE, { id: "x", title: "Cover", points: [], visualRole: "cover" });
    expect(fill.texts.t).toBe("Cover");
  });
});
