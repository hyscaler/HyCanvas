import { describe, it, expect } from "vitest";
import type { Template } from "../types";
import { rankMarketplace, templateFacets, isPublished } from "../marketplace";

function tpl(id: string, over: Partial<Template> = {}): Template {
  return {
    id, title: id, visibility: "public", ownerId: "u", workspaceId: null,
    categories: [], tags: [], style: { palette: [], typography: [] },
    format: { width: 1080, height: 1080, unit: "px" }, pageCount: 1, previewUrls: [],
    designFileKey: "k", fillableFields: [], attributions: [], version: 1,
    createdAt: "2026-01-01", updatedAt: "2026-01-01", ...over,
  };
}

const pub = (id: string, usageCount: number, updatedAt: string, over: Partial<Template> = {}) =>
  tpl(id, { updatedAt, marketplace: { status: "published", authorDisplayName: "A", usageCount, rewardEligible: false }, ...over });

describe("rankMarketplace", () => {
  const items = [
    pub("a", 10, "2026-02-01", { categories: ["social"], tags: ["sale"], style: { palette: [], typography: [], styleTags: ["bold"] } }),
    pub("b", 50, "2026-01-15", { categories: ["social"], tags: ["promo"], style: { palette: [], typography: [], styleTags: ["bold"] } }),
    pub("c", 5, "2026-03-01", { categories: ["print"], tags: ["sale"], style: { palette: [], typography: [], styleTags: ["minimal"] } }),
    tpl("draft", { marketplace: { status: "draft", authorDisplayName: "A", usageCount: 999, rewardEligible: false } }),
  ];

  it("lists only published templates", () => {
    expect(items.filter(isPublished).map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("popular sorts by usage count", () => {
    expect(rankMarketplace(items, "popular").map((t) => t.id)).toEqual(["b", "a", "c"]);
  });

  it("recent sorts by last update", () => {
    expect(rankMarketplace(items, "recent").map((t) => t.id)).toEqual(["c", "a", "b"]);
  });

  it("relevance preserves input order (already relevance-sorted)", () => {
    expect(rankMarketplace(items, "relevance").map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("excludes unpublished templates from ranking", () => {
    expect(rankMarketplace(items, "popular").map((t) => t.id)).not.toContain("draft");
  });
});

describe("templateFacets", () => {
  it("counts categories, tags, and styles over published templates", () => {
    const items = [
      pub("a", 1, "2026-01-01", { categories: ["social"], tags: ["sale"], style: { palette: [], typography: [], styleTags: ["bold"] } }),
      pub("b", 1, "2026-01-01", { categories: ["social"], tags: ["promo"], style: { palette: [], typography: [], styleTags: ["bold"] } }),
      pub("c", 1, "2026-01-01", { categories: ["print"], tags: ["sale"], style: { palette: [], typography: [], styleTags: ["minimal"] } }),
    ];
    const f = templateFacets(items);
    expect(f.categories).toEqual([{ value: "social", count: 2 }, { value: "print", count: 1 }]);
    expect(f.tags).toEqual([{ value: "sale", count: 2 }, { value: "promo", count: 1 }]);
    expect(f.styles).toEqual([{ value: "bold", count: 2 }, { value: "minimal", count: 1 }]);
  });
});
