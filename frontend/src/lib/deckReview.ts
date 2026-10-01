// The render-and-review pass on the editor door. The composer measures and
// repairs what a measurement can catch; this is the look that catches the
// rest. Each freshly generated page is rendered by the engine in the
// browser, exactly as the user sees it, and a provider that can read images
// names the visible defects; the findings land as a turn in the
// conversation. Any failure (no vision provider, a network error, an
// unrenderable page) is silence, never a broken generation.

import type { DesignFile } from "@hc/schema";
import { createScene, renderScene, type CanvasLike, type Viewport } from "@hc/engine";
import { imageAssets } from "@/lib/assetProvider";
import { oc } from "@/lib/sdk";
import { tr } from "@/lib/i18n";

export interface PageFinding {
  kind: "overlap" | "clipped" | "overflow" | "unreadable" | "empty" | "other";
  detail: string;
}

export interface PageReview {
  /** Zero-based page index in the document. */
  pageIndex: number;
  findings: PageFinding[];
}

/** At most this many pages are looked at per generation: one vision call
 *  each, and a long deck's later pages repeat its forms. */
export const maxReviewedPages = 12;

/** Render one page to a PNG data URL at a review size, the way the editor
 *  draws it. */
export function renderPagePng(file: DesignFile, pageIndex: number, maxDim = 768): string | null {
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
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

/** Look at a run of pages, one call each, in order. Returns only pages with
 *  findings; null when the provider cannot look at all (the first call
 *  answers that it cannot read images). */
export async function reviewPages(workspaceId: string, file: DesignFile, first: number, count: number, signal?: AbortSignal): Promise<PageReview[] | null> {
  const out: PageReview[] = [];
  const last = Math.min(file.pages.length, first + Math.min(count, maxReviewedPages));
  let looked = false;
  for (let i = first; i < last; i++) {
    if (signal?.aborted) break;
    const png = renderPagePng(file, i);
    if (!png) continue;
    try {
      const { findings } = await oc.aiReviewPage({ workspaceId, imageBase64: png, title: file.pages[i]?.name });
      looked = true;
      if (findings?.length) out.push({ pageIndex: i, findings });
    } catch (e) {
      // A provider that cannot read images answers the first page with a
      // 400: there is nothing to look with, so the pass ends quietly. Any
      // other failure skips this page and keeps looking.
      if (i === first && (e as { status?: number })?.status === 400) return null;
    }
  }
  // A pass that could not look at a single page is no pass: it must not
  // report a clean deck it never saw.
  return looked ? out : null;
}

/** The turn that reports a review: one line per finding, page-numbered. */
export function reviewTurnText(reviews: PageReview[]): string {
  const lines = reviews.flatMap((r) => r.findings.map((f) => tr("editor.review_page_line", { n: r.pageIndex + 1, detail: f.detail })));
  if (!lines.length) return tr("editor.review_clean");
  return `${tr("editor.review_found", { count: lines.length })}\n${lines.join("\n")}`;
}
