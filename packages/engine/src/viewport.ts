// Viewport model and coordinate conversions (FR-3, FR-12). All functions are
// pure: they take a Viewport and return a new one, never mutating in place.
//
// Convention: (panX, panY) is the page-space point shown at the viewport's
// top-left, and `zoom` scales page px to CSS px. So:
//   screen = (page - pan) * zoom      page = pan + screen / zoom

import type { Point, Rect } from "./math";
import type { Size } from "@hc/schema";
import type { Viewport } from "./types";

export function defaultViewport(width: number, height: number, dpr = 1): Viewport {
  return { zoom: 1, panX: 0, panY: 0, dpr, width, height };
}

export function pageToScreen(vp: Viewport, p: Point): Point {
  return { x: (p.x - vp.panX) * vp.zoom, y: (p.y - vp.panY) * vp.zoom };
}

export function screenToPage(vp: Viewport, p: Point): Point {
  return { x: vp.panX + p.x / vp.zoom, y: vp.panY + p.y / vp.zoom };
}

/** The page-space rectangle currently visible in the viewport. */
export function visiblePageRect(vp: Viewport): Rect {
  return {
    x: vp.panX,
    y: vp.panY,
    width: vp.width / vp.zoom,
    height: vp.height / vp.zoom,
  };
}

/** Center a page of `pageSize` in the viewport at the given zoom. */
function centered(vp: Viewport, pageSize: Size, zoom: number): Viewport {
  const panX = pageSize.width / 2 - vp.width / zoom / 2;
  const panY = pageSize.height / 2 - vp.height / zoom / 2;
  return { ...vp, zoom, panX, panY };
}

export type FitMode = "fit" | "fill" | "1:1" | number;

/** Frame the page per `mode`. `fit` leaves a small margin; `fill` covers the
 *  viewport; `1:1` maps one page px to one CSS px; a number sets explicit zoom. */
export function fit(vp: Viewport, pageSize: Size, mode: FitMode): Viewport {
  const sx = vp.width / pageSize.width;
  const sy = vp.height / pageSize.height;
  let zoom: number;
  if (mode === "fit") zoom = Math.min(sx, sy) * 0.95;
  else if (mode === "fill") zoom = Math.max(sx, sy);
  else if (mode === "1:1") zoom = 1;
  else zoom = mode;
  if (!(zoom > 0) || !isFinite(zoom)) zoom = 1;
  return centered(vp, pageSize, zoom);
}

/**
 * Change zoom while keeping the page point under `focalScreen` fixed on screen
 * (focal-point-preserving zoom). `focalScreen` defaults to the viewport center.
 */
export function zoomTo(vp: Viewport, newZoom: number, focalScreen?: Point): Viewport {
  const zoom = newZoom > 0 && isFinite(newZoom) ? newZoom : vp.zoom;
  const focal = focalScreen ?? { x: vp.width / 2, y: vp.height / 2 };
  const pageAtFocal = screenToPage(vp, focal);
  return {
    ...vp,
    zoom,
    panX: pageAtFocal.x - focal.x / zoom,
    panY: pageAtFocal.y - focal.y / zoom,
  };
}

/** Pan by a screen-space delta (e.g. a drag), preserving zoom. */
export function panBy(vp: Viewport, dxScreen: number, dyScreen: number): Viewport {
  return { ...vp, panX: vp.panX - dxScreen / vp.zoom, panY: vp.panY - dyScreen / vp.zoom };
}
