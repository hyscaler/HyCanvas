// Ingest geometry: the pure dimension math the upload pipeline needs to
// generate thumbnails/previews and to normalize EXIF orientation, independent of
// any image codec. The worker decodes pixels; these helpers decide the target
// size and the orientation transform to bake in.

export interface Size {
  width: number;
  height: number;
}

/** Scale (w,h) down to fit inside (maxW,maxH) preserving aspect ratio. Never
 *  upscales (a smaller image is returned unchanged). Result is rounded. */
export function fitWithin(w: number, h: number, maxW: number, maxH: number): Size {
  if (w <= 0 || h <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, maxW / w, maxH / h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** Scale (w,h) to completely cover (boxW,boxH) preserving aspect ratio (the
 *  image overflows the box on one axis); used for fill-style previews. */
export function coverSize(w: number, h: number, boxW: number, boxH: number): Size {
  if (w <= 0 || h <= 0) return { width: 0, height: 0 };
  const scale = Math.max(boxW / w, boxH / h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** Square-bounded thumbnail size (default 512px on the longest edge). */
export function thumbnailSize(w: number, h: number, max = 512): Size {
  return fitWithin(w, h, max, max);
}

/** The transform an EXIF orientation (1..8) encodes: a clockwise rotation in
 *  degrees plus an optional horizontal mirror, applied to display the image
 *  upright. Unknown values fall back to the identity (orientation 1). */
export interface ExifTransform {
  rotate: 0 | 90 | 180 | 270;
  mirrored: boolean;
}
const EXIF_TRANSFORMS: Record<number, ExifTransform> = {
  1: { rotate: 0, mirrored: false },
  2: { rotate: 0, mirrored: true },
  3: { rotate: 180, mirrored: false },
  4: { rotate: 180, mirrored: true },
  5: { rotate: 90, mirrored: true },
  6: { rotate: 90, mirrored: false },
  7: { rotate: 270, mirrored: true },
  8: { rotate: 270, mirrored: false },
};
export function exifTransform(orientation: number): ExifTransform {
  return EXIF_TRANSFORMS[orientation] ?? EXIF_TRANSFORMS[1];
}

/** The displayed dimensions after applying an EXIF orientation: width and height
 *  swap for the 90 deg / 270 deg rotations (orientations 5..8). */
export function orientedDimensions(w: number, h: number, orientation: number): Size {
  const { rotate } = exifTransform(orientation);
  return rotate === 90 || rotate === 270 ? { width: h, height: w } : { width: w, height: h };
}
