import { describe, it, expect } from "vitest";
import { createBlankDesign } from "../factory";
import { migrate } from "../migrate";
import { validate } from "../validate";
import { fromDesignFile, toDesignFile } from "../yjs";
import { currentSchemaVersion, type DesignFile, type Theme } from "../schema";
import {
  applyTheme,
  builtinMasterAndLayouts,
  layoutForPage,
  masterForLayout,
  placeholdersForPage,
  resolvePageStyle,
  slideTitle,
  themeColor,
  themeForPage,
  themeFromPalette,
  themeVariant,
  titlePlaceholder,
} from "../theme";

const swatch = (id: string, r: number) => ({ id, color: { srgb: { r, g: 0, b: 0, a: 1 } } });
const fill = (r: number) => ({ type: "solid" as const, color: { srgb: { r, g: 0, b: 0, a: 1 } } });

/** A deck with the built-in master + layouts installed. */
function themedDeck(): DesignFile {
  const file = createBlankDesign({ title: "Deck", width: 1920, height: 1080 });
  const { master, layouts } = builtinMasterAndLayouts(file.pages[0]);
  file.masters = [master];
  file.layouts = layouts;
  file.theme = themeFromPalette("theme-1", [swatch("c0", 1), swatch("c1", 0.5)], { fontHeading: "Inter" });
  file.pages[0].layoutId = "layout-title-content";
  return file;
}

describe("schema version", () => {
  it("migrates a v10 file to the current version purely additively", () => {
    const v10 = { ...createBlankDesign({ title: "Old", width: 800, height: 600 }), schemaVersion: 10 };
    const migrated = migrate(v10 as unknown as DesignFile);
    expect(migrated.schemaVersion).toBe(currentSchemaVersion);
    // Nothing added, nothing lost: only the version changed.
    expect({ ...migrated, schemaVersion: 10 }).toEqual(v10);
  });

  it("opens a pre-master file unchanged (zero data loss)", () => {
    const old = { ...createBlankDesign({ title: "Old", width: 800, height: 600 }), schemaVersion: 10 };
    const migrated = migrate(old as unknown as DesignFile);
    expect(validate(migrated).ok).toBe(true);
    expect(migrated.masters).toBeUndefined();
    expect(migrated.layouts).toBeUndefined();
    expect(migrated.theme).toBeUndefined();
    expect(migrated.pages[0].layoutId).toBeUndefined();
  });

  it("validates a deck carrying masters, layouts, and a theme", () => {
    const res = validate(themedDeck());
    expect(res.ok).toBe(true);
  });
});

describe("cascade resolution", () => {
  it("returns no placeholders for a page with no layout (pre-master behavior)", () => {
    const file = createBlankDesign({ title: "Plain", width: 800, height: 600 });
    expect(placeholdersForPage(file, file.pages[0])).toEqual([]);
    expect(layoutForPage(file, file.pages[0])).toBeUndefined();
    expect(resolvePageStyle(file, file.pages[0]).placeholders).toEqual([]);
  });

  it("resolves the layout and its master", () => {
    const file = themedDeck();
    const layout = layoutForPage(file, file.pages[0])!;
    expect(layout.name).toBe("Title and content");
    expect(masterForLayout(file, layout)!.id).toBe("master-default");
  });

  it("tolerates a dangling layoutId rather than throwing", () => {
    const file = themedDeck();
    file.pages[0].layoutId = "layout-that-was-deleted";
    expect(layoutForPage(file, file.pages[0])).toBeUndefined();
    expect(placeholdersForPage(file, file.pages[0])).toEqual([]);
    expect(() => resolvePageStyle(file, file.pages[0])).not.toThrow();
  });

  it("merges master placeholders with the layout's, layout winning by id", () => {
    const file = themedDeck();
    const phs = placeholdersForPage(file, file.pages[0]);
    const roles = phs.map((p) => p.role).sort();
    expect(roles).toEqual(["content", "footer", "title"]); // footer from the master
  });

  it("keeps several placeholders of the same role (two-content)", () => {
    const file = themedDeck();
    file.pages[0].layoutId = "layout-two-content";
    const content = placeholdersForPage(file, file.pages[0]).filter((p) => p.role === "content");
    expect(content).toHaveLength(2);
  });

  it("prefers the page background, then layout, then master", () => {
    const file = themedDeck();
    delete file.pages[0].background; // a blank page ships with one; test the cascade
    const master = file.masters![0];
    master.background = fill(0.1);
    expect(resolvePageStyle(file, file.pages[0]).background).toEqual(fill(0.1));

    file.layouts!.find((l) => l.id === "layout-title-content")!.background = fill(0.2);
    expect(resolvePageStyle(file, file.pages[0]).background).toEqual(fill(0.2));

    file.pages[0].background = fill(0.3);
    expect(resolvePageStyle(file, file.pages[0]).background).toEqual(fill(0.3));
  });

  it("finds the title placeholder that guarantees an accessible slide title", () => {
    const file = themedDeck();
    expect(titlePlaceholder(file, file.pages[0])!.role).toBe("title");
  });
});

describe("slideTitle", () => {
  it("uses the page name when present", () => {
    const file = createBlankDesign({ title: "D", width: 800, height: 600 });
    file.pages[0].name = "Agenda";
    expect(slideTitle(file.pages[0], 0)).toBe("Agenda");
  });

  it("falls back to the deck position when the name is absent or blank", () => {
    const file = createBlankDesign({ title: "D", width: 800, height: 600 });
    delete file.pages[0].name;
    expect(slideTitle(file.pages[0], 2)).toBe("Slide 3");
    file.pages[0].name = "   ";
    expect(slideTitle(file.pages[0], 0)).toBe("Slide 1");
  });
});

describe("themes", () => {
  it("reads a color slot and tolerates an out-of-range one", () => {
    const t = themeFromPalette("t", [swatch("a", 1), swatch("b", 0)]);
    expect(themeColor(t, 0)).toEqual({ srgb: { r: 1, g: 0, b: 0, a: 1 } });
    expect(themeColor(t, 9)).toBeUndefined();
    expect(themeColor(undefined, 0)).toBeUndefined();
  });

  it("swaps the deck theme without touching page content", () => {
    const file = themedDeck();
    const before = structuredClone(file.pages);
    const next: Theme = themeFromPalette("theme-2", [swatch("z", 0.25)], { name: "Dark" });
    const out = applyTheme(file, next);
    expect(out.theme!.id).toBe("theme-2");
    expect(out.pages).toEqual(before); // content untouched: FR-4 is a style swap
    expect(file.theme!.id).toBe("theme-1"); // pure: source untouched
  });

  it("repoints masters that named the old theme", () => {
    const file = themedDeck();
    file.masters![0].theme = "theme-1";
    const out = applyTheme(file, themeFromPalette("theme-2", []));
    expect(out.masters![0].theme).toBe("theme-2");
  });

  it("leaves a master pointing at an unrelated theme alone", () => {
    const file = themedDeck();
    file.masters![0].theme = "some-other-theme";
    const out = applyTheme(file, themeFromPalette("theme-2", []));
    expect(out.masters![0].theme).toBe("some-other-theme");
  });

  it("resolves a variant as a full theme", () => {
    const t = themeFromPalette("t", [swatch("a", 1)]);
    t.variants = [{ id: "v-dark", name: "Dark", colors: [swatch("d", 0.1)] }];
    const v = themeVariant(t, "v-dark")!;
    expect(v.id).toBe("v-dark");
    expect(v.colors[0].color.srgb.r).toBeCloseTo(0.1);
    expect(v.fontHeading).toBe(t.fontHeading); // non-palette props inherited
    expect(themeVariant(t, "nope")).toBeUndefined();
  });

  it("resolves the file theme for a page", () => {
    const file = themedDeck();
    expect(themeForPage(file, file.pages[0])!.id).toBe("theme-1");
  });
});

describe("builtinMasterAndLayouts", () => {
  it("ships the five expected layouts", () => {
    const { layouts } = builtinMasterAndLayouts({ width: 1920, height: 1080 });
    expect(layouts.map((l) => l.name)).toEqual([
      "Title",
      "Title and content",
      "Two content",
      "Comparison",
      "Picture with caption",
    ]);
  });

  it("gives every layout a title placeholder (FR-3 accessible titles)", () => {
    const { layouts } = builtinMasterAndLayouts({ width: 1920, height: 1080 });
    for (const l of layouts) expect(l.placeholders.some((p) => p.role === "title")).toBe(true);
  });

  it("scales placeholder rects to the page size", () => {
    const wide = builtinMasterAndLayouts({ width: 1920, height: 1080 });
    const a4 = builtinMasterAndLayouts({ width: 1240, height: 1754 });
    const wideTitle = wide.layouts[1].placeholders[0].rect;
    const a4Title = a4.layouts[1].placeholders[0].rect;
    expect(wideTitle.width).toBeCloseTo(1920 * 0.88);
    expect(a4Title.width).toBeCloseTo(1240 * 0.88);
    // Rects stay inside the page.
    expect(wideTitle.x + wideTitle.width).toBeLessThanOrEqual(1920);
  });

  it("all layouts point at the built-in master", () => {
    const { master, layouts } = builtinMasterAndLayouts({ width: 800, height: 600 });
    for (const l of layouts) expect(l.masterId).toBe(master.id);
  });
});

describe("CRDT round-trip (collaborative edits must not drop the new fields)", () => {
  it("survives a Yjs toDoc/fromDoc round-trip", () => {
    const file = themedDeck();
    const back = toDesignFile(fromDesignFile(file));
    expect(back.masters).toEqual(file.masters);
    expect(back.layouts).toEqual(file.layouts);
    expect(back.theme).toEqual(file.theme);
    expect(back.pages[0].layoutId).toBe("layout-title-content");
  });

  it("round-trips a deck that has none of them (older file)", () => {
    const file = createBlankDesign({ title: "Plain", width: 800, height: 600 });
    const back = toDesignFile(fromDesignFile(file));
    expect(back.masters).toBeUndefined();
    expect(back.theme).toBeUndefined();
    expect(back).toEqual(file);
  });
});
