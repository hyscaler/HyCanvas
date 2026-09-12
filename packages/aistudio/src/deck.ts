// Assemble a whole multi-page design from an outline and a theme.
//
// Each outline page is composed in its archetype's form from one design
// system derived once for the deck, so the result is one system applied
// many ways rather than a stack of unrelated slides. Pure: the store just
// persists the pages. The quality report per page is the verifier that the
// composer stayed honest (no overflow, no overlap, AA contrast).

import type { Fill, Node } from "@hc/schema";
import type { Size } from "./layout";
import { qualityCheck, type QualityReport } from "./quality";
import type { Archetype, DeckTheme, DesignOutline } from "./outline";
import { deriveDesignSystem, type DesignSystem, type DeriveOptions } from "./designSystem";
import { composeArchetypePage } from "./archetypes";

export interface DeckPage {
  background: Fill;
  nodes: Node[];
  name: string;
  quality: QualityReport;
  /** Speaker note carried from the outline item; becomes Page.notes. */
  note?: string;
  /** The form the page was composed in. */
  archetype: Archetype;
  /** Placeholder id to English image prompt for every picture region on the
   *  page, so a caller can hand them to the image pipeline. */
  imagePrompts: Record<string, string>;
}

export interface DeckResult {
  title: string;
  pages: DeckPage[];
  /** The system the deck was composed from, for stamping the file's theme. */
  system: DesignSystem;
}

export type LayoutDeckOptions = DeriveOptions;

/** Lay out every outline page into a DeckPage. */
export function layoutDeck(
  outline: DesignOutline,
  theme: DeckTheme,
  size: Size,
  opts?: LayoutDeckOptions,
): DeckResult {
  // Default the kicker to the deck title so content pages carry it, unless the
  // theme already set one.
  const themed: DeckTheme = { ...theme, kicker: theme.kicker ?? outline.title };
  const system = deriveDesignSystem(themed, size, opts);
  const total = outline.pages.length;
  const pages: DeckPage[] = outline.pages.map((item, i) => {
    const composed = composeArchetypePage(item, system, { index: i, total });
    return {
      background: composed.background,
      nodes: composed.nodes,
      name: item.title || `Page ${i + 1}`,
      quality: qualityCheck({ background: composed.background, nodes: composed.nodes, size: system.size }),
      archetype: composed.archetype,
      imagePrompts: composed.imagePrompts,
      ...(item.note ? { note: item.note } : {}),
    };
  });
  return { title: outline.title, pages, system };
}
