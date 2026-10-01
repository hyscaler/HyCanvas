// The presentation kit as the generation flow's composer: a deck set in one
// of the signature templates' systems, its voice and drawings placed, its
// one signature form used once, brand and chosen themes repainting it, and
// the classic composer kept for what the kit cannot set.

import { describe, expect, it } from "vitest";
import { contrastRatio, toHex } from "@hc/color";
import { themeCatalogEntry } from "../themeCatalog";
import { composeDeckFileWithReport } from "../compose";
import { layoutDeck } from "../deck";
import { normalizeOutline } from "../outline";
import { deckThemes } from "../theme";
import { KIT_STYLES, kitStyleNames } from "../kit/looks";
import { applyBrand, makeLook, mark, resolveKitStyle, slotsFromThemeRecord, styleForMood } from "../kit/look";
import { iconGlyphFor } from "../archetypes";
import { kitFits, leadingFigure, splitPoint } from "../kit/render";
import { kitDrawingNames, kitVocabularyRule } from "../kit/vocab";
import { PACK_DRAWINGS, PACK_KEYWORDS } from "../kit/packset";

type N = { name?: string; type: string; children?: N[]; content?: { runs: { text: string; style: { fontFamily: string; fill: { color: { srgb: { r: number; g: number; b: number; a: number } } } } }[] }[]; data?: Record<string, unknown> };

const outline = {
  title: "Northwind coffee: the year in beans",
  theme: "warm, candid",
  style: "campfire",
  organization: "Northwind Roasters",
  kicker: "Twelve months, one roast at a time",
  farewell: "See you at the next cupping",
  pages: [
    { title: "The year in beans", archetype: "cover", subhead: "What we roasted and what we learned.", drawing: "coffee", note: "n" },
    { title: "Good coffee is a habit we sell", archetype: "statement", subhead: "Every number traces back to how often a customer comes back.", aside: "say this one slowly", note: "n" },
    { title: "The year in four numbers", archetype: "kpiGrid", eyebrow: "Results", signature: "scoreboard", stats: [{ value: "$4.8M", label: "Revenue" }, { value: "62%", label: "Return within 30 days" }, { value: "4", label: "Shops open" }], pairs: [{ label: "Revenue", value: "+31%" }], points: ["Revenue grew faster than volume.", "Return rate is the number we watch.", "The fourth shop broke even."], note: "n" },
    { title: "Three things the year proved", archetype: "bullets", eyebrow: "What we learned", points: ["Regulars carry the shop: sixty percent of cups go to people we know.", "Mornings are won by seven.", "Pastry sells coffee: the case lifted the ticket by a dollar."], note: "n" },
    { title: "Where each shop stands", archetype: "table", eyebrow: "Health", signature: "healthGrid", pairs: [{ label: "Harbour Street", value: "On track" }, { label: "Mill Lane", value: "At risk" }], note: "n" },
    { title: "Come to the cupping", archetype: "closing", subhead: "The first Saturday of every month.", points: ["hello@northwind.example", "Book a seat"], note: "n" },
  ],
};

const names = (nodes: N[]): string[] => nodes.map((n) => n.name ?? "");
const texts = (nodes: N[]): string[] => nodes.flatMap((n) => (n.content ?? []).flatMap((p) => p.runs.map((r) => r.text)));

describe("the kit sets a 16 by 9 deck in a named style", () => {
  it("composes every page in the kit's forms, with the voice, the drawings and one signature", () => {
    const { file, report } = composeDeckFileWithReport({ outline, width: 1920, height: 1080 });
    const pages = file.pages as unknown as { children: N[]; background: { type: string } }[];
    expect(pages).toHaveLength(6);
    // The cover sits on the deep gradient and carries the mark, the kicker
    // and the drawing the outline named, as an editable group.
    expect(pages[0].background.type).toBe("gradient");
    expect(texts(pages[0].children)).toContain("Twelve months, one roast at a time");
    expect(texts(pages[0].children)).toContain("Northwind Roasters");
    const drawing = pages[0].children.find((n) => n.name === "Illustration");
    expect(drawing?.type).toBe("group");
    expect(drawing?.data?.illustration).toBe(PACK_KEYWORDS.coffee);
    // The aside is set in the accent face; the statement carries the kicker.
    const aside = pages[1].children.find((n) => n.name === "Note");
    expect(aside?.content?.[0].runs[0].text).toBe("say this one slowly");
    expect(aside?.content?.[0].runs[0].style.fontFamily).toBe(KIT_STYLES.campfire.accentFace);
    // One signature per deck: the scoreboard is used, the health grid is not.
    expect(names(pages[2].children)).toContain("Figure");
    expect(texts(pages[2].children)).toContain("$4.8M");
    expect(texts(pages[4].children)).not.toContain("ON TRACK");
    // Reading pages carry the footer and the page number; the closing the farewell.
    expect(texts(pages[3].children)).toContain("04 / 6");
    expect(texts(pages[5].children)).toContain("See you at the next cupping");
    expect(texts(pages[5].children)).toContain("Book a seat");
    // The file's theme record wears the style's pairing.
    expect((file.theme as unknown as { fontHeading?: string }).fontHeading).toBe(KIT_STYLES.campfire.display);
    // Nothing overfull, nothing off the page or overlapping.
    expect(report.shorten).toEqual([]);
    expect(report.pages.flatMap((p) => p.issues)).toEqual([]);
  });

  it("composes to the same bytes twice", () => {
    // Node ids are minted per call; everything else is deterministic.
    const strip = (v: unknown) => JSON.stringify(v).replace(/"id":"[^"]*"/g, "");
    const a = strip(layoutDeck(normalizeOutline(outline), deckThemes({ count: 1 })[0], { width: 1920, height: 1080 }, { renderer: "kit", seed: 3 }).pages);
    const b = strip(layoutDeck(normalizeOutline(outline), deckThemes({ count: 1 })[0], { width: 1920, height: 1080 }, { renderer: "kit", seed: 3 }).pages);
    expect(a).toBe(b);
  });

  it("scales to a smaller 16 by 9 page and keeps the classic composer for other shapes", () => {
    const small = layoutDeck(normalizeOutline(outline), deckThemes({ count: 1 })[0], { width: 1280, height: 720 }, { renderer: "kit", seed: 3 });
    const title = small.pages[0].nodes.find((n) => n.name === "Title") as unknown as { transform: { x: number }; content: { runs: { style: { fontSize: number } }[] }[] };
    expect(title.transform.x).toBeCloseTo(64, 0);
    expect(title.content[0].runs[0].style.fontSize).toBeLessThan(90);
    expect(kitFits({ width: 1920, height: 1080 })).toBe(true);
    expect(kitFits({ width: 1080, height: 1080 })).toBe(false);
    expect(kitFits({ width: 1920, height: 1080 }, "poster")).toBe(false);
    const post = layoutDeck(normalizeOutline(outline), deckThemes({ count: 1 })[0], { width: 1080, height: 1080 }, { renderer: "kit", seed: 3, designType: "social-set" });
    expect(post.pages[0].nodes.some((n) => n.name === "Kicker" || n.name === "Title")).toBe(true);
    expect(post.pages[0].nodes.some((n) => (n as N).data?.illustration === PACK_KEYWORDS.coffee)).toBe(false);
  });

  it("falls back by seed for an unknown style, and by family for a classic look", () => {
    expect(resolveKitStyle({ style: "nonesuch", seed: 5 }).name).toBe(kitStyleNames[5 % kitStyleNames.length]);
    expect(resolveKitStyle({ style: "Campfire" }).name).toBe("campfire");
    expect(["folio", "parchment", "wine", "burgundy", "linen", "casebook", "ledger", "opera", "gala"]).toContain(resolveKitStyle({ look: "editorial", seed: 2 }).name);
    expect(normalizeOutline({ title: "T", pages: [{ title: "A", points: ["x"] }], style: "Ledger " }).style).toBe("ledger");
  });

  it("repaints in the brand and holds every small ink to AA on its grounds", () => {
    const style = applyBrand(KIT_STYLES.ledger, { brandPalette: ["#0e7a5f", "#f4b942"], brandFonts: { heading: "Fraunces", body: "Nunito" } });
    const K = makeLook(style, { total: 3 });
    expect(K.display).toBe("Fraunces");
    expect(K.body).toBe("Nunito");
    const hex = (h: string) => ({ srgb: { r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255, a: 1 } });
    // A mid-tone primary becomes a ground light copy can read on.
    expect(contrastRatio(hex(K.deep.ink), hex(K.deep.bg))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(hex(K.deep.muted), hex(K.deep.bg))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(hex(K.paper.accentInk!), hex(K.paper.panel))).toBeGreaterThanOrEqual(4.5);
    const { report } = composeDeckFileWithReport({ outline: { ...outline, style: "ledger" }, width: 1920, height: 1080, brandPalette: ["#0e7a5f", "#f4b942"], brandFonts: { heading: "Fraunces", body: "Nunito" } });
    expect(report.repairs).toBeLessThanOrEqual(3);
  });

  it("wears a chosen catalog theme's slots, and not a mood-picked one", () => {
    const entry = themeCatalogEntry("theme-midnight")!;
    const theme = deckThemes({ count: 1 })[0];
    const chosen = layoutDeck(normalizeOutline(outline), theme, { width: 1920, height: 1080 }, { renderer: "kit", seed: 3, catalog: entry, themeChosen: true, fontsAuthored: true });
    expect(toHex(chosen.system.colors.paper).toLowerCase()).toBe(entry.colors[5].toLowerCase());
    expect(toHex(chosen.system.colors.deep).toLowerCase()).toBe(entry.colors[2].toLowerCase());
    const byMood = layoutDeck(normalizeOutline(outline), theme, { width: 1920, height: 1080 }, { renderer: "kit", seed: 3, catalog: entry });
    expect(toHex(byMood.system.colors.paper).toUpperCase()).toBe(KIT_STYLES.campfire.paper.bg.toUpperCase());
  });

  it("registers a picture slot only where a layout draws one", () => {
    const photo = { subject: "a wide monitor on a tidy desk", treatment: "photo" as const };
    const withPhotos = {
      ...outline,
      pages: [
        { ...outline.pages[0], image: photo },
        { title: "The new control plane", archetype: "imageCaption", eyebrow: "What shipped", subhead: "One dashboard replaces four.", image: photo, points: ["Latency: p95 down 38%", "Cost: $41k a month saved"], note: "n" },
        { ...outline.pages[5], image: photo },
      ],
    };
    const deck = layoutDeck(normalizeOutline(withPhotos), deckThemes({ count: 1 })[0], { width: 1920, height: 1080 }, { renderer: "kit", seed: 3 });
    // The cover and the closing compose a drawing in a halo whatever the
    // intent, and hand the pipeline nothing; the caption page gets one tagged
    // stand-in shape, the same kind both picture ladders replace.
    expect(Object.keys(deck.pages[0].imagePrompts)).toEqual([]);
    expect(deck.pages[0].nodes.some((n) => n.name === "Illustration")).toBe(true);
    expect(Object.keys(deck.pages[2].imagePrompts)).toEqual([]);
    const ids = Object.keys(deck.pages[1].imagePrompts);
    expect(ids).toHaveLength(1);
    const slot = deck.pages[1].nodes.find((n) => (n as N).data?.placeholderId === ids[0]) as N | undefined;
    expect(slot?.type).toBe("shape");
    expect(slot?.name).toBe("Image");
    expect(deck.pages[1].imagePrompts[ids[0]]).toContain("a wide monitor on a tidy desk");
    expect(deck.pages[1].nodes.some((n) => n.name === "Illustration")).toBe(false);
    expect(deck.renderer).toBe("kit");
  });

  it("matches a style to the mood when the outline names none, and reads a theme record's slots", () => {
    expect(styleForMood("a team offsite in the mountains, camping and community")?.name).toBe("campfire");
    expect(styleForMood("the product launch countdown and the sales kickoff")?.name).toBe("ember");
    expect(styleForMood("zzz qqq")).toBeNull();
    expect(resolveKitStyle({ seed: 1, mood: "an investor update, monthly, candour and numbers" }).name).toBe("amber");
    const rec = { colors: ["primary", "accent", "deep", "tint", "ink", "paper"].map((name, i) => ({ id: `c${i}`, name, color: { srgb: { r: i / 10, g: 0.5, b: 0.2, a: 1 } } })) };
    expect(slotsFromThemeRecord(rec)).toEqual(["#008033", "#1A8033", "#338033", "#4D8033", "#668033", "#808033"]);
    expect(slotsFromThemeRecord({ colors: rec.colors.slice(0, 3) })).toBeNull();
    // The record's slots repaint the kit the way a chosen catalog theme does.
    const deck = layoutDeck(normalizeOutline(outline), deckThemes({ count: 1 })[0], { width: 1920, height: 1080 }, { renderer: "kit", seed: 3, themeSlots: ["#0E7A5F", "#F4B942", "#0B2B22", "#EAF0EC", "#101815", "#FBFAF6"] });
    expect(toHex(deck.system.colors.paper).toUpperCase()).toBe("#FBFAF6");
    expect(toHex(deck.system.colors.deep).toUpperCase()).toBe("#0B2B22");
  });

  it("names a glyph by its own name before the keyword table", () => {
    expect(iconGlyphFor("circle-check")).toBe("circle-check");
    expect(iconGlyphFor("alert-triangle")).toBe("alert-triangle");
    expect(iconGlyphFor("shield")).toBeTruthy();
  });

  it("shapes copy for the forms", () => {
    expect(splitPoint("Retention leads growth: net revenue retention held above 118%.")).toEqual(["Retention leads growth", "net revenue retention held above 118%."]);
    expect(splitPoint("Mornings are won by seven")).toEqual(["Mornings are won by seven", ""]);
    expect(leadingFigure("$4.2M expansion revenue in Q4")).toEqual(["$4.2M", "expansion revenue in Q4"]);
    expect(leadingFigure("58% of growth from existing customers")).toEqual(["58%", "of growth from existing customers"]);
    expect(leadingFigure("Three of four quarters ahead of plan")[0]).toBeNull();
  });

  it("offers the model only what the composer has", () => {
    for (const name of kitStyleNames) expect(kitVocabularyRule).toContain(`'${name}'`);
    for (const name of kitDrawingNames) expect(PACK_DRAWINGS[PACK_KEYWORDS[name]]).toBeDefined();
    expect(kitVocabularyRule).toContain("'scoreboard'");
  });
});

describe("the organization mark beside the logo", () => {
  const look = (aspect: number) =>
    makeLook(applyBrand(resolveKitStyle({ style: "campfire" }), {}), {
      organization: "Northwind Roasters", total: 3,
      logo: { assetId: "logo", url: "/a/logo", aspect, dark: { assetId: "logo-dark", url: "/a/logo-dark", aspect } },
    });
  const names = (prims: { kind: string; name?: string }[]) => prims.map((p) => (p as { name?: string }).name ?? p.kind);

  it("sets the name beside a compact mark", () => {
    const K = look(1);
    const prims = mark(K, K.paper);
    expect(prims.some((p) => p.kind === "logo")).toBe(true);
    expect(names(prims)).toContain("Mark");
  });

  it("leaves the name out beside a lockup that already carries it, on either ground", () => {
    const K = look(5);
    for (const g of [K.paper, K.deep]) {
      const prims = mark(K, g);
      expect(prims.some((p) => p.kind === "logo")).toBe(true);
      expect(names(prims)).not.toContain("Mark");
    }
  });
});
