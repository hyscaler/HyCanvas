// Markdown outline import (F28 C26): DETERMINISTIC, no AI - headings become
// slides, list items become points, laid out through the same pure deck
// builder generation uses (theme seeded from the title, no model calls).
//
// Its own module so the dashboard can load it (and the deck builder in
// @hc/aistudio behind it) only when a markdown file is actually imported.

import { catalogEntryForMood, deckThemes, layoutDeck, parseMarkdownOutline } from "@hc/aistudio";
import { createBlankDesign, type DesignFile } from "@hc/schema";

export function mdOutlineToDesign(md: string, fallbackTitle: string): DesignFile {
  const outline = parseMarkdownOutline(md, { fallbackTitle });
  if (!outline) throw new Error("no outline structure in the markdown (add headings or list items)");
  const size = { width: 1920, height: 1080 };
  const seed = Array.from(outline.title).reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7);
  const theme = deckThemes({ count: 1, kicker: outline.title, seed })[0];
  const deck = layoutDeck(outline, theme, size, { catalog: catalogEntryForMood(outline.theme, seed), seed });
  const file = createBlankDesign({ title: outline.title, width: size.width, height: size.height });
  let pageSeq = 0;
  file.pages = deck.pages.map((p, i) => ({
    id: `md-page-${++pageSeq}`,
    name: p.name || `Page ${i + 1}`,
    width: size.width,
    height: size.height,
    background: p.background,
    children: p.nodes,
    ...(p.note ? { notes: p.note } : {}),
  })) as DesignFile["pages"];
  return file;
}
