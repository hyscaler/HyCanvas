// Raster output dimension math. A page's geometry is in
// design units at the design's source DPI; an export targets either a scale
// multiplier or an explicit DPI. Both resolve to the same pixel-size formula.

import type { RasterOptions } from "./types";

export interface PixelSize {
  width: number; // device pixels
  height: number;
  scale: number; // applied multiplier relative to the source size
  dpi: number; // effective output DPI
}

/**
 * Compute the output pixel size for a page. `scale` takes precedence; otherwise
 * an explicit `dpi` is converted to a scale via the source DPI; otherwise 1x.
 * Dimensions are rounded to whole pixels.
 */
export function rasterDimensions(
  page: { width: number; height: number },
  opts: RasterOptions = {},
  sourceDpi = 96,
): PixelSize {
  let scale: number;
  if (typeof opts.scale === "number" && opts.scale > 0) {
    scale = opts.scale;
  } else if (typeof opts.dpi === "number" && opts.dpi > 0) {
    scale = opts.dpi / sourceDpi;
  } else {
    scale = 1;
  }
  return {
    width: Math.max(1, Math.round(page.width * scale)),
    height: Math.max(1, Math.round(page.height * scale)),
    scale,
    dpi: scale * sourceDpi,
  };
}
