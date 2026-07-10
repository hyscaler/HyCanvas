import { describe, it, expect } from "vitest";
import { createBlankDesign } from "../factory";
import { CURRENT_SCHEMA_VERSION, type DesignFile } from "../schema";
import { migrate } from "../migrate";
import { validate } from "../validate";
import { fromDesignFile, toDesignFile } from "../yjs";
import {
  groupPagesBySection,
  isSectionCollapsed,
  nextSectionStart,
  pagesInSection,
  prevSectionStart,
  sectionForPage,
  sectionTitle,
} from "../sections";

/** A deck of `n` pages; `assign` maps page index -> sectionId. */
function deck(n: number, assign: Record<number, string> = {}, sections: { id: string; name: string; collapsed?: boolean }[] = []): DesignFile {
  const file = createBlankDesign({ title: "Deck", width: 800, height: 600 });
  file.pages = Array.from({ length: n }, (_, i) => ({
    ...structuredClone(file.pages[0]),
    id: `p${i}`,
    name: `Slide ${i + 1}`,
    ...(assign[i] ? { sectionId: assign[i] } : {}),
  }));
  if (sections.length) file.sections = sections;
  return file;
}

describe("schema v13", () => {
  it("the v12 -> v13 migration step is purely additive", () => {
    // Target v13 explicitly rather than CURRENT_SCHEMA_VERSION: this test is
    // about THIS step, and must not break every time a later version lands.
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(13);
    const v12 = { ...createBlankDesign({ title: "Old", width: 800, height: 600 }), schemaVersion: 12 };
    const migrated = migrate(v12 as unknown as DesignFile, 13);
    expect(migrated.schemaVersion).toBe(13);
    expect({ ...migrated, schemaVersion: 12 }).toEqual(v12);
  });

  it("opens a v12 deck with no sections (zero data loss)", () => {
    const old = { ...createBlankDesign({ title: "Old", width: 800, height: 600 }), schemaVersion: 12 };
    const migrated = migrate(old as unknown as DesignFile);
    expect(validate(migrated).ok).toBe(true);
    expect(migrated.sections).toBeUndefined();
    expect(migrated.pages[0].sectionId).toBeUndefined();
  });

  it("validates a deck carrying sections", () => {
    const d = deck(2, { 0: "s1", 1: "s1" }, [{ id: "s1", name: "Intro" }]);
    expect(validate(d).ok).toBe(true);
  });

  it("survives a Yjs CRDT round-trip", () => {
    const d = deck(2, { 0: "s1" }, [{ id: "s1", name: "Intro", collapsed: true }]);
    const back = toDesignFile(fromDesignFile(d));
    expect(back.sections).toEqual(d.sections);
    expect(back.pages[0].sectionId).toBe("s1");
  });
});

describe("groupPagesBySection (every page appears exactly once)", () => {
  it("is one unsectioned group when the deck has no sections", () => {
    const groups = groupPagesBySection(deck(3));
    expect(groups).toHaveLength(1);
    expect(groups[0].section).toBeUndefined();
    expect(groups[0].pageIndices).toEqual([0, 1, 2]);
  });

  it("splits consecutive runs", () => {
    const d = deck(4, { 0: "a", 1: "a", 2: "b", 3: "b" }, [{ id: "a", name: "A" }, { id: "b", name: "B" }]);
    const groups = groupPagesBySection(d);
    expect(groups.map((g) => g.section?.id)).toEqual(["a", "b"]);
    expect(groups.map((g) => g.pageIndices)).toEqual([[0, 1], [2, 3]]);
  });

  it("keeps slides before the first section in their own group", () => {
    const d = deck(3, { 1: "a", 2: "a" }, [{ id: "a", name: "A" }]);
    const groups = groupPagesBySection(d);
    expect(groups[0].section).toBeUndefined();
    expect(groups[0].pageIndices).toEqual([0]);
    expect(groups[1].pageIndices).toEqual([1, 2]);
  });

  it("surfaces a non-contiguous section as two runs rather than reordering slides", () => {
    const d = deck(3, { 0: "a", 2: "a" }, [{ id: "a", name: "A" }]);
    const groups = groupPagesBySection(d);
    expect(groups.map((g) => g.pageIndices)).toEqual([[0], [1], [2]]);
    expect(groups[0].section?.id).toBe("a");
    expect(groups[2].section?.id).toBe("a");
  });

  it("treats a dangling sectionId as unsectioned rather than throwing", () => {
    const d = deck(2, { 0: "ghost" }, [{ id: "a", name: "A" }]);
    const groups = groupPagesBySection(d);
    expect(groups).toHaveLength(1);
    expect(groups[0].section).toBeUndefined();
    expect(groups[0].pageIndices).toEqual([0, 1]);
  });

  it("never drops or duplicates a page", () => {
    const d = deck(5, { 1: "a", 2: "a", 4: "b" }, [{ id: "a", name: "A" }, { id: "b", name: "B" }]);
    const all = groupPagesBySection(d).flatMap((g) => g.pageIndices);
    expect(all.sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(all).size).toBe(5);
  });

  it("handles an empty deck", () => {
    const d = deck(0);
    expect(groupPagesBySection(d)).toEqual([]);
  });
});

describe("lookups", () => {
  const d = deck(3, { 0: "a", 1: "a", 2: "b" }, [{ id: "a", name: "Intro", collapsed: true }, { id: "b", name: "Body" }]);

  it("resolves a page's section, and undefined for a dangling id", () => {
    expect(sectionForPage(d, d.pages[0])!.name).toBe("Intro");
    const ghost = { ...d.pages[0], sectionId: "nope" };
    expect(sectionForPage(d, ghost)).toBeUndefined();
  });

  it("lists a section's pages in deck order", () => {
    expect(pagesInSection(d, "a")).toEqual([0, 1]);
    expect(pagesInSection(d, "missing")).toEqual([]);
  });

  it("reports the collapsed flag", () => {
    expect(isSectionCollapsed(d, "a")).toBe(true);
    expect(isSectionCollapsed(d, "b")).toBe(false);
    expect(isSectionCollapsed(d, undefined)).toBe(false);
  });
});

describe("section-aware navigation", () => {
  const d = deck(5, { 0: "a", 1: "a", 2: "b", 3: "b", 4: "c" }, [
    { id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" },
  ]);

  it("jumps to the first slide of the next section from anywhere inside one", () => {
    expect(nextSectionStart(d, 0)).toBe(2);
    expect(nextSectionStart(d, 1)).toBe(2); // mid-section still jumps ahead
    expect(nextSectionStart(d, 2)).toBe(4);
  });

  it("returns -1 past the last section", () => {
    expect(nextSectionStart(d, 4)).toBe(-1);
  });

  it("jumps back to the start of the previous section", () => {
    expect(prevSectionStart(d, 2)).toBe(0);
    expect(prevSectionStart(d, 4)).toBe(2);
    expect(prevSectionStart(d, 0)).toBe(-1);
  });

  it("is a no-op on an unsectioned deck", () => {
    const plain = deck(3);
    expect(nextSectionStart(plain, 0)).toBe(-1);
    expect(prevSectionStart(plain, 2)).toBe(-1);
  });
});

describe("sectionTitle", () => {
  it("uses the name, else a positional fallback", () => {
    expect(sectionTitle({ id: "a", name: "Intro" }, 0)).toBe("Intro");
    expect(sectionTitle({ id: "a", name: "   " }, 2)).toBe("Section 3");
    expect(sectionTitle(undefined, 0)).toBe("Untitled section");
  });
});
