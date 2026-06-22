// Default categorical palette for chart series. A small, accessible,
// distinguishable qualitative scheme returned as canonical `Color`s. Pure and
// deterministic so charts seed the same default colors everywhere.

import type { Color } from "@hc/schema";
import { fromHex } from "./convert";

/** Ordered qualitative swatches (hex), tuned for legibility on light surfaces. */
export const SERIES_PALETTE_HEX = [
  "#6366f1", // indigo
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ef4444", // red
  "#3b82f6", // blue
  "#ec4899", // pink
  "#14b8a6", // teal
  "#8b5cf6", // violet
] as const;

/** The default series palette as `Color`s, cycling when `count` exceeds the
 *  base scheme so any number of series gets a distinct-as-possible color. */
export function seriesPalette(count: number): Color[] {
  const out: Color[] = [];
  for (let i = 0; i < Math.max(0, count); i++) {
    const c = fromHex(SERIES_PALETTE_HEX[i % SERIES_PALETTE_HEX.length]);
    if (c) out.push(c);
  }
  return out;
}

/** The default color for the series at `index` (cycles through the palette). */
export function seriesColorAt(index: number): Color {
  return fromHex(SERIES_PALETTE_HEX[((index % SERIES_PALETTE_HEX.length) + SERIES_PALETTE_HEX.length) % SERIES_PALETTE_HEX.length])!;
}
