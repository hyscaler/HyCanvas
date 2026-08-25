// Deck timeline planner (doc 28 FR-19 groundwork).
//
// Turns a multi-page design into an ordered list of frame descriptors: each
// frame is either a single posed slide or a transition composite between two
// slides. Pure and framework-agnostic, so the same plan drives client animated
// export (APNG/GIF), a headless deck-to-video encoder, and any future player
// scrubber. Rendering stays with the caller (it needs a scene renderer); this
// module only decides WHAT to draw at each frame.
//
// It reuses the shipped playback contract: hidden slides are skipped, a page's
// transition plays when advancing TO it, `pageAnimationDuration` sizes each
// slide's animation window, and `transitionProgress` supplies the same eased
// curve present mode and the player use.

import type { DesignFile, PageTransition } from "@hc/schema";
import { transitionProgress } from "./animation";
import { pageAnimationDuration } from "./pose";

/** How long a slide holds once its animations have finished. */
export const defaultSlideHoldMs = 2000;

export interface DeckPlanOptions {
  /** Frames per second to sample at. */
  fps?: number;
  /** Extra hold after a slide's animations finish, in ms. */
  holdMs?: number;
  /** Cap on total frames, so a long deck cannot exhaust memory. */
  maxFrames?: number;
  /** Honor `prefers-reduced-motion`: skip transitions entirely (FR-16/FR-22). */
  reducedMotion?: boolean;
  /** Restrict the playthrough to these page indices, in file order (hidden
   *  pages are still skipped). Omit to plan every visible page. */
  pageIndices?: number[];
}

/** A single slide frame: draw `pageIndex` posed at `tMs`. */
export interface SlideFrame {
  kind: "slide";
  pageIndex: number;
  /** Animation time within the slide. */
  tMs: number;
  delayMs: number;
}

/** A deck transition frame: composite `fromIndex` -> `toIndex` at eased `progress`.
 *  The leaving slide is fully settled; the arriving slide is `toTMs` into its
 *  own entrance, matching present mode. */
export interface DeckTransitionFrame {
  kind: "transition";
  fromIndex: number;
  toIndex: number;
  transition: PageTransition;
  /** Eased progress, 0..1, ready to hand to `renderTransition`. */
  progress: number;
  /** Arriving slide's animation time. */
  toTMs: number;
  delayMs: number;
}

export type DeckFrame = SlideFrame | DeckTransitionFrame;

/** Slides that actually present (a hidden page is skipped, as in present mode). */
export function visibleSlideIndices(file: DesignFile): number[] {
  const out: number[] = [];
  file.pages.forEach((p, i) => {
    if (!(p as { hidden?: boolean }).hidden) out.push(i);
  });
  return out;
}

/** The time a slide occupies on its own: its animation window plus a hold. */
export function slideDurationMs(file: DesignFile, pageIndex: number, holdMs = defaultSlideHoldMs): number {
  return pageAnimationDuration(file, pageIndex) + holdMs;
}

/**
 * Plan every frame of a deck playthrough, in order.
 *
 * Frames are emitted at a fixed `fps`, so `delayMs` is uniform and any encoder
 * (APNG, GIF, an image2pipe stream) can consume the list directly. Transitions
 * are dropped under `reducedMotion`, matching the reduced-motion present path.
 * The frame count is bounded by `maxFrames`; truncation is silent by design so
 * an export never hangs, and callers that care can compare lengths.
 */
export function planDeckFrames(file: DesignFile, opts: DeckPlanOptions = {}): DeckFrame[] {
  const fps = Math.max(1, Math.min(60, opts.fps ?? 15));
  const holdMs = Math.max(0, opts.holdMs ?? defaultSlideHoldMs);
  const maxFrames = Math.max(1, opts.maxFrames ?? 900);
  const delayMs = Math.round(1000 / fps);
  const visible = visibleSlideIndices(file);
  const wanted = opts.pageIndices?.length ? new Set(opts.pageIndices) : null;
  const order = wanted ? visible.filter((i) => wanted.has(i)) : visible;
  const frames: DeckFrame[] = [];
  if (!order.length) return frames;

  const push = (f: DeckFrame): boolean => {
    if (frames.length >= maxFrames) return false;
    frames.push(f);
    return true;
  };

  for (let s = 0; s < order.length; s++) {
    const pageIndex = order[s];

    // The transition INTO this slide (skipped for the first slide and when the
    // arriving page declares none, or under reduced motion).
    if (s > 0 && !opts.reducedMotion) {
      const transition = file.pages[pageIndex]?.transition as PageTransition | undefined;
      const dur = transition?.durationMs ?? 0;
      if (transition && dur > 0) {
        const steps = Math.max(1, Math.round((dur / 1000) * fps));
        for (let i = 1; i <= steps; i++) {
          const elapsed = (i / steps) * dur;
          if (
            !push({
              kind: "transition",
              fromIndex: order[s - 1],
              toIndex: pageIndex,
              transition,
              progress: transitionProgress(elapsed, dur, transition.easing),
              toTMs: elapsed,
              delayMs,
            })
          )
            return frames;
        }
      }
    }

    // The slide itself: sample its animation window, then hold.
    const dur = slideDurationMs(file, pageIndex, holdMs);
    const steps = Math.max(1, Math.round((dur / 1000) * fps));
    for (let i = 0; i < steps; i++) {
      const tMs = (i / steps) * dur;
      if (!push({ kind: "slide", pageIndex, tMs, delayMs })) return frames;
    }
  }
  return frames;
}

/** Total wall-clock duration of a plan, in ms. */
export function planDurationMs(frames: DeckFrame[]): number {
  return frames.reduce((acc, f) => acc + f.delayMs, 0);
}
