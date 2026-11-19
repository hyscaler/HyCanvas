// The composer's artwork, supplied at run time: the illustration drawings,
// the kit's drawing pack and the icon glyphs.
//
// Together these are about 2.4 MB of path data, more than any page needs
// before it composes a deck. Nothing in this package imports them: a host
// loads the sets when it is about to compose and hands them over here. The
// editor imports them on demand (one chunk, see artset.ts); the server
// composer bundle registers them at startup. Until a set is provided, a page
// that names a drawing or an icon simply gets none, as for one the set does
// not have. The names and keywords (illustrationKeywords.ts, iconKeys.ts,
// kit/packKeys.ts) stay in the package, so lookups work either way.

import type { PathContour } from "@hc/schema";
import type { IllustrationDrawing } from "./illustrationset";
import type { PackDrawing } from "./kit/packKeys";

let drawings: Record<string, IllustrationDrawing> | null = null;
let packDrawings: Record<string, PackDrawing> | null = null;
let iconGlyphs: Record<string, PathContour[]> | null = null;

/** Hand the composer its illustration set (ILLUSTRATIONS from
 *  ./illustrationset). Safe to call more than once. */
export function provideIllustrations(set: Record<string, IllustrationDrawing>): void {
  drawings = set;
}

/** Hand the kit composer its drawing pack (PACK_DRAWINGS from ./kit/packset). */
export function providePackDrawings(set: Record<string, PackDrawing>): void {
  packDrawings = set;
}

/** Hand the composer its icon glyphs (ICON_GLYPHS from ./iconset). */
export function provideIconGlyphs(set: Record<string, PathContour[]>): void {
  iconGlyphs = set;
}

/** Whether the illustration set has been provided. */
export function illustrationsReady(): boolean {
  return drawings !== null;
}

/** Whether every artwork set (illustrations, drawing pack, icons) has been
 *  provided. */
export function artworkReady(): boolean {
  return drawings !== null && packDrawings !== null && iconGlyphs !== null;
}

/** The drawing with this name, when a set is provided and has it. */
export function illustrationDrawing(name: string): IllustrationDrawing | undefined {
  return drawings?.[name];
}

/** The pack drawing with this id, when the pack is provided and has it. */
export function packDrawingData(id: string): PackDrawing | undefined {
  return packDrawings?.[id];
}

/** The icon glyph's contours, when the glyphs are provided and have it. */
export function iconGlyph(name: string): PathContour[] | undefined {
  return iconGlyphs?.[name];
}
