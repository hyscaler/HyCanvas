import { describe, expect, it } from "vitest";
import { diffBlocks, inlineWordDiff } from "../diff";
import { newHeading, newParagraph, type DocBlock } from "../model";

function para(id: string, text: string): DocBlock {
  return { id, type: "paragraph", text: { runs: [{ text }] } };
}

describe("inlineWordDiff", () => {
  it("marks unchanged words as same", () => {
    const spans = inlineWordDiff("the quick fox", "the quick fox");
    expect(spans.every((s) => s.op === "same")).toBe(true);
    expect(spans.map((s) => s.text).join("")).toBe("the quick fox");
  });

  it("detects an added word", () => {
    const spans = inlineWordDiff("the fox", "the quick fox");
    const added = spans.filter((s) => s.op === "add").map((s) => s.text.trim()).join("");
    expect(added).toContain("quick");
  });

  it("detects a deleted word", () => {
    const spans = inlineWordDiff("the quick fox", "the fox");
    const deleted = spans.filter((s) => s.op === "del").map((s) => s.text.trim()).join("");
    expect(deleted).toContain("quick");
  });

  it("reconstructs both sides from the spans", () => {
    const spans = inlineWordDiff("alpha beta gamma", "alpha delta gamma");
    const before = spans.filter((s) => s.op !== "add").map((s) => s.text).join("");
    const after = spans.filter((s) => s.op !== "del").map((s) => s.text).join("");
    expect(before).toBe("alpha beta gamma");
    expect(after).toBe("alpha delta gamma");
  });
});

describe("diffBlocks", () => {
  it("classifies unchanged blocks", () => {
    const a = [para("1", "hello")];
    const b = [para("1", "hello")];
    const diff = diffBlocks(a, b);
    expect(diff).toHaveLength(1);
    expect(diff[0].type).toBe("unchanged");
  });

  it("classifies added blocks", () => {
    const diff = diffBlocks([para("1", "x")], [para("1", "x"), para("2", "new")]);
    const added = diff.filter((d) => d.type === "added");
    expect(added).toHaveLength(1);
    expect(added[0].block.id).toBe("2");
  });

  it("classifies removed blocks", () => {
    const diff = diffBlocks([para("1", "x"), para("2", "gone")], [para("1", "x")]);
    const removed = diff.filter((d) => d.type === "removed");
    expect(removed).toHaveLength(1);
    expect(removed[0].block.id).toBe("2");
  });

  it("classifies modified blocks with an inline word diff", () => {
    const a = [para("1", "the quick brown fox")];
    const b = [para("1", "the slow brown fox")];
    const diff = diffBlocks(a, b);
    expect(diff[0].type).toBe("modified");
    expect(diff[0].before?.id).toBe("1");
    expect(diff[0].inline).toBeDefined();
    const ops = new Set(diff[0].inline!.map((s) => s.op));
    expect(ops.has("add")).toBe(true);
    expect(ops.has("del")).toBe(true);
    expect(ops.has("same")).toBe(true);
  });

  it("detects a heading level change as modified", () => {
    const a = [newHeading(1, "Title")];
    a[0].id = "h";
    const b = [newHeading(2, "Title")];
    b[0].id = "h";
    const diff = diffBlocks(a, b);
    expect(diff[0].type).toBe("modified");
  });

  it("handles a mix of all four classifications", () => {
    const a = [para("1", "same"), para("2", "old text"), para("3", "removed")];
    const b = [para("1", "same"), para("2", "new text"), para("4", "added")];
    const diff = diffBlocks(a, b);
    const byType = (t: string) => diff.filter((d) => d.type === t);
    expect(byType("unchanged")).toHaveLength(1);
    expect(byType("modified")).toHaveLength(1);
    expect(byType("added")).toHaveLength(1);
    expect(byType("removed")).toHaveLength(1);
  });

  it("does not attach inline diff for non-text block changes", () => {
    const a: DocBlock[] = [{ id: "1", type: "image", assetId: "a", url: "x.png" }];
    const b: DocBlock[] = [{ id: "1", type: "image", assetId: "a", url: "y.png" }];
    const diff = diffBlocks(a, b);
    expect(diff[0].type).toBe("modified");
    expect(diff[0].inline).toBeUndefined();
  });
});
