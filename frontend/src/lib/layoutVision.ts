// F28 T20 stage 2 - vision-assisted layout correction.
//
// The heuristic extraction (stage 1) only sees geometry. When the workspace's
// provider can describe images, each UNIQUE extracted layout gets one
// correction pass: the source page is rendered in-browser by the engine with
// the candidate slots drawn over it as labeled boxes, the vision model returns
// role corrections (strict JSON, validated in @hc/aistudio), and the corrected
// layout gets ONE self-review render pass - an empty reply confirms it. Any
// failure (no vision model, network, garbage reply) quietly keeps the
// heuristic result, so this pass can only improve the set, never lose it.

import type { DesignFile } from "@hc/schema";
import { createScene, renderScene, type CanvasLike, type Viewport } from "@hc/engine";
import {
  applyLayoutReview,
  layoutReviewInstruction,
  parseLayoutReview,
  type ExtractedLayout,
  type ExtractedLayoutSet,
} from "@hc/aistudio";
import { imageAssets } from "@/lib/assetProvider";
import { oc } from "@/lib/sdk";

/** Render one page to a PNG data URL, with the candidate slots drawn over it
 *  as labeled outline boxes so the model can map slot ids to regions. */
export function renderPageWithSlots(
  file: DesignFile,
  pageIndex: number,
  placeholders: ExtractedLayout["placeholders"],
  maxDim = 768,
): string | null {
  const page = file.pages[pageIndex];
  if (!page || typeof document === "undefined") return null;
  const scale = Math.min(1, maxDim / Math.max(page.width, page.height));
  const cw = Math.max(1, Math.round(page.width * scale));
  const ch = Math.max(1, Math.round(page.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cw, ch);
    const vp: Viewport = { zoom: scale, panX: 0, panY: 0, dpr: 1, width: cw, height: ch };
    imageAssets.registerAll(file.assets ?? []);
    renderScene(createScene(file, pageIndex), ctx as unknown as CanvasLike, vp, { assets: imageAssets });
    // Slot overlay: outlined boxes + "id role" tags, high-contrast on anything.
    for (const ph of placeholders) {
      const x = ph.rect.x * scale;
      const y = ph.rect.y * scale;
      const w = ph.rect.width * scale;
      const h = ph.rect.height * scale;
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#ff00aa";
      ctx.strokeRect(x, y, w, h);
      const tag = `${ph.id} ${ph.role}`;
      ctx.font = "12px sans-serif";
      const tw = ctx.measureText(tag).width + 8;
      ctx.fillStyle = "#ff00aa";
      ctx.fillRect(x, Math.max(0, y - 16), tw, 16);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(tag, x + 4, Math.max(12, y - 4));
    }
    return canvas.toDataURL("image/png");
  } catch {
    return null; // an unrenderable page (missing asset codec etc.) skips vision
  }
}

/** Run the vision correction over every unique layout in the set. Returns the
 *  (possibly) corrected layouts; `refined` says whether any pass ran. */
export async function refineExtractedLayoutSet(
  workspaceId: string,
  file: DesignFile,
  set: ExtractedLayoutSet,
): Promise<{ layouts: ExtractedLayout[]; refined: boolean }> {
  const out: ExtractedLayout[] = [];
  let refined = false;
  let providerDead = false; // a 502 means no vision model: stop asking
  for (const layout of set.layouts) {
    let current = layout;
    const pageIndex = layout.sourcePageIndexes[0];
    const page = file.pages[pageIndex];
    if (!page || providerDead) {
      out.push(current);
      continue;
    }
    // Round 1 corrects the heuristics; round 2 is the single self-review of
    // the corrected overlay. An empty corrections reply confirms and stops.
    for (let round = 0; round < 2; round++) {
      const png = renderPageWithSlots(file, pageIndex, current.placeholders);
      if (!png) break;
      let text: string;
      try {
        ({ text } = await oc.aiDescribeImage({
          workspaceId,
          imageBase64: png,
          instruction: layoutReviewInstruction(current, page),
        }));
      } catch {
        providerDead = true; // not vision-capable (or down): heuristics stand
        break;
      }
      refined = true;
      const corrections = parseLayoutReview(text, current.placeholders.map((p) => p.id));
      if (!corrections.length) break; // confirmed as-is
      current = applyLayoutReview(current, corrections, page);
    }
    out.push(current);
  }
  return { layouts: out, refined };
}
