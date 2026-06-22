// Pure chart layout/scale helpers. Framework-agnostic and side-effect
// free so they can be unit-tested without a canvas and reused by the GPU path.
// The Canvas2D renderer in render2d.ts consumes these to lay out bars, lines,
// stacked/grouped series, scatter, radar, etc.

export interface ChartSeriesLike {
  name: string;
  values: number[];
}

/** Inset plot rectangle inside a chart node, leaving room for chrome. */
export interface PlotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Linear value scale from a data domain `[0, max]` to a pixel extent. The
 * domain always starts at 0 so bars/areas have a stable baseline. `max` is the
 * largest value across all series (>= 0); a degenerate all-zero domain maps to
 * a flat baseline rather than dividing by zero.
 */
export function valueScale(values: number[][], pixels: number): (v: number) => number {
  let max = 0;
  for (const s of values) for (const v of s) if (v > max) max = v;
  const domain = max || 1;
  return (v: number) => (Math.max(0, v) / domain) * pixels;
}

/** The maximum value across every series (>= 0), used to size axes/scales. */
export function seriesMax(series: ChartSeriesLike[]): number {
  let max = 0;
  for (const s of series) for (const v of s.values) if (v > max) max = v;
  return max;
}

/** The number of category slots: the larger of the category count and the
 *  longest series, so a chart still lays out when categories are sparse. */
export function categoryCount(categories: string[], series: ChartSeriesLike[]): number {
  return Math.max(categories.length, ...series.map((s) => s.values.length), 0);
}

/**
 * Per-bar geometry for a grouped (side-by-side) bar chart. Returns the x offset
 * and width for the bar of series `seriesIndex` within category slot `catIndex`.
 * Bars fill `fillFraction` of each category slot, split evenly across series.
 */
export function groupedBarLayout(
  plotWidth: number,
  catCount: number,
  seriesCount: number,
  catIndex: number,
  seriesIndex: number,
  fillFraction = 0.8,
): { x: number; width: number } {
  const slot = catCount > 0 ? plotWidth / catCount : plotWidth;
  const groupW = slot * fillFraction;
  const pad = (slot - groupW) / 2;
  const barW = seriesCount > 0 ? groupW / seriesCount : groupW;
  return { x: catIndex * slot + pad + seriesIndex * barW, width: barW };
}

/**
 * Cumulative stacked total below series `seriesIndex` at category `catIndex`,
 * used to offset each stacked segment from the running baseline.
 */
export function stackedBase(series: ChartSeriesLike[], catIndex: number, seriesIndex: number): number {
  let base = 0;
  for (let j = 0; j < seriesIndex; j++) base += Math.max(0, series[j].values[catIndex] ?? 0);
  return base;
}

/** Stacked total across all series at a category, to scale the y axis. */
export function stackedMax(series: ChartSeriesLike[], catCount: number): number {
  let max = 0;
  for (let i = 0; i < catCount; i++) {
    let sum = 0;
    for (const s of series) sum += Math.max(0, s.values[i] ?? 0);
    if (sum > max) max = sum;
  }
  return max;
}

/**
 * Point on a radar/spider axis. `axisIndex` of `axisCount` is placed evenly
 * around a circle starting at the top (12 o'clock); the radius is the value's
 * fraction of `maxValue` times `radius`.
 */
export function radarPoint(
  cx: number,
  cy: number,
  radius: number,
  axisIndex: number,
  axisCount: number,
  value: number,
  maxValue: number,
): { x: number; y: number } {
  const angle = -Math.PI / 2 + (axisIndex / Math.max(1, axisCount)) * Math.PI * 2;
  const r = (Math.max(0, value) / (maxValue || 1)) * radius;
  return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
}

/** "Nice" axis tick count for a value domain; clamps to a small range so labels
 *  stay legible. Pure, no canvas needed. */
export function tickCount(pixels: number): number {
  return Math.max(2, Math.min(8, Math.round(pixels / 48)));
}
