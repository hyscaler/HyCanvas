// Image placement math: effective-PPI / low-resolution awareness and
// the crop+fit+focal source/destination rectangle the renderer draws with. Pure
// and framework-agnostic; the actual bitmap decode/upload is the GPU/worker path.

import type { DesignFile, ImageNode, Unit } from "@hc/schema";

export function unitToInches(value: number, unit: Unit, dpi: number): number {
  switch (unit) {
    case "in":
      return value;
    case "px":
      return dpi > 0 ? value / dpi : 0;
    case "mm":
      return value / 25.4;
    case "pt":
      return value / 72;
    default:
      return value;
  }
}

/**
 * Effective PPI of a placed image = visible source pixels / placed physical size,
 * taking the smaller of the two axes (FR-8). Returns 0 when undeterminable.
 */
export function computeEffectivePpi(node: ImageNode, file: DesignFile): number {
  const sx = Math.abs(node.transform.scaleX || 1);
  const sy = Math.abs(node.transform.scaleY || 1);
  const wIn = unitToInches(node.size.width * sx, file.unit, file.dpi);
  const hIn = unitToInches(node.size.height * sy, file.unit, file.dpi);
  const srcW = node.source.naturalWidth * (node.crop?.width ?? 1);
  const srcH = node.source.naturalHeight * (node.crop?.height ?? 1);
  if (wIn <= 0 || hIn <= 0 || srcW <= 0 || srcH <= 0) return 0;
  return Math.min(srcW / wIn, srcH / hIn);
}

/** Low-resolution threshold: print pages (non-px units) want more PPI (FR-9). */
export function lowResThreshold(file: DesignFile): number {
  return file.unit === "px" ? 72 : 150;
}

export function isLowResolution(node: ImageNode, file: DesignFile): boolean {
  const ppi = computeEffectivePpi(node, file);
  return ppi > 0 && ppi < lowResThreshold(file);
}

export interface FitRect {
  /** Source sub-rectangle to sample, normalized 0..1 of the (cropped) source. */
  source: { x: number; y: number; width: number; height: number };
  /** Destination rectangle within the box, in box pixels. */
  dest: { x: number; y: number; width: number; height: number };
}

/**
 * Map a source of `srcW`x`srcH` into a `boxW`x`boxH` box under a fit mode and
 * focal point (normalized). `cover` crops via the focal point; `contain`
 * letterboxes; `stretch` distorts to fill; `none` is 1:1 centered.
 */
export function fitRect(
  srcW: number,
  srcH: number,
  boxW: number,
  boxH: number,
  fit: ImageNode["fit"],
  focal: { x: number; y: number } = { x: 0.5, y: 0.5 },
): FitRect {
  const full = { x: 0, y: 0, width: 1, height: 1 };
  if (srcW <= 0 || srcH <= 0) {
    return { source: full, dest: { x: 0, y: 0, width: boxW, height: boxH } };
  }
  if (fit === "stretch") {
    return { source: full, dest: { x: 0, y: 0, width: boxW, height: boxH } };
  }
  if (fit === "none") {
    return {
      source: full,
      dest: { x: (boxW - srcW) / 2, y: (boxH - srcH) / 2, width: srcW, height: srcH },
    };
  }
  if (fit === "contain") {
    const scale = Math.min(boxW / srcW, boxH / srcH);
    const dw = srcW * scale;
    const dh = srcH * scale;
    return { source: full, dest: { x: (boxW - dw) / 2, y: (boxH - dh) / 2, width: dw, height: dh } };
  }
  // cover: scale to fill, then crop the overflow about the focal point.
  const scale = Math.max(boxW / srcW, boxH / srcH);
  const visW = boxW / scale; // visible source px
  const visH = boxH / scale;
  const sx = (srcW - visW) * focal.x;
  const sy = (srcH - visH) * focal.y;
  return {
    source: { x: sx / srcW, y: sy / srcH, width: visW / srcW, height: visH / srcH },
    dest: { x: 0, y: 0, width: boxW, height: boxH },
  };
}
