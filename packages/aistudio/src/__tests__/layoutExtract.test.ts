import { describe, expect, it } from "vitest";
import { extractLayoutSet, type ExtractPageLike } from "../layoutExtract";

const PAGE = { width: 1920, height: 1080 };

function text(x: number, y: number, w: number, h: number, fontSize: number, paragraphs = 1): unknown {
  return {
    type: "text",
    transform: { x, y, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: w, height: h },
    content: Array.from({ length: paragraphs }, () => ({ runs: [{ text: "x", style: { fontSize } }] })),
  };
}

function node(type: string, x: number, y: number, w: number, h: number): unknown {
  return { type, transform: { x, y, scaleX: 1, scaleY: 1, rotation: 0 }, size: { width: w, height: h } };
}

function page(children: unknown[], background?: unknown): ExtractPageLike {
  return { ...PAGE, children, ...(background ? { background } : {}) } as ExtractPageLike;
}

describe("T20 stage 1: layout extraction heuristics", () => {
  it("largest text is the title, big text boxes are content, small ones body", () => {
    const { layouts, assignments } = extractLayoutSet([
      page([
        text(100, 80, 1700, 150, 54), // title (largest font)
        text(100, 300, 1700, 500, 24, 4), // large region -> content
        text(100, 950, 500, 60, 14), // caption -> body
      ]),
    ]);
    expect(assignments).toEqual([0]);
    expect(layouts).toHaveLength(1);
    const roles = layouts[0].placeholders.map((p) => p.role);
    expect(roles).toEqual(["title", "content", "body"]); // reading order
    // T11 capacities derived from geometry.
    const title = layouts[0].placeholders[0];
    expect(title.maxChars).toBeGreaterThan(0);
    const content = layouts[0].placeholders[1];
    expect(content.maxItems).toBeGreaterThanOrEqual(3);
  });

  it("images, charts, and video become picture/chart/media; shapes are decorative", () => {
    const { layouts } = extractLayoutSet([
      page([
        node("image", 100, 100, 800, 600),
        node("chart", 1000, 100, 800, 600),
        node("video", 100, 800, 800, 200),
        node("shape", 0, 0, 1920, 40), // decorative bar: no slot
        node("line", 0, 1040, 1920, 4),
      ]),
    ]);
    expect(layouts).toHaveLength(1);
    expect(layouts[0].placeholders.map((p) => p.role).sort()).toEqual(["chart", "media", "picture"]);
  });

  it("near-identical pages collapse into one layout with all sources recorded", () => {
    const titleContent = () => [text(100, 80, 1700, 150, 54), text(100, 300, 1700, 600, 24, 4)];
    const nudged = () => [text(108, 84, 1690, 150, 54), text(104, 306, 1700, 600, 22, 5)]; // sub-cell jitter
    const pictureLayout = () => [text(100, 80, 1700, 150, 54), node("image", 100, 300, 900, 600)];
    const { layouts, assignments } = extractLayoutSet([
      page(titleContent()),
      page(nudged()),
      page(pictureLayout()),
      page(titleContent()),
    ]);
    expect(layouts).toHaveLength(2);
    expect(assignments).toEqual([0, 0, 1, 0]);
    expect(layouts[0].sourcePageIndexes).toEqual([0, 1, 3]);
  });

  it("names describe structure and disambiguate repeats", () => {
    const { layouts } = extractLayoutSet([
      page([text(100, 80, 1700, 150, 54), text(100, 300, 800, 600, 24, 4), text(1000, 300, 800, 600, 24, 4)]),
      page([text(100, 80, 1700, 150, 54), node("image", 100, 300, 900, 600)]),
      page([node("image", 100, 100, 1700, 800)]),
    ]);
    expect(layouts.map((l) => l.name)).toEqual(["Title + 2 content", "Title + picture", "Picture"]);
  });

  it("a page of pure decoration yields no layout; hidden nodes are ignored", () => {
    const { layouts, assignments } = extractLayoutSet([
      page([node("shape", 0, 0, 1920, 1080), { ...(text(0, 0, 500, 100, 30) as object), hidden: true }]),
    ]);
    expect(layouts).toHaveLength(0);
    expect(assignments).toEqual([null]);
  });

  it("keeps the first source page's background on the layout", () => {
    const bg = { type: "solid", color: { srgb: { r: 0.1, g: 0.1, b: 0.2, a: 1 } } };
    const { layouts } = extractLayoutSet([page([text(100, 80, 1700, 150, 54)], bg)]);
    expect(layouts[0].background).toEqual(bg);
  });
});
