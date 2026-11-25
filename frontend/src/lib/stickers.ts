// Bundled, free graphics/stickers ("Elements"). Each is a small,
// fill-only SVG (viewBox 0 0 100 100) so the SVG-to-vector parser (addIconSvg)
// turns it into fully editable vector nodes on insert. Kept fill-only (no
// stroke-dependent strokes) so every sticker round-trips cleanly.
//
// The sticker rows themselves (about 40 KB compressed) are in stickerLibrary.ts,
// which the Elements panel loads when it opens (#77); this module keeps the
// type and the display helpers, which cost nothing.

import { trOr } from "@/lib/i18n";

export interface Sticker {
  id: string;
  label: string;
  category: string;
  /** Lowercase search terms (synonyms, use-cases) for the Elements search. */
  keywords?: string[];
  svg: string;
}

/**
 * Category slug used to key a category name in the catalog. Kept next to the
 * lookup so the generator and the reader cannot drift.
 */
export function stickerCategorySlug(category: string): string {
  return category.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Display name for a sticker. Takes the minimum shape rather than `Sticker`,
 * because the animated set carries a preset instead of a category.
 *
 * The library is a module-scope table, so it cannot hold `tr()` calls: they
 * would be evaluated once at import and stay English whatever language the user
 * picks. The key is derived from the row's stable `id` at render time instead,
 * with the row's own English as the fallback.
 */
export function stickerLabel(s: { id: string; label: string }): string {
  return trOr(`stickers.${s.id}`, s.label);
}

/** Display name for a sticker category. */
export function stickerCategoryLabel(category: string): string {
  return trOr(`stickers.cat.${stickerCategorySlug(category)}`, category);
}
