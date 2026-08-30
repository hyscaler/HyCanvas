// Localized view over the shared built-in theme catalog (F40 E10). The DATA
// (ids, slots, fonts, style groups) lives in @hc/aistudio so headless
// generation and the Go manifest read the same source; this wrapper adds the
// translated display names and style labels the picker shows.

import { themeCatalog, type ThemeCatalogEntry, type ThemeStyleGroup } from "@hc/aistudio";
import { tr, trOr } from "@/lib/i18n";

export type { ThemeCatalogEntry, ThemeStyleGroup };

/** Display name for a catalog theme: the localized key when the catalog has
 *  one, else the entry's English name (a future theme works untranslated). */
export function themeDisplayName(t: ThemeCatalogEntry): string {
  return trOr(`editor.theme_name_${t.id.replace(/^theme-/, "")}`, t.name);
}

export function themeStyleLabel(style: ThemeStyleGroup): string {
  switch (style) {
    case "professional": return tr("editor.style_professional");
    case "editorial": return tr("editor.style_editorial");
    case "bold": return tr("editor.style_bold");
    case "minimal": return tr("editor.style_minimal");
    case "warm": return tr("editor.style_warm");
    case "tech": return tr("editor.style_tech");
    case "dark": return tr("editor.style_dark");
  }
}

/** The picker's shape: catalog entries with localized names, in catalog
 *  order (grouping happens at the render site). */
export function builtinThemes(): (ThemeCatalogEntry & { displayName: string })[] {
  return themeCatalog.map((t) => ({ ...t, displayName: themeDisplayName(t) }));
}

/** Catalog order of style groups, for a stable grouped picker. */
export const themeStyleOrder: ThemeStyleGroup[] = ["professional", "minimal", "editorial", "bold", "warm", "tech", "dark"];
