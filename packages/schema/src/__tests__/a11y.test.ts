import { describe, it, expect } from "vitest";
import { createBlankDesign, createNode } from "../factory";
import { CURRENT_SCHEMA_VERSION, type DesignFile, type Node, type Page } from "../schema";
import { migrate } from "../migrate";
import { validate } from "../validate";
import { fromDesignFile, toDesignFile } from "../yjs";
import {
  isDecorative,
  missingAltTextCount,
  moveInReadingOrder,
  needsAltText,
  nodeAltText,
  nodesNeedingAltText,
  normalizeReadingOrder,
  resolveReadingOrder,
} from "../a11y";

function shape(id: string): Node {
  const n = createNode("shape", {
    shape: "rect", opacity: 1,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 10, height: 10 },
    fills: [{ type: "solid", color: { srgb: { r: 1, g: 0, b: 0, a: 1 } } }],
  } as unknown as Partial<Node>) as Node;
  (n as { id: string }).id = id;
  return n;
}
function image(id: string, extra: Record<string, unknown> = {}): Node {
  const n = createNode("image", {
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    size: { width: 10, height: 10 },
  } as unknown as Partial<Node>) as Node;
  (n as { id: string }).id = id;
  Object.assign(n as object, extra);
  return n;
}
function pageWith(children: Node[], readingOrder?: string[]): Page {
  const file = createBlankDesign({ title: "D", width: 100, height: 100 });
  return { ...file.pages[0], children, ...(readingOrder ? { readingOrder } : {}) };
}

describe("schema v12", () => {
  it("is 12 and the v11 migration is purely additive", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(12);
    const v11 = { ...createBlankDesign({ title: "Old", width: 800, height: 600 }), schemaVersion: 11 };
    const migrated = migrate(v11 as unknown as DesignFile);
    expect(migrated.schemaVersion).toBe(12);
    expect({ ...migrated, schemaVersion: 11 }).toEqual(v11);
  });

  it("opens a v11 file with no a11y fields (zero data loss)", () => {
    const old = { ...createBlankDesign({ title: "Old", width: 800, height: 600 }), schemaVersion: 11 };
    const migrated = migrate(old as unknown as DesignFile);
    expect(validate(migrated).ok).toBe(true);
    expect(migrated.pages[0].readingOrder).toBeUndefined();
  });

  it("validates a file carrying altText, decorative, and readingOrder", () => {
    const file = createBlankDesign({ title: "D", width: 100, height: 100 });
    const a = shape("a");
    (a as { altText?: string }).altText = "A red square";
    const b = shape("b");
    (b as { decorative?: boolean }).decorative = true;
    file.pages[0].children = [a, b];
    file.pages[0].readingOrder = ["b", "a"];
    expect(validate(file).ok).toBe(true);
  });

  it("survives a Yjs CRDT round-trip", () => {
    const file = createBlankDesign({ title: "D", width: 100, height: 100 });
    const a = shape("a");
    (a as { altText?: string }).altText = "Alt";
    (a as { decorative?: boolean }).decorative = false;
    file.pages[0].children = [a];
    file.pages[0].readingOrder = ["a"];
    const back = toDesignFile(fromDesignFile(file));
    expect((back.pages[0].children[0] as { altText?: string }).altText).toBe("Alt");
    expect(back.pages[0].readingOrder).toEqual(["a"]);
  });
});

describe("resolveReadingOrder (never hides content)", () => {
  it("falls back to z-order when absent", () => {
    const p = pageWith([shape("a"), shape("b")]);
    expect(resolveReadingOrder(p).map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("honors an explicit order", () => {
    const p = pageWith([shape("a"), shape("b"), shape("c")], ["c", "a", "b"]);
    expect(resolveReadingOrder(p).map((n) => n.id)).toEqual(["c", "a", "b"]);
  });

  it("appends nodes missing from the list, in z-order", () => {
    const p = pageWith([shape("a"), shape("b"), shape("c")], ["c"]);
    expect(resolveReadingOrder(p).map((n) => n.id)).toEqual(["c", "a", "b"]);
  });

  it("ignores ids that no longer exist rather than throwing", () => {
    const p = pageWith([shape("a")], ["ghost", "a"]);
    expect(resolveReadingOrder(p).map((n) => n.id)).toEqual(["a"]);
  });

  it("ignores duplicate ids in the list", () => {
    const p = pageWith([shape("a"), shape("b")], ["a", "a", "b"]);
    expect(resolveReadingOrder(p).map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("returns every node, always", () => {
    const p = pageWith([shape("a"), shape("b"), shape("c")], ["ghost"]);
    expect(resolveReadingOrder(p)).toHaveLength(3);
  });

  it("handles an empty page", () => {
    expect(resolveReadingOrder(pageWith([]))).toEqual([]);
  });
});

describe("normalizeReadingOrder / moveInReadingOrder", () => {
  it("makes an implicit z-order explicit", () => {
    expect(normalizeReadingOrder(pageWith([shape("a"), shape("b")]))).toEqual(["a", "b"]);
  });

  it("moves a node forward and backward", () => {
    const p = pageWith([shape("a"), shape("b"), shape("c")]);
    expect(moveInReadingOrder(p, 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveInReadingOrder(p, 2, 0)).toEqual(["c", "a", "b"]);
  });

  it("is a no-op for an out-of-range or identical index", () => {
    const p = pageWith([shape("a"), shape("b")]);
    expect(moveInReadingOrder(p, 0, 0)).toEqual(["a", "b"]);
    expect(moveInReadingOrder(p, 5, 0)).toEqual(["a", "b"]);
    expect(moveInReadingOrder(p, 0, -1)).toEqual(["a", "b"]);
  });
});

describe("alt text", () => {
  it("prefers the generic altText, falling back to the legacy image alt", () => {
    expect(nodeAltText(image("i", { alt: "legacy" }))).toBe("legacy");
    expect(nodeAltText(image("i", { alt: "legacy", altText: "generic" }))).toBe("generic");
    expect(nodeAltText(image("i", { altText: "   " , alt: "legacy" }))).toBe("legacy"); // blank ignored
    expect(nodeAltText(shape("s"))).toBeUndefined();
  });

  it("treats a decorative node as needing no description", () => {
    const d = image("d", { decorative: true });
    expect(isDecorative(d)).toBe(true);
    expect(needsAltText(d)).toBe(false);
  });

  it("flags a described image as satisfied and an undescribed one as needing alt", () => {
    expect(needsAltText(image("a"))).toBe(true);
    expect(needsAltText(image("b", { altText: "A cat" }))).toBe(false);
  });

  it("does not demand alt text from a plain shape", () => {
    expect(needsAltText(shape("s"))).toBe(false);
  });

  it("lists nodes needing alt text in reading order", () => {
    const p = pageWith([image("a"), image("b"), image("c", { altText: "ok" })], ["b", "a", "c"]);
    expect(nodesNeedingAltText(p).map((n) => n.id)).toEqual(["b", "a"]);
  });

  it("counts missing descriptions across a deck", () => {
    const file = createBlankDesign({ title: "D", width: 100, height: 100 });
    file.pages[0].children = [image("a"), image("b", { decorative: true })];
    file.pages.push({ ...file.pages[0], id: "p2", children: [image("c")] });
    expect(missingAltTextCount(file)).toBe(2); // a and c; b is decorative
  });
});

// The editor's Tab navigation is defined as: reading order, minus locked,
// hidden, and decorative nodes. Pinning that composition here keeps the
// canvas and the Reading Order pane honest about being the same order.
describe("tab order = reading order minus locked/hidden/decorative", () => {
  const tabbable = (p: Page) =>
    resolveReadingOrder(p)
      .filter((n) => !n.locked && !n.hidden && !isDecorative(n))
      .map((n) => n.id);

  it("follows an explicit reading order, not z-order", () => {
    const p = pageWith([shape("a"), shape("b"), shape("c")], ["c", "a", "b"]);
    expect(tabbable(p)).toEqual(["c", "a", "b"]);
  });

  it("skips decorative, locked, and hidden nodes", () => {
    const a = shape("a");
    const b = shape("b");
    (b as { decorative?: boolean }).decorative = true;
    const c = shape("c");
    (c as { locked?: boolean }).locked = true;
    const d = shape("d");
    (d as { hidden?: boolean }).hidden = true;
    const e = shape("e");
    expect(tabbable(pageWith([a, b, c, d, e]))).toEqual(["a", "e"]);
  });

  it("still reaches a node added after the order was authored", () => {
    const p = pageWith([shape("a"), shape("b")], ["a"]);
    expect(tabbable(p)).toEqual(["a", "b"]);
  });
});
