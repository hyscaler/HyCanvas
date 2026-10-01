// The rulers' tick plan: labelled major marks spaced for the zoom, with
// minor marks between them, so a position can be read off the edge of the
// canvas the way it can in any drawing tool.

/** Page-unit spacing so major marks sit about 60px apart on screen. */
export function niceStep(zoom: number): number {
  const target = 60 / Math.max(0.01, zoom);
  return [5, 10, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000].find((c) => c >= target) ?? 10000;
}

export interface TickPlan {
  step: number;
  /** Labelled marks, in page units, from 0 to the page's extent. */
  majors: number[];
  /** Unlabelled marks between the majors: fifths when a major spans 75px or
   *  more on screen (a minor every 15px at least), halves otherwise, so the
   *  minors never crowd. */
  minors: number[];
}

export function rulerTicks(zoom: number, extent: number): TickPlan {
  const step = niceStep(zoom);
  const majors: number[] = [];
  for (let p = 0; p <= extent + 0.5; p += step) majors.push(p);
  const divisions = step * zoom >= 75 ? 5 : 2;
  const sub = step / divisions;
  const minors: number[] = [];
  for (let p = sub; p <= extent + 0.5; p += sub) {
    // Skip what is already a major (float-safe).
    if (Math.abs(p / step - Math.round(p / step)) < 1e-6) continue;
    minors.push(p);
  }
  return { step, majors, minors };
}
