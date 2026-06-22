// Mockup placement geometry (F35 FR-3). Pure math only: it computes the UV/warp
// mapping that places a design (by aspect ratio) onto a template's printable
// surface, plus the output image size. The actual rasterization and compositing
// (perspective warp, mask, lighting) run as a background job in the runtime
// layer; this module produces the geometry that job consumes.

import type { MockupTemplate } from "./types";

export interface PlacementTransform {
  /** Uniform scale applied to the design's normalized box to fit the surface. */
  scale: number;
  /** Translation (in normalized surface units, 0..1) to centre the design. */
  offsetX: number;
  offsetY: number;
  /** Fit mode: contain so the whole design is visible on the surface. */
  mode: "contain";
}

export interface Placement {
  /** Warp mesh control points from the template (passthrough; identity grid when
   *  the template has none). number[][] of [x,y] pairs in normalized units. */
  warpMesh: number[][];
  /** Mask key identifying the surface cutout in the template. */
  maskKey: string;
  /** Lighting key for the compositing pass, when the template declares one. */
  lightingKey?: string;
  /** The transform that maps the design's box into the surface box. */
  transform: PlacementTransform;
}

const DEFAULT_MOCKUP_SIZE = 1200;

/** An identity 2x2 control-point grid spanning the unit square. */
function identityMesh(): number[][] {
  return [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ];
}

/**
 * Place a design (given as an aspect ratio, width/height) onto a mockup
 * template's surface. The design is contained within the surface box (whose
 * aspect comes from `template.surfaceAspect`, default 1), centred, with the
 * warp mesh + mask passed through for the compositing job.
 */
export function placeOnTemplate(designAspect: number, template: MockupTemplate): Placement {
  if (!(designAspect > 0)) throw new Error("designAspect must be positive");
  const surfaceAspect = template.surfaceAspect && template.surfaceAspect > 0 ? template.surfaceAspect : 1;

  // Work in a normalized surface box of width 1 and height (1/surfaceAspect) so
  // the surface's own aspect is respected. The design box is width 1, height
  // 1/designAspect. Contain-fit the design into the surface box.
  const surfaceW = 1;
  const surfaceH = 1 / surfaceAspect;
  const designW = 1;
  const designH = 1 / designAspect;

  const scale = Math.min(surfaceW / designW, surfaceH / designH);
  const placedW = designW * scale;
  const placedH = designH * scale;
  const offsetX = (surfaceW - placedW) / 2;
  const offsetY = (surfaceH - placedH) / 2;

  const warpMesh =
    template.surface.warpMesh && template.surface.warpMesh.length > 0
      ? template.surface.warpMesh
      : identityMesh();

  return {
    warpMesh,
    maskKey: template.surface.maskKey,
    lightingKey: template.surface.lightingKey,
    transform: { scale, offsetX, offsetY, mode: "contain" },
  };
}

/** The output image size (px) of a rendered mockup for `template`. */
export function mockupOutputSize(template: MockupTemplate): { width: number; height: number } {
  const width = template.outputWidth && template.outputWidth > 0 ? template.outputWidth : DEFAULT_MOCKUP_SIZE;
  const height =
    template.outputHeight && template.outputHeight > 0 ? template.outputHeight : DEFAULT_MOCKUP_SIZE;
  return { width, height };
}
