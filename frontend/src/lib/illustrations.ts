// The deck composer's illustration drawings, loaded on demand.
//
// The set is about 1.1 MB of path data (about 380 KB compressed). The editor
// used to download it on every first visit through @hc/aistudio; now
// @hc/aistudio reads the drawings from a registry and the editor fills it
// here, in its own chunk, only on the paths that compose a deck (#77). Call
// it as early as the flow allows and await it right before composing.

import { illustrationsReady, provideIllustrations } from "@hc/aistudio";

let pending: Promise<boolean> | null = null;

/** Load and register the illustration set once. Resolves true when it is
 *  registered and false when the download failed (the composer then falls
 *  back to picture stand-ins, and the next call tries again). Never rejects. */
export function ensureIllustrations(): Promise<boolean> {
  if (illustrationsReady()) return Promise.resolve(true);
  pending ??= import("@hc/aistudio/dist/illustrationset")
    .then((m) => {
      // A CommonJS build: the named export, or the same under default with a
      // bundler that wraps it.
      const set = m.ILLUSTRATIONS ?? m.default?.ILLUSTRATIONS;
      if (!set) throw new Error("illustration set missing from its module");
      provideIllustrations(set);
      return true;
    })
    .catch(() => {
      pending = null;
      return false;
    });
  return pending;
}
