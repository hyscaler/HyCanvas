// Headless deck composition (F40 E03). One pure function from a generated
// outline to a complete, validating DesignFile: the exact pipeline the editor
// panel's freeform path runs (normalizeOutline -> seeded deckThemes ->
// layoutDeck -> pages), packaged so the Go server can execute it under goja
// (backend/internal/composer) and the generation API can mint decks with no
// browser in the loop. Deterministic BY CONTRACT: no Math.random, no
// Date.now; node ids come from the environment's crypto.randomUUID, which the
// goja entry and the parity test both replace with a counter, so the same
// input composes to the same bytes on both runtimes.

import { currentSchemaVersion, themeFromPalette, type DesignFile, type Page, type Theme } from "@hc/schema";
import { normalizeOutline } from "./outline";
import { deckThemes } from "./theme";
import { layoutDeck } from "./deck";
import { themeRecordFromDeckTheme, themeSlotNames } from "./themeGen";
import { themeCatalogEntry, type ThemeCatalogEntry } from "./themeCatalog";
import type { DeckTheme } from "./outline";

export interface ComposeDeckInput {
  /** The generated outline, exactly as the server outline endpoint returns it
   *  (normalizeOutline is tolerant of the raw model/job JSON). */
  outline: unknown;
  width: number;
  height: number;
  /** Brand palette hexes; seeds the theme like the panel's brand grounding. */
  brandPalette?: string[];
  /** A built-in catalog theme id (F40 E12): when set and known, the deck is
   *  composed on that theme instead of a title-seeded generated one, and the
   *  catalog theme record is stamped on the file. Unknown ids THROW - a
   *  caller who names a theme means it, and silence would be a wrong deck. */
  themeId?: string;
  dir?: "ltr" | "rtl";
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

/** Compose a full design file from an outline. Pages are fully laid out
 *  (background + nodes + speaker notes); the theme record is stamped so the
 *  theme picker reflects the generated visual system (T19). The file id is a
 *  placeholder: persistence.Create assigns the real id at the write boundary. */
export function composeDeckFile(input: ComposeDeckInput): DesignFile {
  const outline = normalizeOutline(input.outline);
  const width = Math.max(1, Math.round(input.width));
  const height = Math.max(1, Math.round(input.height));
  // A named catalog theme wins (E12); otherwise the same title-seeded hue
  // selection as the editor panel, so the API and the panel generate the
  // same deck for the same brief.
  let theme: DeckTheme;
  let catalogRecord: Theme | null = null;
  if (input.themeId) {
    const entry = themeCatalogEntry(input.themeId);
    if (!entry) throw new Error(`unknown themeId: ${input.themeId}`);
    theme = deckThemeFromCatalog(entry, outline.title);
    catalogRecord = themeRecordFromCatalog(entry);
  } else {
    const seed = Array.from(outline.title).reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7);
    theme = deckThemes({ brandPalette: input.brandPalette ?? [], kicker: outline.title, count: 1, seed })[0];
  }
  const deck = layoutDeck(outline, theme, { width, height }, { dir: input.dir });
  const pages: Page[] = deck.pages.map((p, i) => ({
    id: `api-page-${i + 1}`,
    name: p.name || `Page ${i + 1}`,
    width,
    height,
    background: p.background,
    children: p.nodes,
    ...(p.note ? { notes: p.note } : {}),
  }) as unknown as Page);
  const file = {
    format: "hycanvas.design",
    schemaVersion: currentSchemaVersion,
    id: "pending",
    title: outline.title,
    unit: "px",
    dpi: 96,
    pages,
    assets: [],
    fonts: [],
    theme: catalogRecord ?? themeRecordFromDeckTheme(theme, { name: outline.theme ? outline.theme.slice(0, 40) : undefined }),
  } as unknown as DesignFile;
  return file;
}
