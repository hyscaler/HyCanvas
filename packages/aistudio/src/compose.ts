// Headless deck composition (F40 E03). One pure function from a generated
// outline to a complete, validating DesignFile: the exact pipeline the editor
// panel's freeform path runs (normalizeOutline -> seeded deckThemes ->
// layoutDeck -> pages), packaged so the Go server can execute it under goja
// (backend/internal/composer) and the generation API can mint decks with no
// browser in the loop. Deterministic BY CONTRACT: no Math.random, no
// Date.now; node ids come from the environment's crypto.randomUUID, which the
// goja entry and the parity test both replace with a counter, so the same
// input composes to the same bytes on both runtimes.

import { currentSchemaVersion, type DesignFile, type Page } from "@hc/schema";
import { normalizeOutline } from "./outline";
import { deckThemes } from "./theme";
import { layoutDeck } from "./deck";
import { themeRecordFromDeckTheme } from "./themeGen";

export interface ComposeDeckInput {
  /** The generated outline, exactly as the server outline endpoint returns it
   *  (normalizeOutline is tolerant of the raw model/job JSON). */
  outline: unknown;
  width: number;
  height: number;
  /** Brand palette hexes; seeds the theme like the panel's brand grounding. */
  brandPalette?: string[];
  dir?: "ltr" | "rtl";
}

/** Compose a full design file from an outline. Pages are fully laid out
 *  (background + nodes + speaker notes); the theme record is stamped so the
 *  theme picker reflects the generated visual system (T19). The file id is a
 *  placeholder: persistence.Create assigns the real id at the write boundary. */
export function composeDeckFile(input: ComposeDeckInput): DesignFile {
  const outline = normalizeOutline(input.outline);
  const width = Math.max(1, Math.round(input.width));
  const height = Math.max(1, Math.round(input.height));
  // The same title-seeded hue selection as the editor panel, so the API and
  // the panel generate the same deck for the same brief.
  const seed = Array.from(outline.title).reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7);
  const theme = deckThemes({ brandPalette: input.brandPalette ?? [], kicker: outline.title, count: 1, seed })[0];
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
    theme: themeRecordFromDeckTheme(theme, { name: outline.theme ? outline.theme.slice(0, 40) : undefined }),
  } as unknown as DesignFile;
  return file;
}
