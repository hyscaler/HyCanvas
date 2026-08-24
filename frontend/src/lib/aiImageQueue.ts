// F28 T10 - the placeholder-first image resolution queue. Generation emits
// pages instantly; this queue fills their image slots behind the scenes with a
// three-step ladder per prompt:
//   1. REUSE: a workspace asset already tagged with the prompt's stable key
//      (identical prompt = same asset, zero cost);
//   2. STOCK: for short concrete-noun prompts, the best stock-search hit;
//   3. GENERATE: POST /ai/image, then tag the persisted asset with the prompt
//      key so the next identical prompt reuses it.
// Each resolution lands through a normal store mutation addressed by PAGE ID
// (applyGeneratedBackground), which refuses to apply when the page no longer
// exists - a late result can never land on another design. Failures never
// abort anything: they are collected per design and surfaced to subscribers
// (the assistant chat offers a retry). Alt text is written in the same step.

import { promptAssetKey, routeImageSource } from "@hc/aistudio";
import { useEditor } from "@/store/editor";
import { oc, resolveAssetUrl } from "@/lib/sdk";

export interface AiImageTask {
  workspaceId: string;
  designId: string;
  pageId: string;
  prompt: string;
  /** Short concrete subject ("Mountain lake at sunrise") used for the
   *  stock-vs-generate route and the stock query; the grounded prompt is
   *  always stylized ("soft background...") and would never route to stock. */
  subject?: string;
  /** Provider size string, e.g. "1792x1024". */
  size: string;
  /** When set, the image fills THIS placeholder slot (T12 picture roles)
   *  instead of becoming a full-bleed page background. */
  placeholderId?: string;
}

export interface AiImageQueueEvent {
  designId: string;
  resolved: number;
  failed: number;
}

type Listener = (ev: AiImageQueueEvent) => void;

const listeners = new Set<Listener>();
const queue: AiImageTask[] = [];
const failedByDesign = new Map<string, AiImageTask[]>();
let running = 0;
const maxConcurrent = 2;

/** Subscribe to batch settlements (per design). Returns the unsubscribe. */
export function subscribeAiImageQueue(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Queue image resolutions; they run with small concurrency and settle
 *  independently - a provider failure leaves a working deck. */
export function enqueueAiImages(tasks: AiImageTask[]): void {
  if (!tasks.length) return;
  for (const t of tasks) pendingByDesign.set(t.designId, (pendingByDesign.get(t.designId) ?? 0) + 1);
  queue.push(...tasks);
  pump();
}

/** Re-queue the failed resolutions for a design (the chat's Retry). Returns
 *  how many were re-queued. */
export function retryFailedAiImages(designId: string): number {
  const failed = failedByDesign.get(designId) ?? [];
  failedByDesign.delete(designId);
  enqueueAiImages(failed);
  return failed.length;
}

// One settle report per design per batch: counts since the last report.
const tally = new Map<string, { resolved: number; failed: number }>();
const pendingByDesign = new Map<string, number>();

function pump(): void {
  while (running < maxConcurrent && queue.length) {
    const task = queue.shift()!;
    running++;
    void resolveTask(task)
      .then((ok) => {
        const t = tally.get(task.designId) ?? { resolved: 0, failed: 0 };
        if (ok) t.resolved++;
        else {
          t.failed++;
          const f = failedByDesign.get(task.designId) ?? [];
          f.push(task);
          failedByDesign.set(task.designId, f);
        }
        tally.set(task.designId, t);
      })
      .catch(() => {
        // A throwing store mutation or unexpected error counts as a failure;
        // without this the rejection would skip the tally and go unhandled.
        const t = tally.get(task.designId) ?? { resolved: 0, failed: 0 };
        t.failed++;
        tally.set(task.designId, t);
        const f = failedByDesign.get(task.designId) ?? [];
        f.push(task);
        failedByDesign.set(task.designId, f);
      })
      .finally(() => {
        running--;
        const left = (pendingByDesign.get(task.designId) ?? 1) - 1;
        pendingByDesign.set(task.designId, left);
        // Settle per design as soon as ITS tasks finish, not when the whole
        // queue drains: overlapping generations must not defer each other's
        // failure report.
        if (left <= 0) flushDesign(task.designId);
        if (queue.length) pump();
      });
  }
}

function flushDesign(designId: string): void {
  const t = tally.get(designId);
  tally.delete(designId);
  pendingByDesign.delete(designId);
  if (!t) return;
  for (const cb of listeners) cb({ designId, resolved: t.resolved, failed: t.failed });
}

/** The assets/<id>/content URL carries the asset id; recover it for tagging. */
function assetIdFromUrl(url: string): string | null {
  const m = /\/assets\/([^/]+)\/content/.exec(url);
  return m ? m[1] : null;
}

async function resolveTask(task: AiImageTask): Promise<boolean> {
  const key = promptAssetKey(task.prompt);
  let url: string | null = null;
  // 1. Reuse a previously produced asset for the identical prompt.
  try {
    const hits = await oc.listAssets(task.workspaceId, { tag: key });
    if (hits.length) url = hits[0].url;
  } catch {
    // reuse is an optimization; fall through
  }
  // 2. Stock for short concrete subjects (degrades to generation on a miss).
  // Routed on the SUBJECT: the grounded prompt is always stylized and would
  // never qualify. Attribution-required hits are SKIPPED (an automatic
  // insertion cannot guarantee the credit compiles), and a hit is IMPORTED
  // into the workspace - never hotlinked, which would break canvas export
  // (CORS taint) and rot when the remote image moves - then tagged for reuse.
  const subject = (task.subject ?? "").trim();
  if (!url && subject && routeImageSource(subject) === "stock") {
    try {
      const hits = await oc.stockSearch(subject, "photo", { limit: 5 });
      const free = hits.find((h) => !h.license?.attributionRequired && (h.sourceUrl || h.previewUrl));
      if (free) {
        const asset = await oc.importAssetFromUrl(task.workspaceId, free.sourceUrl || free.previewUrl);
        url = asset.url;
        void oc.updateAsset(asset.id, { tags: [key] }).catch(() => {});
      }
    } catch {
      // stock is best-effort; fall through to generation
    }
  }
  // 3. Generate, then tag the persisted asset with the prompt key for reuse.
  if (!url) {
    try {
      const { image } = await oc.aiImage({ workspaceId: task.workspaceId, prompt: task.prompt, size: task.size });
      if (!image) return false;
      url = image;
      const assetId = assetIdFromUrl(image);
      if (assetId) void oc.updateAsset(assetId, { tags: [key] }).catch(() => {});
    } catch {
      return false;
    }
  }
  // Apply through the page-id-guarded store mutation; false = design changed
  // (or the user deleted the slot) - a late result never lands elsewhere.
  const st = useEditor.getState();
  const applied = task.placeholderId
    ? st.applyGeneratedImageToPlaceholder(task.pageId, task.placeholderId, url, task.prompt)
    : st.applyGeneratedBackground(task.pageId, url, task.prompt);
  if (!applied) return true; // not a failure: the deck this belonged to is gone
  // Alt text in the same resolution step (best-effort; background images are
  // decorative-leaning, but a description beats silence for screen readers).
  void describeAppliedBackground(task).catch(() => {});
  return true;
}

/** Describe the just-applied background and write the node's alt text. */
async function describeAppliedBackground(task: AiImageTask): Promise<void> {
  const st = useEditor.getState();
  const page = st.doc.pages.find((p) => p.id === task.pageId);
  const node = page?.children.find((n) => n.type === "image" && (n.data as { aiImagePrompt?: string } | undefined)?.aiImagePrompt === task.prompt);
  if (!node) return;
  const assetId = (node as { source?: { assetId?: string } }).source?.assetId;
  const ref = assetId ? st.doc.assets.find((a) => a.id === assetId) : null;
  if (!ref?.url) return;
  const { text } = await oc.aiDescribeImage({ workspaceId: task.workspaceId, imageBase64: await urlToPngDataUrl(resolveAssetUrl(ref.url)) });
  if (text.trim()) useEditor.getState().setNodeAltText(node.id, text.trim());
}

async function urlToPngDataUrl(url: string): Promise<string> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("image unreadable"));
    img.src = url;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || 1;
  canvas.height = img.naturalHeight || 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.drawImage(img, 0, 0);
  return canvas.toDataURL("image/png");
}
