import { describe, expect, it } from "vitest";
import { normalizeOutline } from "../outline";
import { layoutDeck } from "../deck";
import { deckThemes } from "../theme";
import { composeDeckFileWithReport } from "../compose";
import { catalogEntryForSeed } from "../designSystem";

const size = { width: 1920, height: 1080 };
const theme = deckThemes({ count: 1, seed: 2, kicker: "Deck" })[0];
const bullets = (title: string, n: number, len = 60) => ({
  title, archetype: "bullets", note: "",
  points: Array.from({ length: n }, (_, i) => `Point ${i + 1} ${"x".repeat(Math.max(0, len - 8))}`),
});

describe("the reviewer's report", () => {
  it("passes a varied, well-fitted deck", () => {
    const outline = normalizeOutline({ title: "T", pages: [
      { title: "Cover", archetype: "cover", subhead: "s", note: "" },
      { title: "One idea only", archetype: "statement", note: "" },
      bullets("Three points", 3, 40),
      { title: "Close", archetype: "closing", subhead: "Ask", note: "" },
    ] });
    const deck = layoutDeck(outline, theme, size, { seed: 1, catalog: catalogEntryForSeed(1) });
    expect(deck.report.shorten).toEqual([]);
    expect(deck.report.repetition).toEqual([]);
    expect(deck.report.ok).toBe(true);
  });

  it("never lets an archetype page run overfull: the budgets and the floor guarantee a fit", () => {
    // Every field at its budget ceiling, in the narrowest region a form
    // offers (a bullets column beside a picture). The ladder's floor still
    // holds it, so this deck needs no shortening pass. That guarantee is why
    // the report's overfull channel only ever fires for authored templates.
    const outline = normalizeOutline({ title: "T", pages: [
      { ...bullets("Too much", 5, 90), image: { subject: "cliff", treatment: "photo" } },
    ] });
    const deck = layoutDeck(outline, theme, size, { seed: 1 });
    expect(deck.report.pages[0].overfull).toEqual([]);
    expect(deck.report.shorten).toEqual([]);
  });

  it("flags copy an authored template slot cannot hold, rather than clipping it silently", () => {
    // A template whose body slot is a thin strip: reflow steps down the
    // ladder to the floor and still cannot fit five long points.
    const layoutSet = {
      masters: [{ id: "m", name: "Master", placeholders: [] }],
      layouts: [{
        id: "cramped", masterId: "m", name: "Cramped",
        placeholders: [
          { id: "t", role: "title", rect: { x: 100, y: 80, width: 1720, height: 140 } },
          { id: "c", role: "content", rect: { x: 100, y: 260, width: 400, height: 60 } },
        ],
      }],
    };
    const { report } = composeDeckFileWithReport({
      outline: { title: "T", pages: [bullets("Too much", 5, 90)] },
      width: 1920, height: 1080, layoutSet,
    });
    expect(report.pages[0].overfull).toEqual(["c"]);
    expect(report.shorten).toEqual([0]);
    expect(report.ok).toBe(false);
  });

  it("breaks a run of bullet pages with a two-up variant, deterministically", () => {
    const outline = normalizeOutline({ title: "T", pages: [
      bullets("A", 4, 40), bullets("B", 4, 40), bullets("C", 4, 40), bullets("D", 4, 40),
    ] });
    const deck = layoutDeck(outline, theme, size, { seed: 1 });
    // The third and fourth pages sit in a run of three; both have four points.
    const twoUp = deck.pages.map((p) => p.nodes.filter((n) => n.name === "Points").length);
    expect(twoUp[0]).toBe(1);
    expect(twoUp[1]).toBe(1);
    expect(twoUp[2]).toBe(2);
    expect(twoUp[3]).toBe(2);
    expect(deck.report.bulletShare).toBe(1);
  });

  it("sets a short list larger on an otherwise empty page", () => {
    const sparse = normalizeOutline({ title: "T", pages: [bullets("Two", 2, 20)] });
    const deck = layoutDeck(sparse, theme, size, { seed: 1 });
    const pts = deck.pages[0].nodes.find((n) => n.name === "Points") as { content: { runs: { style: { fontSize: number } }[] }[] };
    const dense = normalizeOutline({ title: "T", pages: [bullets("Five", 5, 60)] });
    const deckDense = layoutDeck(dense, theme, size, { seed: 1 });
    const ptsDense = deckDense.pages[0].nodes.filter((n) => n.name === "Points")[0] as { content: { runs: { style: { fontSize: number } }[] }[] };
    expect(pts.content[0].runs[0].style.fontSize).toBeGreaterThan(ptsDense.content[0].runs[0].style.fontSize);
  });

  it("rides along with the composed file for the server", () => {
    const { file, report } = composeDeckFileWithReport({
      outline: { title: "T", pages: [bullets("A", 3, 40), { title: "Q", archetype: "quote", quote: { text: "Less, but better." }, note: "" }] },
      width: 1920, height: 1080,
    });
    expect(file.pages).toHaveLength(2);
    expect(report.pages).toHaveLength(2);
    expect(report.pages[1].archetype).toBe("quote");
    expect(report.pages[1].impact).toBe(true);
  });
});
