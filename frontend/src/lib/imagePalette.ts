// The dominant colours of a loaded image asset, for suggesting a palette from
// a photo or logo already on the canvas. Samples the decoded bitmap at a
// modest size (longest side 128px) for a fast, stable result, then runs the
// shared @hc/color extractor.

import { extractPalette, toHex } from "@hc/color";
import type { Node } from "@hc/schema";
import { imageAssets } from "@/lib/assetProvider";

type Sized = CanvasImageSource & { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number };

/** Hex colours of the asset, deduped, or [] when it is not loaded yet or the
 *  canvas is tainted (a cross-origin image served without CORS). */
export function imageAssetPalette(assetId: string, count = 6): string[] {
  const img = imageAssets.image(assetId) as Sized | null;
  if (!img) return [];
  const w = img.naturalWidth || img.width || 0;
  const h = img.naturalHeight || img.height || 0;
  if (!w || !h) return [];
  try {
    const SAMPLE = 128;
    const scale = Math.min(1, SAMPLE / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return [];
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return [...new Set(extractPalette(ctx.getImageData(0, 0, canvas.width, canvas.height), count).map(toHex))];
  } catch {
    return [];
  }
}

/** Asset ids of the image layers among `nodes` (groups walked). */
export function imageAssetIds(nodes: readonly Node[]): string[] {
  const out: string[] = [];
  const walk = (ns: readonly Node[]) => {
    for (const n of ns) {
      const any = n as unknown as { type?: string; source?: { assetId?: string }; children?: Node[] };
      if (any.type === "image" && any.source?.assetId) out.push(any.source.assetId);
      if (any.children?.length) walk(any.children);
    }
  };
  walk(nodes);
  return [...new Set(out)];
}
