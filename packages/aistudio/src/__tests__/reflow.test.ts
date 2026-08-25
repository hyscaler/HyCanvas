// F40 E15: the pure reflow engine. Deterministic ladder stepping, both
// directions, hand-styled ceilings, and the over/underflow verdicts that
// drive the E17 variant proposal.
import { describe, expect, it } from "vitest";
import { reflowPage, variantCandidate, reflowLadders } from "../reflow";
import type { SlideLayout } from "@hc/schema";

const layout: SlideLayout = {
  id: "l-content",
  masterId: "m",
  name: "Title and content",
  placeholders: [
    { id: "ph-title", role: "title", rect: { x: 100, y: 80, width: 1720, height: 140 } },
    { id: "ph-content", role: "content", rect: { x: 100, y: 280, width: 1720, height: 640 } },
  ],
} as SlideLayout;

const slot = (placeholderId: string, fontSize: number, paragraphs: string[], rect = { width: 1720, height: 640 }) => ({
  nodeId: `n-${placeholderId}`,
  placeholderId,
  rect,
  fontSize,
  paragraphs,
});

describe("reflowPage (F40 E15)", () => {
  it("steps a crowded content slot DOWN the ladder and reports fits", () => {
    const many = Array.from({ length: 14 }, (_, i) => `Bullet point number ${i + 1} with a reasonably long sentence that wraps a couple of times in the slot`);
    const r = reflowPage(layout, [slot("ph-content", 20, many, { width: 860, height: 420 })]);
    expect(r.changed).toBe(true);
    const adj = r.adjustments.find((a) => a.nodeId === "n-ph-content")!;
    expect(adj.fontSize).toBeLessThan(20);
    expect(reflowLadders.content).toContain(adj.fontSize);
  });

  it("steps BACK UP when content shrinks (never past the role cap)", () => {
    const r = reflowPage(layout, [slot("ph-content", 12, ["one short point"])]);
    const adj = r.adjustments.find((a) => a.nodeId === "n-ph-content")!;
    expect(adj.fontSize).toBe(20);
  });

  it("treats a hand-enlarged size as the ceiling: kept while it fits, stepped from when it does not", () => {
    const fitsBig = reflowPage(layout, [slot("ph-title", 72, ["Short"], { width: 1720, height: 140 })]);
    expect(fitsBig.adjustments).toHaveLength(0);
    const crowded = reflowPage(layout, [
      slot("ph-title", 72, ["A very long hand-styled headline that cannot possibly fit at seventy-two pixels in one thin strip of slide"], { width: 900, height: 100 }),
    ]);
    const adj = crowded.adjustments.find((a) => a.nodeId === "n-ph-title");
    expect(adj).toBeTruthy();
    expect(adj!.fontSize).toBeLessThan(72);
  });

  it("verdicts: overfull past the floor, underfull for a sparse content slot, empty slots fit", () => {
    const wall = Array.from({ length: 80 }, () => "A dense paragraph of text that keeps going and going and takes several wrapped lines all by itself in the box");
    const over = reflowPage(layout, [slot("ph-content", 20, wall, { width: 600, height: 200 })]);
    expect(over.verdicts["ph-content"]).toBe("overfull");
    const under = reflowPage(layout, [slot("ph-content", 20, ["tiny"], { width: 1720, height: 640 })]);
    expect(under.verdicts["ph-content"]).toBe("underfull");
    const empty = reflowPage(layout, [slot("ph-content", 20, [""])]);
    expect(empty.verdicts["ph-content"]).toBe("fits");
    expect(empty.adjustments).toHaveLength(0);
  });

  it("keeps a deliberate OFF-ladder size while it fits, steps below it when it does not", () => {
    // 19 sits between ladder steps: a user's explicit choice. Fitting content
    // must not be "corrected" up to 20.
    const fitting = reflowPage(layout, [slot("ph-content", 19, ["one short point"])]);
    expect(fitting.adjustments).toHaveLength(0);
    const many = Array.from({ length: 40 }, () => "A long wrapped line of body copy that keeps going for quite a while in the box");
    const crowded = reflowPage(layout, [slot("ph-content", 19, many, { width: 700, height: 300 })]);
    const adj = crowded.adjustments.find((a) => a.nodeId === "n-ph-content");
    expect(adj).toBeTruthy();
    expect(adj!.fontSize).toBeLessThan(19);
    expect(reflowLadders.content).toContain(adj!.fontSize);
  });

  it("ignores roles without a ladder", () => {
    const withPic: SlideLayout = {
      ...layout,
      placeholders: [...layout.placeholders, { id: "ph-pic", role: "picture", rect: { x: 0, y: 0, width: 100, height: 100 } }],
    } as SlideLayout;
    const r = reflowPage(withPic, [slot("ph-pic", 20, ["irrelevant"])]);
    expect(r.adjustments).toHaveLength(0);
    expect(r.verdicts["ph-pic"]).toBeUndefined();
  });
});

describe("variantCandidate (F40 E17)", () => {
  const L = (id: string, contentCount: number): SlideLayout => ({
    id,
    masterId: "m",
    name: id,
    placeholders: [
      { id: "t", role: "title", rect: { x: 0, y: 0, width: 100, height: 20 } },
      ...Array.from({ length: contentCount }, (_, i) => ({ id: `c${i}`, role: "content" as const, rect: { x: 0, y: 30 + i * 30, width: 100, height: 20 } })),
    ],
  } as SlideLayout);
  const layouts = [L("one", 1), L("two", 2), L("four", 4)];

  it("picks the nearest denser layout for overfull, sparser for underfull", () => {
    expect(variantCandidate(layouts, "one", "denser")?.id).toBe("two");
    expect(variantCandidate(layouts, "four", "sparser")?.id).toBe("two");
    expect(variantCandidate(layouts, "four", "denser")).toBeNull();
    expect(variantCandidate(layouts, "one", "sparser")).toBeNull();
  });
});
