// Per-slide regeneration for a composed deck: one page set again through
// the kit that set its siblings, from the item the page kept or, on a deck
// from before the recipe, from the style read off the page's own ornament.

import { describe, expect, it } from "vitest";
import { layoutDeck, type DeckResult } from "../deck";
import { normalizeOutline, type OutlineItem } from "../outline";
import { deckThemes } from "../theme";
import { themeRecordFromDesignSystem } from "../compose";
import { deckRecipeOf, isComposedSlide, recomposeSlide, reviseSlideItem, slideItemOf, slideTextDump } from "../recompose";

type N = { name?: string; type: string; content?: { runs: { text: string }[] }[]; data?: Record<string, unknown> };

const outline = normalizeOutline({
  title: "Northwind coffee: the year in beans",
  theme: "warm, candid",
  style: "campfire",
  organization: "Northwind Roasters",
  kicker: "Twelve months, one roast at a time",
  farewell: "See you at the next cupping",
  pages: [
    { title: "The year in beans", archetype: "cover", subhead: "What we roasted and what we learned.", note: "n" },
    { title: "Three things the year proved", archetype: "bullets", eyebrow: "What we learned", points: ["Regulars carry the shop: sixty percent of cups go to people we know.", "Mornings are won by seven.", "Pastry sells coffee: the case lifted the ticket by a dollar."], note: "n" },
    { title: "The year in four numbers", archetype: "kpiGrid", eyebrow: "Results", stats: [{ value: "$4.8M", label: "Revenue" }, { value: "62%", label: "Return within 30 days" }, { value: "4", label: "Shops open" }], note: "n" },
    { title: "Come to the cupping", archetype: "closing", subhead: "The first Saturday of every month.", note: "n" },
  ],
});
const size = { width: 1920, height: 1080 };
const seed = 7;
const brandPalette = ["#7B1FA2", "#00897B"];
const theme = deckThemes({ brandPalette, kicker: outline.title, count: 1, seed })[0];
const deck = layoutDeck(outline, theme, size, { renderer: "kit", designType: "deck", seed, brandPalette, fontsAuthored: false });

const names = (nodes: N[]): string[] => nodes.map((n) => n.name ?? "");
const texts = (nodes: N[]): string[] => nodes.flatMap((n) => (n.content ?? []).flatMap((p) => p.runs.map((r) => r.text)));

/** The file the editor holds after the deck landed: with the recipe and the
 *  per-page items (a deck set today), or without (one set before them). */
function docOf(d: DeckResult, kept: boolean) {
  return {
    title: d.title,
    theme: themeRecordFromDesignSystem(d.system, theme, outline.theme),
    meta: kept && d.recipe ? { aiDeck: d.recipe } : {},
    pages: d.pages.map((p) => ({ width: size.width, height: size.height, children: p.nodes as unknown[], notes: p.note, ...(kept && p.item ? { data: { aiOutline: p.item } } : {}) })),
  };
}

describe("the deck keeps what setting one page again needs", () => {
  it("records the kit style, the voice and the item per page", () => {
    expect(deck.recipe).toMatchObject({ renderer: "kit", style: "campfire", organization: "Northwind Roasters", kicker: "Twelve months, one roast at a time", designType: "deck", themeSlots: null });
    expect(deck.pages.map((p) => p.item?.title)).toEqual(outline.pages.map((p) => p.title));
    expect(deckRecipeOf(docOf(deck, true).meta)?.style).toBe("campfire");
    expect(deckRecipeOf({})).toBeNull();
  });

  it("tells a composed page from a layout-linked one", () => {
    const doc = docOf(deck, false);
    expect(doc.pages.every((p) => isComposedSlide(p))).toBe(true);
    const linked = { children: [{ type: "text", name: "Title", data: { placeholderId: "title" }, content: [] }], layoutId: "layout-title" };
    expect(isComposedSlide(linked)).toBe(false);
    const detached = { children: [{ type: "text", name: "Title", data: { placeholderId: "title" }, content: [] }, { type: "shape", name: "Decor" }] };
    expect(isComposedSlide(detached)).toBe(false);
  });

  it("reads the item back off the page, and dumps the text when there is none", () => {
    const doc = docOf(deck, true);
    expect(slideItemOf(doc.pages[1])?.points).toHaveLength(3);
    expect(slideItemOf(docOf(deck, false).pages[1])).toBeNull();
    const dump = slideTextDump(docOf(deck, false).pages[1]);
    expect(dump).toContain("Title: Three things the year proved");
    expect(dump).toContain("Mornings are won by seven.");
    expect(dump).not.toContain("Page number");
    expect(dump).not.toMatch(/Footer:/);
  });
});

describe("recomposeSlide", () => {
  it("sets a page again from its own item and gets the same page back", () => {
    const doc = docOf(deck, true);
    const again = recomposeSlide({ doc, pageIndex: 1, item: deck.pages[1].item!, brandPalette });
    expect(again).not.toBeNull();
    expect(again!.style).toBe("campfire");
    expect(names(again!.nodes as N[])).toEqual(names(deck.pages[1].nodes as N[]));
    expect(texts(again!.nodes as N[])).toEqual(texts(deck.pages[1].nodes as N[]));
    expect(again!.background).toEqual(deck.pages[1].background);
  });

  it("sets the revised item, in the same system, with the deck's furniture", () => {
    const doc = docOf(deck, true);
    const revised: OutlineItem = { ...deck.pages[1].item!, title: "Two things the year proved", points: ["Regulars carry the shop.", "Mornings are won by seven."] };
    const again = recomposeSlide({ doc, pageIndex: 1, item: revised, brandPalette })!;
    const t = texts(again.nodes as N[]);
    expect(t).toContain("Two things the year proved");
    expect(t).not.toContain("Three things the year proved");
    expect(t.some((s) => s.includes("Pastry sells coffee"))).toBe(false);
    // The footer and page number the kit sets on every reading page.
    expect(t).toContain("02 / 4");
    expect(t.some((s) => s.includes("Northwind Roasters"))).toBe(true);
  });

  it("recovers the style from the page's ornament on a deck from before the recipe", () => {
    const doc = docOf(deck, false);
    const again = recomposeSlide({ doc, pageIndex: 1, item: deck.pages[1].item!, brandPalette })!;
    expect(again.style).toBe("campfire");
    expect(names(again.nodes as N[])).toEqual(names(deck.pages[1].nodes as N[]));
    const cover = recomposeSlide({ doc, pageIndex: 0, item: deck.pages[0].item!, brandPalette })!;
    expect(cover.style).toBe("campfire");
    expect(texts(cover.nodes as N[])).toEqual(texts(deck.pages[0].nodes as N[]));
  });

  it("returns null for a page that does not exist", () => {
    expect(recomposeSlide({ doc: docOf(deck, true), pageIndex: 9, item: deck.pages[1].item!, brandPalette })).toBeNull();
  });
});

describe("reviseSlideItem", () => {
  it("lays the reply over the current item and keeps the note it omits", () => {
    const current = deck.pages[1].item!;
    const item = reviseSlideItem({ title: "Shorter", archetype: "bullets", points: ["One.", "Two."] }, current);
    expect(item.title).toBe("Shorter");
    expect(item.points).toEqual(["One.", "Two."]);
    expect(item.eyebrow).toBe("What we learned");
    expect(item.note).toBe(current.note);
  });

  it("drops the old form's typed fields when the reply changes the form", () => {
    const current = deck.pages[2].item!;
    expect(current.stats).toHaveLength(3);
    const item = reviseSlideItem({ title: "The year in words", archetype: "bullets", points: ["Revenue $4.8M.", "62% came back."] }, current);
    expect(item.archetype).toBe("bullets");
    expect(item.stats).toBeUndefined();
  });

  it("throws on a reply with no page in it", () => {
    expect(() => reviseSlideItem({ archetype: "bullets" }, null)).toThrow();
  });
});
