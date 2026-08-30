// F40 E15: the pure reflow engine. Deterministic ladder stepping, both
// directions, hand-styled ceilings, and the over/underflow verdicts that
// drive the E17 variant proposal.
import { describe, expect, it } from "vitest";
import { reflowPage, variantCandidate } from "../reflow";
import { ladderFrom, slotTypeScale } from "../deckStyle";
import type { SlideLayout } from "@hc/schema";

const PAGE = { width: 1920, height: 1080 };

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
  it("steps a crowded content slot DOWN its geometry ladder", () => {
    const rect = { width: 860, height: 420 };
    const scale = slotTypeScale("content", rect, PAGE);
    const many = Array.from({ length: 14 }, (_, i) => `Bullet point number ${i + 1} with a reasonably long sentence that wraps a couple of times in the slot`);
    const r = reflowPage(layout, [slot("ph-content", scale.base, many, rect)], PAGE);
    expect(r.changed).toBe(true);
    const adj = r.adjustments.find((a) => a.nodeId === "n-ph-content")!;
    expect(adj.fontSize).toBeLessThan(scale.base);
    expect(scale.ladder).toContain(adj.fontSize);
  });

  it("sizes from the SLOT, not fixed pixels: a 1080-tall deck gets deck-sized type", () => {
    // The whole point of the geometry scale: 20px body copy on a 1920x1080
    // slide is fine print. A content slot two thirds of the page tall must
    // land in presentation range (~3-4% of page height), not at 20px.
    const scale = slotTypeScale("content", { width: 1720, height: 640 }, PAGE);
    expect(scale.base).toBeGreaterThan(PAGE.height * 0.03);
    const title = slotTypeScale("title", { width: 1720, height: 151 }, PAGE);
    expect(title.base).toBeGreaterThan(PAGE.height * 0.055);
    // The same layout on a small canvas scales down instead of overflowing.
    const small = { width: 480, height: 270 };
    expect(slotTypeScale("title", { width: 430, height: 38 }, small).base).toBeLessThan(title.base / 2);
  });

  it("steps BACK UP when content shrinks (never past the slot's own cap)", () => {
    const rect = { width: 1720, height: 640 };
    const scale = slotTypeScale("content", rect, PAGE);
    const stepped = scale.ladder[3];
    const r = reflowPage(layout, [slot("ph-content", stepped, ["one short point"], rect)], PAGE);
    const adj = r.adjustments.find((a) => a.nodeId === "n-ph-content")!;
    expect(adj.fontSize).toBe(scale.base);
  });

  it("treats a hand-enlarged size as the ceiling: kept while it fits, stepped from when it does not", () => {
    const fitsBig = reflowPage(layout, [slot("ph-title", 72, ["Short"], { width: 1720, height: 140 })], PAGE);
    expect(fitsBig.adjustments).toHaveLength(0);
    const crowded = reflowPage(layout, [
      slot("ph-title", 72, ["A very long hand-styled headline that cannot possibly fit at seventy-two pixels in one thin strip of slide"], { width: 900, height: 100 }),
    ], PAGE);
    const adj = crowded.adjustments.find((a) => a.nodeId === "n-ph-title");
    expect(adj).toBeTruthy();
    expect(adj!.fontSize).toBeLessThan(72);
  });

  it("verdicts: overfull past the floor, underfull for a sparse content slot, empty slots fit", () => {
    const wall = Array.from({ length: 80 }, () => "A dense paragraph of text that keeps going and going and takes several wrapped lines all by itself in the box");
    const over = reflowPage(layout, [slot("ph-content", 20, wall, { width: 600, height: 200 })], PAGE);
    expect(over.verdicts["ph-content"]).toBe("overfull");
    const under = reflowPage(layout, [slot("ph-content", 20, ["tiny"], { width: 1720, height: 640 })], PAGE);
    expect(under.verdicts["ph-content"]).toBe("underfull");
    const empty = reflowPage(layout, [slot("ph-content", 20, [""])], PAGE);
    expect(empty.verdicts["ph-content"]).toBe("fits");
    expect(empty.adjustments).toHaveLength(0);
  });

  it("keeps a deliberate OFF-ladder size while it fits, steps below it when it does not", () => {
    // 19 sits between the slot's ladder steps: a user's explicit choice.
    // Fitting content must not be "corrected" up to the slot's base.
    expect(slotTypeScale("content", { width: 1720, height: 640 }, PAGE).ladder).not.toContain(19);
    const fitting = reflowPage(layout, [slot("ph-content", 19, ["one short point"])], PAGE);
    expect(fitting.adjustments).toHaveLength(0);
    const many = Array.from({ length: 40 }, () => "A long wrapped line of body copy that keeps going for quite a while in the box");
    const crowded = reflowPage(layout, [slot("ph-content", 19, many, { width: 700, height: 300 })], PAGE);
    const adj = crowded.adjustments.find((a) => a.nodeId === "n-ph-content");
    expect(adj).toBeTruthy();
    expect(adj!.fontSize).toBeLessThan(19);
    // It steps down the ladder derived from the USER'S size, never the slot's.
    expect(ladderFrom(19, PAGE)).toContain(adj!.fontSize);
  });

  it("ignores roles without a ladder", () => {
    const withPic: SlideLayout = {
      ...layout,
      placeholders: [...layout.placeholders, { id: "ph-pic", role: "picture", rect: { x: 0, y: 0, width: 100, height: 100 } }],
    } as SlideLayout;
    const r = reflowPage(withPic, [slot("ph-pic", 20, ["irrelevant"])], PAGE);
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
