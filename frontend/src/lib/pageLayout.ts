// Continuous-scroll page stacking geometry. Single source of truth shared by the
// renderer (useEditorCanvas), the page overlays, and the store's fit/zoom math so
// they never drift apart on the gap between stacked pages.
import type { DesignFile } from "@hc/schema";

/** Vertical gap between stacked pages, in page units. */
export const PAGE_GAP = 72;

/** Cumulative top (global stacked Y) of every page. */
export function pageOffsets(doc: DesignFile): number[] {
  const offs: number[] = [];
  let y = 0;
  for (const p of doc.pages) {
    offs.push(y);
    y += p.height + PAGE_GAP;
  }
  return offs;
}

/** Global stacked top (Y) of one page index; 0 for the first page or out of range. */
export function pageTop(doc: DesignFile, index: number): number {
  let y = 0;
  for (let i = 0; i < index && i < doc.pages.length; i++) y += doc.pages[i].height + PAGE_GAP;
  return y;
}
