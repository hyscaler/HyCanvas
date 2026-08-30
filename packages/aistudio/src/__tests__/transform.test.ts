import { describe, expect, it } from "vitest";
import {
  deriveOutline,
  switchOutline,
  recomposeSpec,
  normalizeChartSpec,
  ChartSpecError,
  chartSpecJsonSchema,
  chartSystemPrompt,
  paletteTheme,
  sourcesOutlineItem,
  maxSourceCitations,
  layoutDeck,
  deckThemes,
  qualityCheck,
  type AiDesignSpec,
} from "../index";

describe("deriveOutline + switchOutline", () => {
  const derived = deriveOutline({
    title: "My Deck",
    pages: [
      { texts: [{ text: "Cover Title", fontSize: 80 }, { text: "subtitle", fontSize: 30 }] },
      { texts: [{ text: "Section One", fontSize: 60 }, { text: "point a", fontSize: 24 }, { text: "point b", fontSize: 24 }] },
      { texts: [{ text: "Agenda", fontSize: 50 }] },
    ],
  });

  it("derives a title (largest text) and points per page", () => {
    expect(derived.pages).toHaveLength(3);
    expect(derived.pages[0].title).toBe("Cover Title");
    expect(derived.pages[0].visualRole).toBe("cover");
    expect(derived.pages[1].points).toEqual(["point a", "point b"]);
  });

  it("switches a deck to a one-page poster", () => {
    const poster = switchOutline(derived, "poster");
    expect(poster.pages).toHaveLength(1);
    expect(poster.pages[0].visualRole).toBe("cover");
  });

  it("switches a deck to a social set (one post per page)", () => {
    const social = switchOutline(derived, "social-set");
    expect(social.pages.length).toBeGreaterThanOrEqual(1);
    expect(social.pages.every((p) => p.points.length <= 2)).toBe(true);
  });

  it("switches a deck to a document (sectioned content)", () => {
    const doc = switchOutline(derived, "doc");
    expect(doc.pages[0].visualRole).toBe("cover");
    expect(doc.pages.slice(1).every((p) => p.visualRole === "content")).toBe(true);
  });

  it("switched outputs lay out clean at the target size", () => {
    const social = switchOutline(derived, "social-set");
    const deck = layoutDeck(social, deckThemes({ count: 1 })[0], { width: 1080, height: 1080 });
    for (const page of deck.pages) {
      const bad = qualityCheck({ background: page.background, nodes: page.nodes, size: { width: 1080, height: 1080 } }).issues.filter((i) => i.kind !== "contrast");
      expect(bad).toHaveLength(0);
    }
  });
});

describe("sourcesOutlineItem", () => {
  it("lists each citation as a point and keeps the numbered list in the note", () => {
    const item = sourcesOutlineItem([
      { name: "IEA EV Outlook", url: "https://iea.org/ev" },
      { name: "Reuters", url: "https://reuters.com/x" },
    ]);
    expect(item.title).toBe("Sources");
    expect(item.visualRole).toBe("content");
    expect(item.points).toEqual([
      "IEA EV Outlook (https://iea.org/ev)",
      "Reuters (https://reuters.com/x)",
    ]);
    expect(item.note).toContain("1. IEA EV Outlook - https://iea.org/ev");
    expect(item.note).toContain("2. Reuters - https://reuters.com/x");
  });

  it("caps the list and drops blank citations", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `Source ${i + 1}`, url: `https://s${i + 1}.example` }));
    const item = sourcesOutlineItem([{ name: " ", url: "https://blank.example" }, ...many], "References");
    expect(item.title).toBe("References");
    expect(item.points).toHaveLength(maxSourceCitations);
    expect(item.points[0]).toContain("Source 1");
  });
});

describe("recomposeSpec", () => {
  it("re-lays out a spec for a new size without overflow", () => {
    const spec: AiDesignSpec = {
      layout: "left",
      background: { kind: "solid", color: "#0a0a0a" },
      blocks: [{ role: "heading", text: "Resize me" }, { role: "body", text: "Some supporting copy here." }],
    };
    const wide = recomposeSpec(spec, { width: 1920, height: 1080 });
    const tall = recomposeSpec(spec, { width: 1080, height: 1920 });
    expect(qualityCheck({ ...wide, size: { width: 1920, height: 1080 } }).issues.filter((i) => i.kind === "overflow")).toHaveLength(0);
    expect(qualityCheck({ ...tall, size: { width: 1080, height: 1920 } }).issues.filter((i) => i.kind === "overflow")).toHaveLength(0);
  });
});

describe("normalizeChartSpec", () => {
  it("validates and aligns series to categories", () => {
    const spec = normalizeChartSpec({
      chartType: "line",
      categories: ["Jan", "Feb", "Mar"],
      series: [{ name: "Sales", values: [10, 20] }], // short -> padded with 0
    });
    expect(spec.chartType).toBe("line");
    expect(spec.series[0].values).toEqual([10, 20, 0]);
  });

  it("defaults an unknown chart type to bar", () => {
    const spec = normalizeChartSpec({ chartType: "spiral", categories: ["a"], series: [{ name: "s", values: [1] }] });
    expect(spec.chartType).toBe("bar");
  });

  it("throws without categories or series", () => {
    expect(() => normalizeChartSpec({ chartType: "bar", categories: [], series: [] })).toThrow(ChartSpecError);
    expect(() => normalizeChartSpec({ chartType: "bar", categories: ["a"], series: [] })).toThrow(ChartSpecError);
  });

  it("schema + prompt expose chart types", () => {
    expect(chartSpecJsonSchema.properties.chartType.enum).toContain("bar");
    expect(chartSystemPrompt()).toContain("chartType");
  });
});

describe("paletteTheme", () => {
  it("makes a gradient from a multi-color palette", () => {
    const t = paletteTheme([
      { srgb: { r: 0.1, g: 0.1, b: 0.3, a: 1 } },
      { srgb: { r: 0.8, g: 0.2, b: 0.2, a: 1 } },
    ], "Brand");
    expect(t.background.kind).toBe("gradient");
    expect(t.kicker).toBe("Brand");
  });

  it("falls back to a solid for an empty palette", () => {
    expect(paletteTheme([]).background.kind).toBe("solid");
  });
});
