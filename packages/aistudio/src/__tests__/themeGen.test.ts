import { describe, expect, it } from "vitest";
import { contrastRatio, fromHex } from "@hc/color";
import {
  buildGeneratedTheme,
  deriveThemeSlots,
  generatedThemeSchema,
  ladderStep,
  layoutDesign,
  repairThemeSlots,
  themeContrastFailures,
  themeFontFamilies,
  themeIdFor,
  themeRecordFromDeckTheme,
  themeSlotNames,
  type ThemeSlots,
} from "../index";
import type { DeckTheme } from "../outline";

const ratio = (a: string, b: string) => contrastRatio(fromHex(a)!, fromHex(b)!);

describe("T19 theme derivation ladder", () => {
  it("steps toward dark and light with clamping at the ends", () => {
    expect(ladderStep(0.97, 1, "darker")).toBe(0.93);
    expect(ladderStep(0.97, 2, "darker")).toBe(0.86);
    expect(ladderStep(0.97, 1, "lighter")).toBe(0.97); // clamped at the light end
    expect(ladderStep(0.3, 3, "darker")).toBe(0.3); // clamped at the dark end
  });

  it("derives a full palette from a single primary, light and dark", () => {
    for (const mode of ["light", "dark"] as const) {
      const slots = deriveThemeSlots({ primary: "#1f3a93" }, mode);
      for (const name of themeSlotNames) expect(slots[name]).toMatch(/^#[0-9a-f]{6}$/);
      // A dark-blue primary on dark paper legitimately needs the repair pass;
      // derive + repair is the pipeline buildGeneratedTheme runs.
      expect(themeContrastFailures(repairThemeSlots(slots, mode))).toEqual([]);
      // Paper lands on the requested side of the dark threshold.
      const paperIsDark = ratio(slots.paper, "#000000") < ratio(slots.paper, "#ffffff");
      expect(paperIsDark).toBe(mode === "dark");
    }
  });

  it("keeps provided seeds verbatim", () => {
    const slots = deriveThemeSlots({ primary: "#b91c1c", paper: "#fffbeb", ink: "#292524" }, "light");
    expect(slots.primary).toBe("#b91c1c");
    expect(slots.paper).toBe("#fffbeb");
    expect(slots.ink).toBe("#292524");
  });

  it("is deterministic", () => {
    const a = deriveThemeSlots({ primary: "#0f766e" }, "light");
    const b = deriveThemeSlots({ primary: "#0f766e" }, "light");
    expect(a).toEqual(b);
  });
});

describe("T19 contrast validation and repair", () => {
  it("flags unreadable ink and low-contrast primary", () => {
    const bad: ThemeSlots = {
      primary: "#fefefe",
      accent: "#cccccc",
      deep: "#888888",
      tint: "#f8f8f8",
      ink: "#eeeeee",
      paper: "#ffffff",
    };
    const failing = themeContrastFailures(bad);
    expect(failing).toContain("ink");
    expect(failing).toContain("primary");
  });

  it("repair always yields an AA-passing palette, even from adversarial input", () => {
    const adversarial: ThemeSlots[] = [
      { primary: "#ffffff", accent: "#ffffff", deep: "#ffffff", tint: "#ffffff", ink: "#ffffff", paper: "#ffffff" },
      { primary: "#000000", accent: "#000000", deep: "#000000", tint: "#000000", ink: "#000000", paper: "#000000" },
      { primary: "#f4e883", accent: "#fef9c3", deep: "#fde047", tint: "#fefce8", ink: "#fef08a", paper: "#fffbeb" },
    ];
    for (const slots of adversarial) {
      for (const mode of ["light", "dark"] as const) {
        const repaired = repairThemeSlots(slots, mode);
        expect(themeContrastFailures(repaired)).toEqual([]);
        expect(ratio(repaired.ink, repaired.paper)).toBeGreaterThanOrEqual(4.5);
        expect(ratio(repaired.primary, repaired.paper)).toBeGreaterThanOrEqual(3.0);
      }
    }
  });

  it("a passing palette is returned untouched", () => {
    const good = deriveThemeSlots({ primary: "#1f3a93" }, "light");
    expect(repairThemeSlots(good, "light")).toEqual(good);
  });
});

describe("T19 buildGeneratedTheme", () => {
  it("accepts a valid model reply verbatim", () => {
    const theme = buildGeneratedTheme(
      {
        name: "Warm Editorial",
        mode: "light",
        colors: { primary: "#b45309", accent: "#d97706", ink: "#292524", paper: "#fffbeb" },
        fontHeading: "Fraunces",
        fontBody: "Nunito",
      },
      { id: "theme-x" },
    );
    expect(theme.id).toBe("theme-x");
    expect(theme.name).toBe("Warm Editorial");
    expect(theme.fontHeading).toBe("Fraunces");
    expect(theme.fontBody).toBe("Nunito");
    expect(theme.colors).toHaveLength(6);
    expect(theme.colors[0].name).toBe("primary");
  });

  it("drops bad hexes and off-list fonts, and still passes contrast", () => {
    const theme = buildGeneratedTheme(
      {
        name: "x",
        mode: "dark",
        colors: { primary: "#12345", accent: "not-a-color", ink: "#0f0f0f", paper: "#111827" },
        fontHeading: "Comic Sans MS",
        fontBody: 42,
      },
      { id: "theme-y" },
    );
    // ink #0f0f0f on dark paper fails AA and must have been repaired.
    const byName = Object.fromEntries(theme.colors.map((c) => [c.name, c]));
    const hex = (c: { color: { srgb: { r: number; g: number; b: number } } }) => {
      const ch = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
      return `#${ch(c.color.srgb.r)}${ch(c.color.srgb.g)}${ch(c.color.srgb.b)}`;
    };
    expect(ratio(hex(byName.ink), hex(byName.paper))).toBeGreaterThanOrEqual(4.5);
    expect(theme.fontHeading).toBe("Inter");
    expect(theme.fontBody).toBe("Inter");
  });

  it("never throws on garbage", () => {
    for (const raw of [null, undefined, 7, "x", [], { colors: "nope" }]) {
      const theme = buildGeneratedTheme(raw, { id: "t" });
      expect(theme.colors).toHaveLength(6);
    }
  });

  it("schema constrains fonts to the allowlist and hexes to 6 digits", () => {
    const schema = generatedThemeSchema() as {
      properties: { fontHeading: { enum: string[] }; colors: { properties: { primary: { pattern: string } } } };
    };
    expect(schema.properties.fontHeading.enum).toEqual([...themeFontFamilies]);
    expect(new RegExp(schema.properties.colors.properties.primary.pattern).test("#aabbcc")).toBe(true);
    expect(new RegExp(schema.properties.colors.properties.primary.pattern).test("#abc")).toBe(false);
  });
});

describe("T19 theme record from a generated deck", () => {
  it("carries the exact ink the layout engine paints (solid and gradient)", () => {
    const decks: DeckTheme[] = [
      { background: { kind: "solid", color: "#1f3a93" }, fontHeading: "Poppins", fontBody: "Source Sans 3" },
      { background: { kind: "gradient", color: "#0f766e", color2: "#134e4a", angle: 135 } },
    ];
    for (const deck of decks) {
      const record = themeRecordFromDeckTheme(deck);
      const ink = record.colors.find((c) => c.name === "ink")!.color;
      // The engine's own pick for the same background: lay out one body block
      // and read the run color it paints.
      const laid = layoutDesign(
        { layout: "centered", background: deck.background, blocks: [{ role: "body", text: "Hello" }], dir: "ltr" },
        { width: 1920, height: 1080 },
      );
      const painted = (laid.nodes[0] as { content: { runs: { style: { fill: { color: { srgb: unknown } } } }[] }[] })
        .content[0].runs[0].style.fill.color;
      expect(ink.srgb).toEqual(painted.srgb as never);
    }
  });

  it("primary and paper are the painted background; a gradient's second stop is the accent", () => {
    const record = themeRecordFromDeckTheme({
      background: { kind: "gradient", color: "#7c3aed", color2: "#4c1d95", angle: 200 },
    });
    const byName = Object.fromEntries(record.colors.map((c) => [c.name, c.color]));
    expect(byName.primary.srgb).toEqual(fromHex("#7c3aed")!.srgb);
    expect(byName.paper.srgb).toEqual(fromHex("#7c3aed")!.srgb);
    expect(byName.accent.srgb).toEqual(fromHex("#4c1d95")!.srgb);
  });

  it("id is stable for the same inputs and distinct across palettes", () => {
    const a = themeRecordFromDeckTheme({ background: { kind: "solid", color: "#1f3a93" } });
    const b = themeRecordFromDeckTheme({ background: { kind: "solid", color: "#1f3a93" } });
    const c = themeRecordFromDeckTheme({ background: { kind: "solid", color: "#b91c1c" } });
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(c.id);
    expect(themeIdFor("p", ["x"])).toBe(themeIdFor("p", ["x"]));
  });
});
