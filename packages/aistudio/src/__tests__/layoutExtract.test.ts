import { describe, expect, it } from "vitest";
import { applyLayoutReview, estimatedFillHeight, extractLayoutSet, layoutReviewInstruction, parseLayoutReview, verifyLayoutCapacities, type ExtractPageLike } from "../layoutExtract";

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

describe("T20 stage 2: vision review parsing and application", () => {
  const PAGE_SIZE = { width: 1920, height: 1080 };
  const baseLayout = () =>
    extractLayoutSet([
      page([
        text(100, 80, 1700, 150, 54), // ph-1 title
        text(100, 300, 1700, 500, 24, 4), // ph-2 content
        text(100, 950, 500, 60, 14), // ph-3 body (actually a logo, says vision)
      ]),
    ]).layouts[0];

  it("instruction names every slot with its role and % geometry", () => {
    const layout = baseLayout();
    const instruction = layoutReviewInstruction(layout, PAGE_SIZE);
    expect(instruction).toContain("ph-1: title");
    expect(instruction).toContain("ph-2: content");
    expect(instruction).toContain('{"corrections":[]}');
  });

  it("parses corrections tolerantly: fences stripped, unknown ids/roles dropped, garbage yields none", () => {
    const ids = ["ph-1", "ph-2", "ph-3"];
    const ok = parseLayoutReview('```json\n{"corrections":[{"id":"ph-3","role":"decorative"},{"id":"ph-9","role":"body"},{"id":"ph-2","role":"sidebar"}]}\n```', ids);
    expect(ok).toEqual([{ id: "ph-3", role: "decorative" }]);
    expect(parseLayoutReview("Sure! The layout looks great.", ids)).toEqual([]);
    expect(parseLayoutReview('{"corrections":"all good"}', ids)).toEqual([]);
  });

  it("applies role changes with recomputed capacities and removes decorative slots", () => {
    const layout = baseLayout();
    const out = applyLayoutReview(
      layout,
      [
        { id: "ph-2", role: "picture" },
        { id: "ph-3", role: "decorative" },
      ],
      PAGE_SIZE,
    );
    expect(out.placeholders.map((p) => p.role)).toEqual(["title", "picture"]);
    const pic = out.placeholders[1];
    expect(pic.maxChars).toBeUndefined(); // content capacities did not linger
    expect(out.name).toBe("Title + picture");
  });

  it("never deletes the last slot and demotes a second title to body", () => {
    const layout = baseLayout();
    const wipe = applyLayoutReview(
      layout,
      layout.placeholders.map((p) => ({ id: p.id, role: "decorative" as const })),
      PAGE_SIZE,
    );
    expect(wipe.placeholders).toHaveLength(3); // refused: heuristics stand
    const twoTitles = applyLayoutReview(layout, [{ id: "ph-2", role: "title" }], PAGE_SIZE);
    expect(twoTitles.placeholders.filter((p) => p.role === "title")).toHaveLength(1);
    expect(twoTitles.placeholders[1].role).toBe("body");
  });
});

describe("T20 stage 3: capacity verification", () => {
  const PAGE_SIZE = { width: 1920, height: 1080 };

  it("shrinks a capacity whose max fill outgrows its box", () => {
    // A narrow, SHORT multi-item box: the area-derived floor (100 chars, 3
    // items) over-promises what two fill lines can hold.
    const layout = extractLayoutSet([page([text(100, 80, 1700, 150, 54), text(100, 300, 400, 60, 14, 4)])]).layouts[0];
    const slot = layout.placeholders[1];
    expect(slot.role).toBe("content");
    expect(estimatedFillHeight(slot)).toBeGreaterThan(slot.rect.height);
    const verified = verifyLayoutCapacities(layout, PAGE_SIZE);
    const fixed = verified.placeholders[1];
    expect(fixed.maxChars!).toBeLessThan(slot.maxChars!);
    expect(estimatedFillHeight(fixed)).toBeLessThanOrEqual(fixed.rect.height);
    expect(fixed.minChars!).toBeLessThanOrEqual(fixed.maxChars!);
    if (fixed.maxItems !== undefined) expect(fixed.minItems!).toBeLessThanOrEqual(fixed.maxItems);
  });

  it("keeps a capacity that already fits, verbatim", () => {
    const layout = extractLayoutSet([page([text(100, 80, 1700, 150, 54), text(100, 300, 1700, 600, 24, 4)])]).layouts[0];
    const verified = verifyLayoutCapacities(layout, PAGE_SIZE);
    expect(verified.placeholders).toEqual(layout.placeholders);
  });

  it("drops the hints on a box too small for a single line", () => {
    const layout = extractLayoutSet([page([text(100, 80, 1700, 150, 54), text(100, 300, 400, 100, 14)])]).layouts[0];
    // Force a pathological slot: shrink its rect below one fill line.
    const tiny = {
      ...layout,
      placeholders: layout.placeholders.map((p, i) => (i === 1 ? { ...p, rect: { ...p.rect, height: 10 } } : p)),
    };
    const verified = verifyLayoutCapacities(tiny, PAGE_SIZE);
    expect(verified.placeholders[1].maxChars).toBeUndefined();
    expect(verified.placeholders[1].minChars).toBeUndefined();
  });

  it("is idempotent: verifying a verified layout changes nothing", () => {
    const layout = extractLayoutSet([page([text(100, 80, 1700, 150, 54), text(100, 300, 400, 60, 14, 4)])]).layouts[0];
    const once = verifyLayoutCapacities(layout, PAGE_SIZE);
    expect(verifyLayoutCapacities(once, PAGE_SIZE)).toEqual(once);
  });
});
