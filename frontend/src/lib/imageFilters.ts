// F24 image effects: filter-preset definitions, auto-enhance, and the lazy
// in-browser background remover. Presets are pure data (bundles of adjustment
// ops) so applying one is a single `setEffects` undo step; the engine maps the
// ops to its CSS-filter path (see @hc/engine effectsFilter / adjustmentOpToFilters).
import { CodedError } from "./errors";

/** One adjustment op: a named scalar the engine maps to a CSS filter. */
export interface AdjOp {
  name: string;
  value: number;
}

/**
 * A named, Instagram-style look: a fixed bundle of adjustment ops. The bundle's
 * "strength" ops are scaled toward their neutral value by an intensity 0..1 so
 * the user can dial a preset down. Multiplicative ops (brightness/contrast/
 * saturate, neutral 1) and additive ops (warmth/tint/exposure/..., neutral 0)
 * are both blended toward neutral.
 */
export interface FilterPreset {
  id: string;
  name: string;
  ops: AdjOp[];
}

// Neutral (identity) value per op family, used to blend a preset by intensity.
const NEUTRAL: Record<string, number> = {
  brightness: 1,
  contrast: 1,
  saturate: 1,
  grayscale: 0,
  sepia: 0,
  "hue-rotate": 0,
  blur: 0,
  exposure: 0,
  warmth: 0,
  temperature: 0,
  tint: 0,
  vibrance: 0,
  highlights: 0,
  shadows: 0,
};

function neutralOf(name: string): number {
  return NEUTRAL[name] ?? 0;
}

/** Curated presets. Values are conservative so they read as "a look", not a smash. */
export const FILTER_PRESETS: FilterPreset[] = [
  { id: "original", name: "Original", ops: [] },
  { id: "clarendon", name: "Clarendon", ops: [
    { name: "contrast", value: 1.2 }, { name: "saturate", value: 1.35 }, { name: "brightness", value: 1.05 }, { name: "warmth", value: -0.15 },
  ] },
  { id: "gingham", name: "Gingham", ops: [
    { name: "brightness", value: 1.05 }, { name: "saturate", value: 0.85 }, { name: "warmth", value: 0.1 }, { name: "contrast", value: 0.95 },
  ] },
  { id: "moon", name: "Moon", ops: [
    { name: "grayscale", value: 1 }, { name: "contrast", value: 1.1 }, { name: "brightness", value: 1.1 },
  ] },
  { id: "lark", name: "Lark", ops: [
    { name: "brightness", value: 1.08 }, { name: "saturate", value: 1.1 }, { name: "warmth", value: -0.1 }, { name: "exposure", value: 0.06 },
  ] },
  { id: "noir", name: "Noir", ops: [
    { name: "grayscale", value: 1 }, { name: "contrast", value: 1.4 }, { name: "brightness", value: 0.95 },
  ] },
  { id: "vivid", name: "Vivid", ops: [
    { name: "saturate", value: 1.5 }, { name: "contrast", value: 1.15 }, { name: "vibrance", value: 0.3 },
  ] },
  { id: "warm", name: "Warm", ops: [
    { name: "warmth", value: 0.4 }, { name: "saturate", value: 1.1 }, { name: "brightness", value: 1.03 },
  ] },
  { id: "cool", name: "Cool", ops: [
    { name: "warmth", value: -0.4 }, { name: "saturate", value: 1.05 }, { name: "tint", value: -0.1 },
  ] },
  { id: "fade", name: "Fade", ops: [
    { name: "contrast", value: 0.85 }, { name: "saturate", value: 0.8 }, { name: "brightness", value: 1.08 },
  ] },
  { id: "sepia", name: "Sepia", ops: [
    { name: "sepia", value: 0.7 }, { name: "contrast", value: 1.05 }, { name: "warmth", value: 0.2 },
  ] },
];

/**
 * Resolve a preset's ops at a given intensity (0..1), blending each op from its
 * neutral value toward the preset value. Returns ops to hand to setEffects as a
 * single `adjustment` effect.
 */
export function resolvePresetOps(preset: FilterPreset, intensity: number): AdjOp[] {
  const k = intensity < 0 ? 0 : intensity > 1 ? 1 : intensity;
  if (k === 0) return [];
  return preset.ops
    .map((op) => {
      const n = neutralOf(op.name);
      const value = n + (op.value - n) * k;
      return { name: op.name, value };
    })
    .filter((op) => op.value !== neutralOf(op.name));
}

/**
 * Auto-enhance: a sensible one-click bundle. A balanced lift in exposure,
 * contrast, and vibrance with a touch of warmth, tuned to flatter most photos
 * without clipping. Returned as adjustment ops for a single undo step.
 */
export function autoEnhanceOps(): AdjOp[] {
  return [
    { name: "brightness", value: 1.04 },
    { name: "contrast", value: 1.12 },
    { name: "vibrance", value: 0.25 },
    { name: "saturate", value: 1.08 },
    { name: "warmth", value: 0.06 },
    { name: "shadows", value: 0.15 },
  ];
}

/** Result of running the in-browser background remover. */
export interface BgRemovalResult {
  /** A data: URL of the transparent-cutout PNG. */
  dataUrl: string;
}

/**
 * Rasterize an image Blob to a PNG Blob at the given size. Used before background
 * removal because the segmentation model only accepts raster images, feeding it a
 * vector (SVG) throws "Invalid format: image/svg+xml". Drawing a same-origin Blob
 * to a canvas keeps it untainted. Size is capped so a huge source can't allocate
 * an enormous canvas.
 */
export async function rasterizeToPng(blob: Blob, width: number, height: number): Promise<Blob> {
  const MAX = 2048;
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new CodedError("errors.image_decode_failed", "Couldn't decode the image."));
      el.src = url;
    });
    let w = Math.max(1, Math.round(width || img.naturalWidth || 1024));
    let h = Math.max(1, Math.round(height || img.naturalHeight || 1024));
    const scale = Math.min(1, MAX / Math.max(w, h));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new CodedError("errors.canvas_unavailable", "Canvas is unavailable in this browser.");
    ctx.drawImage(img, 0, 0, w, h);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new CodedError("errors.image_rasterize_failed", "Couldn't rasterize the image."))), "image/png"),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Remove the background of an image entirely in the browser using
 * `@imgly/background-removal` (an ISNet/U2Net foreground-segmentation model, the
 * standard class of model for this task). The library is dynamically imported so its
 * model (downloaded on first use) never bloats the main bundle or the static
 * export. `onProgress` reports 0..1 while the model downloads/runs.
 *
 * Pass a `Blob` (preferred): the caller fetches the image through the app's own
 * authenticated, same-origin path, so the library never has to fetch a
 * (possibly relative or cross-origin) URL itself, which was the main reason
 * removal failed. A string URL is still accepted as a fallback.
 */
export async function removeBackground(
  input: string | Blob,
  onProgress?: (fraction: number) => void,
): Promise<BgRemovalResult> {
  if (typeof window === "undefined") {
    throw new CodedError("errors.bg_removal_browser_only", "Background removal runs in the browser only.");
  }
  let removeBackgroundFn: (
    input: string | Blob,
    config?: Record<string, unknown>,
  ) => Promise<Blob>;
  try {
    const mod = await import("@imgly/background-removal");
    removeBackgroundFn = (mod as unknown as { removeBackground: typeof removeBackgroundFn }).removeBackground;
  } catch {
    throw new CodedError("errors.bg_remover_load_failed", "Could not load the background remover. Check your connection and try again.");
  }
  try {
    const blob = await removeBackgroundFn(input, {
      // Prefer WebGPU when available (much faster + higher quality), falling back
      // to WASM/CPU automatically. Output a transparent PNG cutout.
      device: "gpu",
      output: { format: "image/png" },
      progress: (_key: string, current: number, total: number) => {
        if (onProgress && total > 0) onProgress(Math.min(1, current / total));
      },
    });
    const dataUrl = await blobToDataUrl(blob);
    return { dataUrl };
  } catch (err) {
    // The library's own errors are cryptic (fetch/wasm internals), so the code
    // translates to a friendly message at the display boundary while the
    // English message keeps the detail for logs.
    const detail = err instanceof Error ? err.message : String(err);
    throw new CodedError("errors.background_removal_failed", `Background removal failed: ${detail}`);
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Unexpected reader result"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Read failed"));
    reader.readAsDataURL(blob);
  });
}
