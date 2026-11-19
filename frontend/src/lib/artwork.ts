// The deck composer's artwork, loaded on demand: the illustration drawings,
// the kit's drawing pack and the icon glyphs.
//
// The sets are about 2.4 MB of path data (about 760 KB compressed). The editor
// used to download them on every first visit through @hc/aistudio; now
// @hc/aistudio reads them from a registry and the editor fills it here, in
// one chunk of its own, only on the paths that compose a deck (#77). Call it
// as early as the flow allows and await it right before composing. Nothing
// else in the editor needs the sets: layout, reflow and theme code never draw
// a drawing or an icon.

import { artworkReady } from "@hc/aistudio";

let pending: Promise<boolean> | null = null;

/** Load and register the artwork sets once. Resolves true when they are
 *  registered and false when the download failed (the composer then leaves
 *  drawings and icons out, and the next call tries again). Never rejects. */
export function ensureArtwork(): Promise<boolean> {
  if (artworkReady()) return Promise.resolve(true);
  pending ??= import("@hc/aistudio/dist/artset")
    .then((m) => {
      // A CommonJS build: the named export, or the same under default with a
      // bundler that wraps it.
      const provide = m.provideArtwork ?? m.default?.provideArtwork;
      if (!provide) throw new Error("artwork sets missing from their module");
      provide();
      return true;
    })
    .catch(() => {
      pending = null;
      return false;
    });
  return pending;
}
