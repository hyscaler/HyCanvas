// AI alt-text generation (F22 FR-12). Fetches an image node's bytes, asks the
// AI provider to describe it (oc.aiDescribeImage), and writes the result to the
// node's `alt` accessibility field through the editor store so it is a single
// undo step. Two entry points: the single selected image, and a bulk pass over
// every image in the design. Both are gated on a workspaceId (the AI provider
// lives there) by the caller.

import { walkNodes, type ImageNode } from "@hc/schema";
import { useEditor } from "@/store/editor";
import { oc } from "@/lib/sdk";
import { resolveAssetUrl } from "@/lib/sdk";
import { CodedError } from "./errors";

/** Load a (CORS-clean) image URL into a base64 PNG data URL by re-encoding it
 *  through a canvas. Throws a friendly error on CORS / decode failure. */
async function imageUrlToPngDataUrl(url: string): Promise<string> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new CodedError("errors.image_unreadable_cross_origin", "Couldn't read this image (it may block cross-origin access)."));
    img.src = url;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || 1;
  canvas.height = img.naturalHeight || 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new CodedError("errors.canvas_unavailable", "Canvas is unavailable in this browser.");
  ctx.drawImage(img, 0, 0);
  try {
    return canvas.toDataURL("image/png");
  } catch {
    throw new CodedError("errors.image_describe_cross_origin", "This image can't be described because it's loaded cross-origin.");
  }
}

/** Resolve an image node's source content URL (via its asset ref), or null. */
function imageNodeUrl(node: ImageNode): string | null {
  const st = useEditor.getState();
  const assetId = (node.source as { assetId?: string }).assetId;
  if (!assetId) return null;
  const ref = st.doc.assets.find((a) => a.id === assetId);
  return ref?.url ? resolveAssetUrl(ref.url) : null;
}

/** Describe a single image's bytes via the AI provider and return the text. */
async function describe(workspaceId: string, url: string): Promise<string> {
  const imageBase64 = await imageUrlToPngDataUrl(url);
  const { text } = await oc.aiDescribeImage({ workspaceId, imageBase64 });
  return text.trim();
}

/**
 * Generate alt text for the single selected image node and write it to that
 * node's `alt` field (one undo step). Returns true when an image was described
 * and written, false when the selection is not a single image. Throws (with a
 * friendly message) on fetch/provider failure for the caller to surface.
 */
export async function generateAltText(workspaceId: string): Promise<boolean> {
  const st = useEditor.getState();
  if (st.selection.length !== 1) return false;
  const loc = st.doc.pages.flatMap((p) => collectImages(p.children)).find((n) => n.id === st.selection[0]);
  if (!loc) return false;
  const url = imageNodeUrl(loc);
  if (!url) throw new CodedError("errors.image_no_source", "This image has no source to describe.");
  const text = await describe(workspaceId, url);
  if (text) useEditor.getState().setImageAlt(loc.id, text);
  return true;
}

/**
 * Generate alt text for EVERY image node across the design and write each result
 * to its node's `alt` field. Each write is its own undo step. Returns how many
 * images were described and how many failed. A systematic provider failure (the
 * very first describe call throws before anything succeeds, e.g. a non-vision
 * model) is rethrown so the caller surfaces the real error instead of silently
 * reporting "0 described"; later per-image failures are counted and skipped.
 */
export async function generateAltTextForAll(
  workspaceId: string,
): Promise<{ done: number; failed: number }> {
  const st = useEditor.getState();
  const images = st.doc.pages.flatMap((p) => collectImages(p.children));
  let done = 0;
  let failed = 0;
  for (const node of images) {
    const url = imageNodeUrl(node);
    if (!url) continue;
    try {
      const text = await describe(workspaceId, url);
      if (text) {
        useEditor.getState().setImageAlt(node.id, text);
        done++;
      }
    } catch (e) {
      // The first failure with nothing yet succeeded is almost certainly a
      // provider/config problem (wrong model, provider down); surface it.
      if (done === 0 && failed === 0) throw e;
      failed++;
    }
  }
  return { done, failed };
}

/** Collect every ImageNode in a node list (including nested containers). */
function collectImages(nodes: Parameters<typeof walkNodes>[0]): ImageNode[] {
  const out: ImageNode[] = [];
  walkNodes(nodes, (node) => {
    if (node.type === "image") out.push(node as ImageNode);
  });
  return out;
}

/**
 * Describe a CHART from its DATA (F28 completion C29): categories and series
 * values go through the plain text model (no vision needed), and the result
 * lands in the node's altText as one undo step. Returns false when the node
 * is not a chart; throws provider errors for the caller to surface.
 */
export async function generateChartAltText(workspaceId: string, nodeId: string): Promise<boolean> {
  type ChartLike = { id: string; type: string; chartType?: string; categories?: string[]; series?: { name: string; values: number[] }[] };
  const st = useEditor.getState();
  let chart: ChartLike | null = null;
  for (const p of st.doc.pages) {
    const hit = p.children.find((n) => n.id === nodeId && n.type === "chart");
    if (hit) { chart = hit as unknown as ChartLike; break; }
  }
  if (!chart) return false;
  const cats = (chart.categories ?? []).slice(0, 24);
  const rows = (chart.series ?? []).slice(0, 8).map((s2) => `${s2.name}: ${s2.values.slice(0, 24).join(", ")}`);
  const { text } = await oc.aiText({
    workspaceId,
    prompt: `Chart type: ${chart.chartType ?? "bar"}\nCategories: ${cats.join(", ")}\n${rows.join("\n")}`,
    // i18n-ignore: model system prompt, never translated.
    system: "Write ONE sentence of alt text describing this chart's key takeaway for a screen-reader user: what is measured, the standout value or trend, plain words. Return only the sentence.",
  });
  const clean = text.trim();
  if (!clean) return false;
  useEditor.getState().setNodeAltText(nodeId, clean.slice(0, 300));
  return true;
}
