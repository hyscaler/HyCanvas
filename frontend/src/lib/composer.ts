// The deck composer, loaded on demand (#77).
//
// Laying out a generated deck and recomposing a slide need the archetype and
// kit composers plus their artwork: most of @hc/aistudio's weight. The editor
// imports everything else from @hc/aistudio module by module and loads this
// part only on the paths that compose. An async step awaits loadComposer()
// before it composes; the synchronous apply pass that runs after it reads the
// same module through composer().

import type * as ComposerModule from "@hc/aistudio/dist/composer";
import { ensureArtwork } from "@/lib/artwork";

export type Composer = typeof ComposerModule;

let loaded: Composer | null = null;
let pending: Promise<Composer> | null = null;

/** Load the composer and its artwork once. Rejects when the download fails
 *  (the next call tries again). */
export function loadComposer(): Promise<Composer> {
  if (loaded) return Promise.resolve(loaded);
  pending ??= Promise.all([import("@hc/aistudio/dist/composer"), ensureArtwork()])
    .then(([m]) => {
      // A CommonJS build: the named exports, or the same under default with a
      // bundler that wraps it.
      const mod = ((m as { default?: Composer }).default?.layoutDeck ? (m as { default: Composer }).default : m) as Composer;
      loaded = mod;
      return mod;
    })
    .catch((e) => {
      pending = null;
      throw e;
    });
  return pending;
}

/** The composer, for synchronous code that runs after loadComposer() resolved
 *  (a plan's apply pass). Throws if it is not loaded, which would be a bug. */
export function composer(): Composer {
  if (!loaded) throw new Error("composer used before loadComposer() resolved");
  return loaded;
}
