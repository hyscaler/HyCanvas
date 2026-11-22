// Messages between the page and the preview worker (thumb.worker.ts).

import type { DesignFile } from "@hc/schema";

export interface ThumbRequest {
  id: number;
  /** The design, trimmed to the page that is drawn. */
  file: DesignFile;
  /** The card's size in CSS pixels, and the pixel ratio to draw at. */
  width: number;
  height: number;
  dpr: number;
  /** Image assets to load: id and the (already resolved, downscaled) URL. */
  assets: { id: string; url: string }[];
  /** Uploaded fonts the design carries: family and file URL. */
  fonts: { family: string; url: string }[];
  /** Whether to download the web fonts the text is set in. Off where the
   *  download is not worth it (see previewFontsWanted): the text then draws in
   *  fallback faces. */
  webFonts: boolean;
}

export type ThumbResponse =
  | { id: number; ok: true; bitmap: ImageBitmap }
  /** The worker cannot draw this one faithfully (an SVG image, no font API):
   *  the page draws it itself. */
  | { id: number; ok: false; reason: string };
