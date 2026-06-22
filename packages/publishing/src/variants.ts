// Render-variant dedup and multi-platform sizing (FR-4/FR-5). Pure.
//
// FR-4: render output is cached and reused across targets that share
// dimensions. We collapse same-(width,height,format) targets onto a single
// variant keyed stably so the export engine renders each unique spec once.

import type { SocialPlatform } from "./types";

export type VariantFormat = "png" | "jpg" | "mp4";

export interface PlatformFormat {
  /** A human label for the format, e.g. "square" or "story". */
  name: string;
  width: number;
  height: number;
  format: VariantFormat;
}

/**
 * Recommended export sizes per platform. Each platform lists one or more named
 * formats; the first entry is the default/primary feed format.
 */
export const PLATFORM_FORMATS: Record<SocialPlatform, PlatformFormat[]> = {
  instagram: [
    { name: "square", width: 1080, height: 1080, format: "png" },
    { name: "portrait", width: 1080, height: 1350, format: "png" },
    { name: "story", width: 1080, height: 1920, format: "png" },
  ],
  facebook: [{ name: "feed", width: 1200, height: 630, format: "png" }],
  x: [{ name: "landscape", width: 1600, height: 900, format: "png" }],
  linkedin: [{ name: "feed", width: 1200, height: 627, format: "png" }],
  tiktok: [{ name: "vertical", width: 1080, height: 1920, format: "mp4" }],
  pinterest: [{ name: "pin", width: 1000, height: 1500, format: "png" }],
  youtube: [{ name: "thumbnail", width: 1280, height: 720, format: "png" }],
};

/** The primary recommended format for a platform. */
export function primaryFormat(platform: SocialPlatform): PlatformFormat {
  return PLATFORM_FORMATS[platform][0];
}

/**
 * A stable dedup key for a render variant: identical design+page+dimensions+
 * format always produce the same key, so renders are reused across targets.
 */
export function variantKey(
  designId: string,
  pageId: string,
  width: number,
  height: number,
  format: VariantFormat,
): string {
  return `${designId}:${pageId}:${width}x${height}:${format}`;
}

/** A per-target request to render the design at a specific spec. */
export interface VariantTarget {
  targetId: string;
  width: number;
  height: number;
  format: VariantFormat;
}

export interface PlannedVariant {
  key: string;
  width: number;
  height: number;
  format: VariantFormat;
  targetIds: string[];
}

/**
 * Collapse targets that share the same (width,height,format) onto a single
 * planned variant (FR-4). Returns one entry per unique spec with all the target
 * ids that map to it, preserving first-seen order of specs.
 */
export function planVariants(
  designId: string,
  pageId: string,
  targets: readonly VariantTarget[],
): PlannedVariant[] {
  const byKey = new Map<string, PlannedVariant>();
  const order: string[] = [];
  for (const t of targets) {
    const key = variantKey(designId, pageId, t.width, t.height, t.format);
    let entry = byKey.get(key);
    if (!entry) {
      entry = { key, width: t.width, height: t.height, format: t.format, targetIds: [] };
      byKey.set(key, entry);
      order.push(key);
    }
    entry.targetIds.push(t.targetId);
  }
  return order.map((k) => byKey.get(k)!);
}

export interface ResizeProposal {
  platform: SocialPlatform;
  width: number;
  height: number;
  /**
   * "fit" letterboxes the source inside the target (no crop); "fill" crops to
   * cover the target. We propose "fill" when the aspect ratios are close and
   * "fit" when they differ enough that cropping would lose meaningful content.
   */
  mode: "fit" | "fill";
}

/**
 * Propose a resized variant per platform from a source design's dimensions
 * (FR-5). Uses each platform's primary format. The fit/fill mode is a heuristic
 * based on how much the source and target aspect ratios diverge.
 */
export function proposeResizes(
  sourceW: number,
  sourceH: number,
  platforms: readonly SocialPlatform[],
): ResizeProposal[] {
  const sourceAspect = sourceW / sourceH;
  return platforms.map((platform) => {
    const fmt = primaryFormat(platform);
    const targetAspect = fmt.width / fmt.height;
    // Relative aspect difference; > 25% divergence => fit (avoid heavy crop).
    const diff = Math.abs(sourceAspect - targetAspect) / targetAspect;
    return {
      platform,
      width: fmt.width,
      height: fmt.height,
      mode: diff > 0.25 ? "fit" : "fill",
    };
  });
}
