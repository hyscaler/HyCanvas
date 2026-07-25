import { describe, it, expect } from "vitest";
import { createNode, type CharStyle, type Paragraph, type TextNode, type TextStyleSheet } from "@hc/schema";
import {
  applyCharToRange,
  autoFitScale,
  contentFromText,
  createParagraph,
  fitBoxToText,
  findMatches,
  getPlainText,
  graphemeCount,
  graphemes,
  layoutText,
  measureText,
  nextTabStop,
  tabRunWidth,
  isTabRun,
  replaceAll,
  resolveCharStyle,
  resolveParagraphStyle,
  words,
  FONT_CATALOG,
  searchFonts,
  getFontEntry,
  fontCssUrl,
  setFontCssProvider,
  isSystemFont,
} from "../index";

describe("font catalog (FR-5)", () => {
  it("has a non-empty catalog including the system entry", () => {
    expect(FONT_CATALOG.length).toBeGreaterThan(10);
    expect(getFontEntry("system")?.system).toBe(true);
    expect(isSystemFont("system")).toBe(true);
    expect(isSystemFont(undefined)).toBe(true);
    expect(isSystemFont("Inter")).toBe(false);
  });
  it("searches by name and category, prefix-ranked", () => {
    expect(searchFonts("rob").map((f) => f.family)).toContain("Roboto");
    expect(searchFonts("", "serif").every((f) => f.category === "serif")).toBe(true);
    expect(searchFonts("mono", "monospace").length).toBeGreaterThan(0);
  });
  it("builds a webfont CSS URL (Bunny by default) for web fonts and empty for system", () => {
    const url = fontCssUrl("Inter", [400, 700]);
    expect(url).toContain("family=Inter");
    expect(url).toContain("wght@");
    expect(url).toContain("700");
    expect(url).toContain("fonts.bunny.net"); // privacy-friendly default
    expect(fontCssUrl("system")).toBe("");
  });

  it("encodes a multi-word family with '+' and never leaks unknown/hostile input", () => {
    // A catalog family with a space stays "+"-encoded (CSS2 request syntax).
    expect(fontCssUrl("Open Sans")).toContain("family=Open+Sans");
    // Anything not in the curated catalog (including anything with markup or URL
    // meta-characters) resolves to no URL at all, so the DOM sink stays safe.
    expect(fontCssUrl('Nope"<script>alert(1)</script>')).toBe("");
    expect(fontCssUrl("../../evil")).toBe("");
    // Every returned URL is on the fixed host allowlist, never derived host.
    const url = fontCssUrl("Playfair Display");
    expect(url === "" || /^https:\/\/(fonts\.bunny\.net|fonts\.googleapis\.com)\//.test(url)).toBe(true);
  });

  it("switches the webfont CSS host to Google when asked, and back to Bunny", () => {
    setFontCssProvider("google");
    expect(fontCssUrl("Inter")).toContain("fonts.googleapis.com");
    setFontCssProvider("bunny");
    expect(fontCssUrl("Inter")).toContain("fonts.bunny.net");
  });
});

const solid = (r: number, g: number, b: number): CharStyle["fill"] => ({
  type: "solid",
  color: { srgb: { r, g, b, a: 1 } },
});

function textNode(content: Paragraph[], box?: Partial<TextNode["box"]>): TextNode {
  const node = createNode("text", { id: "t" }) as TextNode;
  node.content = content;
  node.box = { mode: "fixed", width: 200, height: 100, ...box };
  return node;
}

describe("defaults + model", () => {
  it("builds runs/paragraphs/content from text", () => {
    expect(createParagraph("hi").runs[0].text).toBe("hi");
    expect(contentFromText("a\nb").length).toBe(2);
  });
});

describe("style cascade (FR-16)", () => {
  it("resolves defaults -> baseChar -> linked style (basedOn) -> overrides", () => {
    const sheet: TextStyleSheet = {
      charStyles: {
        base: { name: "Base", style: { fontFamily: "Inter", fontStyle: "Regular", fontSize: 20, fill: solid(0, 0, 0) } },
        bold: { name: "Bold", basedOn: "base", style: { fontFamily: "Inter", fontStyle: "Bold", fontSize: 20, fill: solid(0, 0, 0), axes: { wght: 700 } } },
      },
      paragraphStyles: {},
    };
    const run = { text: "x", style: { fontFamily: "system", fontStyle: "Regular", fontSize: 12, fill: solid(0, 0, 0) }, charStyleId: "bold", overrides: { fontSize: 48 } };
    const resolved = resolveCharStyle(run, undefined, sheet);
    expect(resolved.fontFamily).toBe("Inter"); // from base via basedOn
    expect(resolved.axes?.wght).toBe(700); // from bold
    expect(resolved.fontSize).toBe(48); // override wins
  });

  it("deep-merges axes so a partial override keeps other axes", () => {
    const sheet: TextStyleSheet = {
      charStyles: {
        base: { name: "B", style: { fontFamily: "X", fontStyle: "Regular", fontSize: 20, fill: solid(0, 0, 0), axes: { wght: 400, wdth: 100 } } },
      },
      paragraphStyles: {},
    };
    const run = { text: "x", style: { fontFamily: "X", fontStyle: "Regular", fontSize: 20, fill: solid(0, 0, 0) }, charStyleId: "base", overrides: { axes: { wght: 700 } } };
    const r = resolveCharStyle(run, undefined, sheet);
    expect(r.axes).toEqual({ wght: 700, wdth: 100 }); // wdth preserved
  });

  it("does not infinitely recurse on a basedOn cycle", () => {
    const sheet: TextStyleSheet = {
      charStyles: {
        a: { name: "a", basedOn: "b", style: { fontFamily: "X", fontStyle: "Regular", fontSize: 20, fill: solid(0, 0, 0) } },
        b: { name: "b", basedOn: "a", style: { fontFamily: "X", fontStyle: "Regular", fontSize: 20, fill: solid(0, 0, 0) } },
      },
      paragraphStyles: {},
    };
    const run = { text: "x", style: { fontFamily: "X", fontStyle: "Regular", fontSize: 20, fill: solid(0, 0, 0) }, charStyleId: "a" };
    expect(() => resolveCharStyle(run, undefined, sheet)).not.toThrow();
  });

  it("paragraph baseChar feeds run resolution; inline style used without a sheet", () => {
    const para = createParagraph("hi", { fontSize: 14 }, {});
    para.style.baseChar = { letterSpacing: 2 };
    const resolved = resolveCharStyle(para.runs[0], para);
    expect(resolved.fontSize).toBe(14); // inline run style
    expect(resolved.letterSpacing).toBe(2); // from paragraph baseChar
    expect(resolveParagraphStyle(para).align).toBe("left");
  });
});

describe("segmentation (FR-18)", () => {
  it("counts grapheme clusters, not code units", () => {
    expect(graphemeCount("abc")).toBe(3);
    expect(graphemeCount("👨‍👩‍👧‍👦")).toBe(1); // ZWJ family is one cluster
    expect(graphemes("é").length).toBe(1); // e + combining acute
  });
  it("extracts word-like segments", () => {
    expect(words("hello, world!")).toEqual(["hello", "world"]);
  });
});

describe("rich-text ops (FR-14, FR-22)", () => {
  it("getPlainText joins runs and paragraphs", () => {
    const node = textNode([createParagraph("Hello "), createParagraph("World")]);
    node.content[0].runs.push({ text: "there", style: node.content[0].runs[0].style });
    expect(getPlainText(node)).toBe("Hello there\nWorld");
  });

  it("findMatches honors case, whole-word, and regex", () => {
    const node = textNode([createParagraph("cat cats category")]);
    expect(findMatches(node, { text: "cat" }).length).toBe(3); // substring
    expect(findMatches(node, { text: "cat", wholeWord: true }).length).toBe(1);
    expect(findMatches(node, { text: "CAT", caseSensitive: true }).length).toBe(0);
    expect(findMatches(node, { text: "cats?", regex: true }).length).toBe(3);
  });

  it("replaceAll preserves the format at the match start", () => {
    const styleA = { fontFamily: "system", fontStyle: "Regular", fontSize: 20, fill: solid(0, 0, 0) };
    const styleB = { fontFamily: "system", fontStyle: "Bold", fontSize: 30, fill: solid(1, 0, 0) };
    const node = textNode([{ runs: [{ text: "Hello ", style: styleA }, { text: "world", style: styleB }], style: { align: "left", direction: "auto" } }]);
    const n = replaceAll(node, { text: "world" }, "WORLD");
    expect(n).toBe(1);
    const runs = node.content[0].runs;
    const wordRun = runs.find((r) => r.text === "WORLD");
    expect(wordRun?.style.fontSize).toBe(30); // inherited style B
    expect(runs.find((r) => r.text === "Hello ")?.style.fontSize).toBe(20);
  });

  it("applyCharToRange splits a run and applies the patch", () => {
    const node = textNode([createParagraph("Hello")]);
    applyCharToRange(node, 0, 0, 2, { fontSize: 40 });
    const runs = node.content[0].runs;
    expect(runs.map((r) => r.text)).toEqual(["He", "llo"]);
    expect(runs[0].style.fontSize).toBe(40);
    expect(runs[1].style.fontSize).toBe(16);
  });
});

describe("layout + auto-fit (FR-11, FR-12)", () => {
  it("wraps a long line at the box width and stacks paragraphs", () => {
    const node = textNode([createParagraph("aaaa aaaa aaaa aaaa", { fontSize: 20 })], { width: 100 });
    const result = layoutText(node);
    expect(result.lines.length).toBeGreaterThan(1);
  });

  it("tab stops: default grid, explicit stops, and a tab segment in layout", () => {
    expect(isTabRun("\t")).toBe(true);
    expect(isTabRun("\t\t")).toBe(true);
    expect(isTabRun(" ")).toBe(false);
    // Default grid = em * 4.
    expect(nextTabStop(0, undefined, 10)).toBe(40);
    expect(nextTabStop(45, undefined, 10)).toBe(80);
    // Explicit stops first, then fall back to the grid past the last stop.
    expect(nextTabStop(0, [100, 200], 10)).toBe(100);
    expect(nextTabStop(120, [100, 200], 10)).toBe(200);
    expect(nextTabStop(250, [100, 200], 10)).toBe(280);
    // Two tabs from 0 land at the second stop.
    expect(tabRunWidth("\t\t", 0, [100, 200], 10)).toBe(200);
    // A tab inside a line is preserved as its own segment and pushes width past the stop.
    const node = textNode([createParagraph("a\tb", { fontSize: 20 }, { tabStops: [120] })], { width: 400 });
    const line = layoutText(node).lines[0];
    expect(line.segments.some((s) => s.text === "\t")).toBe(true);
    expect(line.width).toBeGreaterThan(120);
  });

  it("flows into multiple columns (each tagged with its column left/width)", () => {
    const many = Array.from({ length: 12 }, (_, i) => createParagraph(`line ${i}`, { fontSize: 16 }));
    const node = textNode(many, { width: 400, height: 60, columns: { count: 2, gutter: 20 } } as Partial<TextNode["box"]>);
    const lines = layoutText(node).lines;
    const cols = new Set(lines.map((l) => l.colLeft ?? 0));
    expect(cols.size).toBe(2); // content spilled into a second column
    // The second column is offset to the right; each column is narrower than full.
    const lefts = [...cols].sort((a, b) => a - b);
    expect(lefts[0]).toBe(0);
    expect(lefts[1]).toBeGreaterThan(0);
    expect(lines[0].colWidth!).toBeLessThan(400);
  });

  it("single column leaves colLeft/colWidth unset (unchanged layout)", () => {
    const node = textNode([createParagraph("hello world", { fontSize: 16 })], { width: 400, height: 100 });
    expect(layoutText(node).lines[0].colLeft).toBeUndefined();
  });

  it("autoWidth does not wrap", () => {
    const node = textNode([createParagraph("aaaa aaaa aaaa aaaa", { fontSize: 20 })], { mode: "autoWidth", width: 100 });
    expect(layoutText(node).lines.length).toBe(1);
  });

  it("emits a bullet marker on the first line of a bulleted paragraph", () => {
    const node = textNode([createParagraph("item", { fontSize: 16 }, { list: { type: "bullet", level: 0 } })]);
    const line = layoutText(node).lines[0];
    expect(line.marker?.text).toBe("•");
    expect(line.x).toBeGreaterThan(0); // text hangs past the marker gutter
  });

  it("numbers ordered-list paragraphs and resets after a non-list paragraph", () => {
    const node = textNode([
      createParagraph("a", { fontSize: 16 }, { list: { type: "number", level: 0 } }),
      createParagraph("b", { fontSize: 16 }, { list: { type: "number", level: 0 } }),
      createParagraph("gap", { fontSize: 16 }),
      createParagraph("c", { fontSize: 16 }, { list: { type: "number", level: 0 } }),
    ]);
    const markers = layoutText(node).lines.map((l) => l.marker?.text);
    expect(markers).toEqual(["1.", "2.", undefined, "1."]);
  });

  it("adds paragraph spacing before/after to the stacked height", () => {
    const plain = textNode([createParagraph("x", { fontSize: 16 }), createParagraph("y", { fontSize: 16 })], { mode: "autoHeight" });
    const spaced = textNode(
      [createParagraph("x", { fontSize: 16 }, { spaceAfter: 30 }), createParagraph("y", { fontSize: 16 })],
      { mode: "autoHeight" },
    );
    expect(layoutText(spaced).height).toBe(layoutText(plain).height + 30);
  });

  it("continues a numbered list at the parent level across a nested sublist", () => {
    const node = textNode([
      createParagraph("one", { fontSize: 16 }, { list: { type: "number", level: 0 } }),
      createParagraph("a", { fontSize: 16 }, { list: { type: "number", level: 1 } }),
      createParagraph("b", { fontSize: 16 }, { list: { type: "number", level: 1 } }),
      createParagraph("two", { fontSize: 16 }, { list: { type: "number", level: 0 } }),
      createParagraph("a", { fontSize: 16 }, { list: { type: "number", level: 1 } }),
    ]);
    const markers = layoutText(node).lines.map((l) => l.marker?.text);
    // Parent level continues (1., 2.); each sublist restarts (1., then 1.).
    expect(markers).toEqual(["1.", "1.", "2.", "2.", "1."]);
  });

  it("collapses space-before on the first paragraph (against the box top)", () => {
    const plain = textNode([createParagraph("x", { fontSize: 16 })], { mode: "autoHeight" });
    const lead = textNode([createParagraph("x", { fontSize: 16 }, { spaceBefore: 40 })], { mode: "autoHeight" });
    expect(layoutText(lead).height).toBe(layoutText(plain).height);
  });

  it("autoFitScale shrinks to fit a short box; fitBoxToText sizes to content", () => {
    const node = textNode([createParagraph("Big heading text", { fontSize: 100 })], { width: 200, height: 40 });
    const scale = autoFitScale(node);
    expect(scale).toBeLessThan(1); // must shrink
    const measured = measureText(node);
    expect(measured.width).toBe(200); // fixed box reports box width
    const fit = fitBoxToText(node);
    expect(fit.height).toBeGreaterThan(0);
  });

  it("fitBoxToText counts padding exactly once", () => {
    const node = textNode([createParagraph("Hi", { fontSize: 20 })], { mode: "fixed", width: 200, height: 100, padding: { t: 10, r: 5, b: 10, l: 5 } });
    const fit = fitBoxToText(node);
    const noPad = fitBoxToText(textNode([createParagraph("Hi", { fontSize: 20 })], { mode: "fixed", width: 200, height: 100 }));
    // Padded result exceeds unpadded by exactly the padding (not double).
    expect(fit.height - noPad.height).toBeCloseTo(20, 6);
    expect(fit.width - noPad.width).toBeCloseTo(10, 6);
  });
});
