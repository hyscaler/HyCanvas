// Pure presentation helpers. Kept free of React/engine so the present
// runtime and presenter HUD can share the same slide-ordering and timer math,
// and so it is straightforward to unit-test.

/** The minimal slide view the present runtime needs: only its hidden flag and
 *  optional autopilot dwell. Indices below are always into the FULL page list
 *  (so they map straight back to the document), never into the visible subset. */
export interface SlideLike {
  hidden?: boolean;
  autoAdvanceMs?: number;
}

/** Default autopilot dwell (ms) when a slide has no `autoAdvanceMs` (FR-14). */
export const DEFAULT_AUTO_ADVANCE_MS = 5000;

/** Is the slide at `index` presentable (exists and not hidden)? */
export function isVisibleSlide(pages: SlideLike[], index: number): boolean {
  const p = pages[index];
  return !!p && !p.hidden;
}

/** Full-list indices of the non-hidden slides, in document order (FR-1). */
export function visibleIndices(pages: SlideLike[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < pages.length; i++) if (!pages[i]?.hidden) out.push(i);
  return out;
}

/** The next visible slide index at or after `from` (searching forward by `dir`),
 *  skipping hidden slides (FR-1). Returns -1 when there is no visible slide in
 *  that direction. `dir` is +1 (next) or -1 (prev). When `from` itself is visible
 *  it is returned, so callers can also use this to clamp a jump onto a visible
 *  slide. Use `nextVisibleIndex`/`prevVisibleIndex` for strict step navigation. */
export function seekVisible(pages: SlideLike[], from: number, dir: 1 | -1): number {
  for (let i = from; i >= 0 && i < pages.length; i += dir) {
    if (!pages[i]?.hidden) return i;
  }
  return -1;
}

/** Next visible slide strictly after `current` (FR-1), or -1 if none. */
export function nextVisibleIndex(pages: SlideLike[], current: number): number {
  return seekVisible(pages, current + 1, 1);
}

/** Previous visible slide strictly before `current` (FR-1), or -1 if none. */
export function prevVisibleIndex(pages: SlideLike[], current: number): number {
  return seekVisible(pages, current - 1, -1);
}

/** First visible slide index (>= 0), or -1 if every slide is hidden. */
export function firstVisibleIndex(pages: SlideLike[]): number {
  return seekVisible(pages, 0, 1);
}

/** Last visible slide index, or -1 if every slide is hidden. */
export function lastVisibleIndex(pages: SlideLike[]): number {
  return seekVisible(pages, pages.length - 1, -1);
}

/** Position of slide `index` within the visible slides as 1-based "n of N"
 *  (FR-4). `position` is 0 and `total` reflects only visible slides. A hidden
 *  `index` reports the count of visible slides at or before it (clamped to >=1
 *  when any slide is visible). */
export function visiblePosition(pages: SlideLike[], index: number): { position: number; total: number } {
  const vis = visibleIndices(pages);
  const total = vis.length;
  // Number of visible slides whose full-list index is <= `index`.
  let position = 0;
  for (const i of vis) if (i <= index) position++;
  if (position === 0 && total > 0) position = 1; // never show "0 of N"
  return { position, total };
}

/** The dwell (ms) before autopilot advances slide `index`: its own
 *  `autoAdvanceMs`, else the global default (FR-14). */
export function dwellMs(pages: SlideLike[], index: number, defaultMs = DEFAULT_AUTO_ADVANCE_MS): number {
  const ms = pages[index]?.autoAdvanceMs;
  return typeof ms === "number" && ms >= 0 ? ms : defaultMs;
}

/** One slide's rehearsal accounting line (FR-5): which slide, how long it was on
 *  screen, and how many times it was shown. `index` is the full-list page index. */
export interface SlideTiming {
  index: number;
  elapsedMs: number;
  visits: number;
}

/** Accumulates per-slide elapsed time across a rehearsal, surfaced when the
 *  presenter stops the timer (FR-5). Pure and side-effect free; the HUD owns the
 *  wall clock and feeds it deltas, so this is trivially testable. */
export class RehearsalTimer {
  private byIndex = new Map<number, { elapsedMs: number; visits: number }>();
  private current = -1;

  /** Begin (or resume) timing slide `index`. Closing-out of the previous slide
   *  is the caller's responsibility via `tick` before calling `enter`. */
  enter(index: number): void {
    if (index === this.current) return;
    this.current = index;
    const rec = this.byIndex.get(index);
    if (rec) rec.visits += 1;
    else this.byIndex.set(index, { elapsedMs: 0, visits: 1 });
  }

  /** Add `deltaMs` of elapsed time to the slide currently being timed. */
  tick(deltaMs: number): void {
    if (this.current < 0 || deltaMs <= 0) return;
    const rec = this.byIndex.get(this.current);
    if (rec) rec.elapsedMs += deltaMs;
  }

  /** The per-slide breakdown in document order (FR-5). */
  breakdown(): SlideTiming[] {
    return [...this.byIndex.entries()]
      .map(([index, r]) => ({ index, elapsedMs: r.elapsedMs, visits: r.visits }))
      .sort((a, b) => a.index - b.index);
  }

  /** Total elapsed across all slides (ms). */
  total(): number {
    let t = 0;
    for (const r of this.byIndex.values()) t += r.elapsedMs;
    return t;
  }

  reset(): void {
    this.byIndex.clear();
    this.current = -1;
  }
}

/** Presenter "magic tool" geometry helpers (FR-8). Pure and engine/React free
 *  so the present overlay can share them and they stay unit-testable. The present
 *  overlay maps screen pixels through these; none of it touches the design. */

/** Clamp a value into [min, max]. (max < min collapses to min.) */
export function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return value < min ? min : value > max ? max : value;
}

/** A spotlight: a soft-edged lit circle centered on the cursor over a dimmed
 *  slide (FR-8). Geometry only; the overlay paints a full-surface dim and punches
 *  a radial hole. Radius is bounded so a wheel/key adjust can never invert or
 *  blow up. Coordinates are in CSS pixels of the overlay surface. */
export interface SpotlightGeom {
  cx: number;
  cy: number;
  radius: number; // hard inner radius (fully lit)
  outer: number; // soft outer radius (fully dimmed beyond this)
}

/** Default / bounds for the spotlight radius (CSS px). */
export const SPOTLIGHT_MIN_RADIUS = 40;
export const SPOTLIGHT_MAX_RADIUS = 600;
export const SPOTLIGHT_DEFAULT_RADIUS = 140;
/** Fraction of soft falloff beyond the hard radius. */
export const SPOTLIGHT_FALLOFF = 0.35;

/** Build the spotlight geometry for a cursor at (cx, cy) with a requested
 *  radius, clamped into [SPOTLIGHT_MIN_RADIUS, SPOTLIGHT_MAX_RADIUS]. The outer
 *  (fully-dim) radius extends past the hard radius by SPOTLIGHT_FALLOFF. */
export function spotlightGeom(cx: number, cy: number, radius: number): SpotlightGeom {
  const r = clamp(radius, SPOTLIGHT_MIN_RADIUS, SPOTLIGHT_MAX_RADIUS);
  return { cx, cy, radius: r, outer: r * (1 + SPOTLIGHT_FALLOFF) };
}

/** Adjust a spotlight radius by a signed step, staying within bounds. Used by the
 *  wheel and the +/- keys so both share the same clamped result. */
export function adjustSpotlightRadius(radius: number, delta: number): number {
  return clamp(radius + delta, SPOTLIGHT_MIN_RADIUS, SPOTLIGHT_MAX_RADIUS);
}

/** A bounded zoom-with-pan transform over the slide surface (FR-8). `scale` is
 *  the magnification (>= 1); `(originX, originY)` is the surface point that stays
 *  fixed under the cursor while zooming, expressed as a fraction 0..1 of the
 *  surface so it is resolution independent. The overlay applies it as a CSS/
 *  canvas transform; the slide itself is never mutated. */
export interface ZoomTransform {
  scale: number;
  originX: number; // 0..1
  originY: number; // 0..1
}

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 6;
export const ZOOM_STEP = 0.25;

/** The identity (fit) zoom: no magnification, centered. */
export function fitZoom(): ZoomTransform {
  return { scale: ZOOM_MIN, originX: 0.5, originY: 0.5 };
}

/** Clamp a candidate zoom into the valid range. `scale` is bounded to
 *  [ZOOM_MIN, ZOOM_MAX] and the origin to [0, 1] so a pan can never push the
 *  focus point off the surface. At scale 1 the origin is forced to center so the
 *  reset is exact. */
export function clampZoom(z: ZoomTransform): ZoomTransform {
  const scale = clamp(z.scale, ZOOM_MIN, ZOOM_MAX);
  if (scale <= ZOOM_MIN) return fitZoom();
  return { scale, originX: clamp(z.originX, 0, 1), originY: clamp(z.originY, 0, 1) };
}

/** Step the zoom by a signed amount, keeping the surface point under the cursor
 *  (fractions `fx`,`fy` in 0..1) fixed as the magnification changes. Returns a
 *  clamped transform; stepping below ZOOM_MIN resets to fit. */
export function stepZoom(z: ZoomTransform, delta: number, fx: number, fy: number): ZoomTransform {
  const scale = z.scale + delta;
  if (scale <= ZOOM_MIN) return fitZoom();
  // Keep the cursor's surface fraction as the new origin so it stays put.
  return clampZoom({ scale, originX: fx, originY: fy });
}

/** Format ms as m:ss (or h:mm:ss past an hour) for a timer readout. */
export function formatClock(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const total = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${sign}${h}:${pad(m)}:${pad(s)}` : `${sign}${m}:${pad(s)}`;
}
