// Theme conversions between the catalog, a file's T19 theme record, a design
// system and the generation DeckTheme. Split from compose.ts so a caller that
// only converts themes (the editor's generation panel) does not load the
// composer with it (#77); compose.ts re-exports these.

import { themeFromPalette, type Color, type Theme } from "@hc/schema";
import type { DeckTheme } from "./outline";
import { themeSlotNames } from "./themeGen";
import { designSystemSlots, type DesignSystem } from "./designSystem";
import type { ThemeCatalogEntry } from "./themeCatalog";

/** A T19 theme record as a generation DeckTheme (the template path's
 *  counterpart of deckThemeFromCatalog): deep-to-primary gradient, pair fonts.
 *  Slots resolve by NAME so a hand-edited record still reads correctly. */
export function deckThemeFromRecord(rec: Theme, kicker?: string): DeckTheme {
  const slot = (name: string) => rec.colors.find((c) => c.name === name)?.color;
  const toHex6 = (c: Color | undefined, fallback: string) => {
    if (!c) return fallback;
    const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
    return `#${h(c.srgb.r)}${h(c.srgb.g)}${h(c.srgb.b)}`;
  };
  const deep = toHex6(slot("deep") ?? rec.colors[2]?.color, "#1f2937");
  const primary = toHex6(slot("primary") ?? rec.colors[0]?.color, "#334155");
  return {
    background: { kind: "gradient", color: deep, color2: primary, angle: 145 },
    kicker,
    fontHeading: rec.fontHeading,
    fontBody: rec.fontBody,
  };
}

/** A catalog entry as a generation DeckTheme: the deep-to-primary gradient
 *  reads as the theme's identity at deck scale (the same construction the
 *  reference-image transfer uses), and the pair fonts ride along. */
export function deckThemeFromCatalog(entry: ThemeCatalogEntry, kicker?: string): DeckTheme {
  const [primary, , deep] = entry.colors;
  return {
    background: { kind: "gradient", color: deep, color2: primary, angle: 145 },
    kicker,
    fontHeading: entry.fontHeading,
    fontBody: entry.fontBody,
  };
}

/** A catalog entry as a T19 Theme record (the file's theme field). */
export function themeRecordFromCatalog(entry: ThemeCatalogEntry): Theme {
  return themeFromPalette(
    entry.id,
    entry.colors.map((hex, i) => ({
      id: `${entry.id}-${i}`,
      name: themeSlotNames[i],
      color: hexToColor(hex),
    })),
    { name: entry.name, fontHeading: entry.fontHeading, fontBody: entry.fontBody },
  );
}

function hexToColor(hex: string): { srgb: { r: number; g: number; b: number; a: number } } {
  const n = parseInt(hex.slice(1), 16);
  return { srgb: { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 } };
}

/** The file theme record for a deck composed from a design system: the very
 *  six slots the pages were painted with. Used by the API and the editor so
 *  the theme picker shows the same palette whichever door made the deck. */
export function themeRecordFromDesignSystem(system: DesignSystem, theme: DeckTheme, mood: string): Theme {
  // The record carries the pairing the pages were SET in, which for an
  // unbranded deck is the system's seeded pairing, not the theme's empty fonts.
  return themeRecordFromSlots(designSystemSlots(system), { ...theme, fontHeading: system.fonts.heading, fontBody: system.fonts.body }, mood);
}

/** The record for a deck painted from these six slots (or, without them, from
 *  its background). */
export function themeRecordFromSlots(slots: [string, string, string, string, string, string] | null, theme: DeckTheme, mood: string): Theme {
  const name = mood ? mood.slice(0, 40) : undefined;
  if (!slots) {
    // No system (template path stamps its own record earlier): fall back to
    // the background-derived record.
    return themeFromPalette("generated", [{ id: "generated-0", name: "primary", color: hexToColor(theme.background.color ?? "#1f2937") }], { name, fontHeading: theme.fontHeading, fontBody: theme.fontBody });
  }
  return themeFromPalette(
    "generated",
    slots.map((hex, i) => ({ id: `generated-${i}`, name: themeSlotNames[i], color: hexToColor(hex) })),
    { name, fontHeading: theme.fontHeading, fontBody: theme.fontBody },
  );
}
