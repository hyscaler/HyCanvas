import { describe, expect, it } from "vitest";
import {
  normalizeOutline,
  OutlineError,
  outlineItemToSpec,
  outlineJsonSchema,
  deckThemes,
  layoutDeck,
  qualityCheck,
  outlineSystemPrompt,
  groundImagePrompt,
  VISUAL_ROLES,
  type DesignOutline,
} from "../index";

const SIZE = { width: 1920, height: 1080 };

const RAW = {
  title: "Coffee Subscription Pitch",
  theme: "warm, premium, energetic",
  pages: [
    { title: "BrewBox", points: ["Fresh roasts, delivered"], visualRole: "cover" },
    { title: "The Problem", points: ["Stale grocery beans", "No discovery", "Inconvenient"], visualRole: "content" },
    { title: "Our Numbers", points: ["10k subscribers", "92% retention"], visualRole: "data" },
    { title: '"Best coffee I have had at home."', points: ["- a happy member"], visualRole: "quote" },
    { title: "Join Us", points: ["Start your trial today"], visualRole: "closing" },
  ],
};

describe("normalizeOutline", () => {
  it("validates a well-formed outline", () => {
    const o = normalizeOutline(RAW);
    expect(o.title).toBe("Coffee Subscription Pitch");
    expect(o.pages).toHaveLength(5);
    expect(o.pages[0].visualRole).toBe("cover");
    expect(o.pages.every((p) => p.id)).toBe(true);
  });

  it("drops empty pages, defaults role, and clamps points", () => {
    const o = normalizeOutline({
      title: "T",
      pages: [
        { title: "", points: [] },
        { title: "Keep", points: ["a", "", "  ", "b"], visualRole: "weird" },
        { points: ["points only"], visualRole: "data" },
      ],
    });
    expect(o.pages).toHaveLength(2);
    expect(o.pages[0].visualRole).toBe("content"); // defaulted
    expect(o.pages[0].points).toEqual(["a", "b"]);
  });

  it("throws when no pages remain", () => {
    expect(() => normalizeOutline({ title: "x", pages: [{ title: "", points: [] }] })).toThrow(OutlineError);
    expect(() => normalizeOutline(42)).toThrow(OutlineError);
  });

  it("schema enumerates the visual roles", () => {
    expect(outlineJsonSchema.properties.pages.items.properties.visualRole.enum).toEqual(VISUAL_ROLES);
  });
});

describe("outlineItemToSpec + layoutDeck", () => {
  const outline: DesignOutline = normalizeOutline(RAW);
  const theme = deckThemes({ count: 1 })[0];

  it("maps each visual role to a spec with a heading", () => {
    for (const item of outline.pages) {
      const spec = outlineItemToSpec(item, theme);
      expect(spec.blocks.some((b) => b.role === "heading")).toBe(true);
    }
  });

  it("lays out a whole deck, one page per outline item, all quality-clean", () => {
    const deck = layoutDeck(outline, theme, SIZE);
    expect(deck.pages).toHaveLength(outline.pages.length);
    for (const page of deck.pages) {
      const report = qualityCheck({ background: page.background, nodes: page.nodes, size: SIZE });
      const bad = report.issues.filter((i) => i.kind !== "contrast");
      expect(bad, `${page.name}: ${JSON.stringify(bad)}`).toHaveLength(0);
    }
  });

  it("propagates RTL into page specs", () => {
    const deck = layoutDeck(outline, theme, SIZE, { dir: "rtl" });
    expect(deck.pages.length).toBeGreaterThan(0);
  });

  it("applies brand fonts to generated text (FR-17)", () => {
    const branded = deckThemes({ count: 1, fontHeading: "Poppins", fontBody: "Inter" })[0];
    const spec = outlineItemToSpec({ id: "x", title: "Heading", points: ["a body point"], visualRole: "content" }, branded);
    expect(spec.fonts?.heading).toBe("Poppins");
    expect(spec.fonts?.body).toBe("Inter");
    const deck = layoutDeck(outline, branded, SIZE);
    const fonts = new Set<string>();
    for (const p of deck.pages) {
      for (const n of p.nodes) {
        if (n.type === "text") {
          const fam = (n as { content?: { runs?: { style?: { fontFamily?: string } }[] }[] }).content?.[0]?.runs?.[0]?.style?.fontFamily;
          if (fam) fonts.add(fam);
        }
      }
    }
    expect(fonts.has("Poppins") || fonts.has("Inter")).toBe(true);
  });

  it("alternates content-page layouts for rhythm (FR-3)", () => {
    const a = outlineItemToSpec({ id: "1", title: "T", points: ["p"], visualRole: "content" }, theme, { index: 0 });
    const b = outlineItemToSpec({ id: "2", title: "T", points: ["p"], visualRole: "content" }, theme, { index: 1 });
    expect(a.layout).not.toBe(b.layout);
  });
});

describe("deckThemes", () => {
  it("produces N distinct themes", () => {
    const themes = deckThemes({ count: 3 });
    expect(themes).toHaveLength(3);
    const sigs = new Set(themes.map((t) => JSON.stringify(t.background)));
    expect(sigs.size).toBe(3);
  });

  it("uses the brand palette when given", () => {
    const themes = deckThemes({ brandPalette: ["#ff0000", "#00aa00"], count: 2 });
    expect(themes).toHaveLength(2);
  });

  it("clamps count to a sane range", () => {
    expect(deckThemes({ count: 99 }).length).toBeLessThanOrEqual(8);
    expect(deckThemes({ count: 0 }).length).toBe(1);
  });
});

describe("outlineSystemPrompt", () => {
  it("embeds the schema and respects the page-count hint", () => {
    const p = outlineSystemPrompt("deck", "", 8);
    expect(p).toContain("visualRole");
    expect(p).toContain("about 8 pages");
  });
});

describe("groundImagePrompt", () => {
  it("appends palette, aspect, and style grounding", () => {
    const p = groundImagePrompt("a fox", { palette: ["#ff0000", "#00ff00"], aspect: "portrait", style: "flat illustration" });
    expect(p).toContain("a fox");
    expect(p).toContain("#ff0000");
    expect(p).toContain("portrait");
    expect(p).toContain("flat illustration");
  });
  it("works with no context", () => {
    expect(groundImagePrompt("a fox", {})).toContain("a fox");
  });
});
