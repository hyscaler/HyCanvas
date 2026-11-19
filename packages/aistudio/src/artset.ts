// Every artwork set in one module, for a host to load on demand and register
// in one step (see illustrations.ts). Importing this pulls in about 2.4 MB of
// path data, so nothing in the package imports it.

import { ILLUSTRATIONS } from "./illustrationset";
import { PACK_DRAWINGS } from "./kit/packset";
import { ICON_GLYPHS } from "./iconset";
import { provideIconGlyphs, provideIllustrations, providePackDrawings } from "./illustrations";

export { ILLUSTRATIONS, PACK_DRAWINGS, ICON_GLYPHS };

/** Register all three sets with the composer. */
export function provideArtwork(): void {
  provideIllustrations(ILLUSTRATIONS);
  providePackDrawings(PACK_DRAWINGS);
  provideIconGlyphs(ICON_GLYPHS);
}
