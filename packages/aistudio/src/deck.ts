// F39 Phase 2 - assemble a whole multi-page design from an outline + a theme.
// Pure: turns each OutlineItem into a laid-out page (background + nodes) via the
// Phase 1 engine, so the store just persists the result as new pages. Cover
// pages can use a distinct emphasis while the rest share the system.

import { layoutDesign, type LayoutResult, type Size } from "./layout";
import { qualityCheck, type QualityReport } from "./quality";
import { outlineItemToSpec, type DeckTheme, type DesignOutline } from "./outline";

export interface DeckPage extends LayoutResult {
  name: string;
  quality: QualityReport;
}

export interface DeckResult {
  title: string;
  pages: DeckPage[];
}

/** Lay out every outline page into a DeckPage. `dir` propagates RTL. */
export function layoutDeck(
  outline: DesignOutline,
  theme: DeckTheme,
  size: Size,
  opts?: { dir?: "ltr" | "rtl" },
): DeckResult {
  // Default the kicker to the deck title so content pages carry it, unless the
  // theme already set one.
  const themed: DeckTheme = { ...theme, kicker: theme.kicker ?? outline.title };
  const pages: DeckPage[] = outline.pages.map((item, i) => {
    const spec = outlineItemToSpec(item, themed, { ...opts, index: i });
    const laid = layoutDesign(spec, size);
    return {
      ...laid,
      name: item.title || `Page ${i + 1}`,
      quality: qualityCheck({ ...laid, size }),
    };
  });
  return { title: outline.title, pages };
}
