// @hc/engine - the rendering engine. Framework-agnostic (no React/Next
// dependency) so it runs in the browser, in OffscreenCanvas workers, and
// headless on the server. It turns a scene graph into pixels and answers
// hit-tests for selection.
//
// Implemented now: scene graph + world transforms, viewport (fit/fill/1:1,
// page<->screen), hit-testing (point + marquee), dirty-rect tiling, and the
// Canvas2D render path (browser/worker/headless via any conforming 2D context).
// Deferred (Section 14): the GPU path (WebGL2/WebGPU), the OffscreenCanvas
// worker protocol, skia-canvas server pixel-parity, and the 60fps benchmark.

export * from "./types";
export * from "./math";
export * from "./viewport";
export * from "./tiles";
export * from "./color";
export * from "./fonts";
export * from "./image";
export * from "./animation";
export * from "./chart";
export { resolveFill } from "./fills";
export {
  effectsFilter,
  outlineSpecs,
  adjustmentOpToFilters,
  duotoneEffect,
  duotoneLut,
  applyDuotone,
  luminance601,
  type OutlineSpec,
} from "./effects";
export { duotoneCanvas, clearDuotoneCache } from "./duotone";
export { createScene, effectBleed } from "./scene";
export { SpatialIndex } from "./spatial";
export { pointInLocalShape } from "./hit";
export { renderScene, bumpTextLayout, blendToComposite, type Render2DOptions } from "./render2d";
export { benchmarkRender, createNullContext, type BenchResult, type BenchOptions } from "./bench";
export { poseDesignAt, pageAnimationDuration, sequenceStarts, revealEntranceText } from "./pose";
export {
  renderTransition,
  morphPlan,
  morphDesignAt,
  morphHiddenIds,
  lerpNode,
  type TransitionFrame,
  type TransitionSurface,
  type MorphPlan,
} from "./transition";
export {
  mountRenderer,
  render,
  probeContext,
  gpuAvailable,
  type OneShotOptions,
} from "./renderer";
