// Image authoring helpers: placement sizing (FR-2) and replace-in-place
// aspect logic (FR-10). Pure; the editor app wires these into transactions.

import type { ImageNode, ImageSource, Size } from "@hc/schema";

/**
 * Size a newly-placed image so its longest edge is ~`fraction` of the smaller
 * viewport dimension, preserving the source aspect ratio (FR-2).
 */
export function placeImageSize(
  naturalWidth: number,
  naturalHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  fraction = 0.8,
): Size {
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    const s = Math.min(viewportWidth, viewportHeight) * fraction;
    return { width: s, height: s };
  }
  const targetLongest = Math.min(viewportWidth, viewportHeight) * fraction;
  const scale = targetLongest / Math.max(naturalWidth, naturalHeight);
  return { width: naturalWidth * scale, height: naturalHeight * scale };
}

function aspect(w: number, h: number): number {
  return h > 0 ? w / h : 0;
}

/**
 * Replace an image's source in place, preserving fit/focal/flip. The crop is
 * kept only when the new source has the same aspect ratio; otherwise it resets
 * to full source and `aspectChanged` is true so the UI can notify (FR-10).
 */
export function replaceImageSource(
  node: ImageNode,
  newSource: ImageSource,
  tolerance = 1e-3,
): { node: ImageNode; aspectChanged: boolean } {
  const oldAspect = aspect(node.source.naturalWidth, node.source.naturalHeight);
  const newAspect = aspect(newSource.naturalWidth, newSource.naturalHeight);
  const aspectChanged =
    oldAspect <= 0 || newAspect <= 0 || Math.abs(oldAspect - newAspect) > tolerance;
  const next: ImageNode = { ...node, source: newSource };
  if (aspectChanged) delete next.crop;
  return { node: next, aspectChanged };
}
