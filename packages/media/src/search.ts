// In-memory asset search. This is the canonical filter/sort logic
// the database query mirrors; it also powers client-side filtering of an
// already-loaded page. Trashed assets are excluded unless explicitly included.

import type { Asset, AssetKind, AssetQuery } from "./types";

function hexToRgb(hex: string): [number, number, number] | null {
  const h = hex.replace("#", "");
  if (h.length !== 6) return null;
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Approximate color match: any dominant color within a distance threshold. */
function colorMatches(asset: Asset, hex: string, maxDist = 60): boolean {
  const target = hexToRgb(hex);
  if (!target) return false;
  for (const c of asset.meta.dominantColors ?? []) {
    const rgb = hexToRgb(c);
    if (!rgb) continue;
    const d = Math.sqrt((rgb[0] - target[0]) ** 2 + (rgb[1] - target[1]) ** 2 + (rgb[2] - target[2]) ** 2);
    if (d <= maxDist) return true;
  }
  return false;
}

function orientationOf(asset: Asset): "landscape" | "portrait" | "square" | null {
  const { width, height } = asset.meta;
  if (!width || !height) return null;
  if (width > height) return "landscape";
  if (height > width) return "portrait";
  return "square";
}

function textMatches(asset: Asset, q: string): boolean {
  const needle = q.toLowerCase();
  if (asset.name.toLowerCase().includes(needle)) return true;
  if (asset.meta.altText?.toLowerCase().includes(needle)) return true;
  return asset.tags.some((t) => t.value.toLowerCase().includes(needle));
}

/** Whether a single asset satisfies a query. */
export function matchAsset(asset: Asset, query: AssetQuery): boolean {
  // Only `ready` assets are searchable/placeable (FR-4); trashed appear only
  // when explicitly requested; other in-flight states never match search.
  if (asset.status === "trashed") {
    if (!query.includeTrashed) return false;
  } else if (asset.status !== "ready") {
    return false;
  }

  if (query.text && !textMatches(asset, query.text)) return false;

  if (query.kind) {
    const kinds: AssetKind[] = Array.isArray(query.kind) ? query.kind : [query.kind];
    if (!kinds.includes(asset.kind)) return false;
  }

  if (query.folderId !== undefined) {
    const f = asset.folderId ?? null;
    if (f !== query.folderId) return false;
  }

  if (query.favorite !== undefined && asset.favorite !== query.favorite) return false;

  if (query.color && !colorMatches(asset, query.color)) return false;

  if (query.orientation && orientationOf(asset) !== query.orientation) return false;

  if (query.minWidth !== undefined && (asset.meta.width ?? 0) < query.minWidth) return false;
  if (query.minHeight !== undefined && (asset.meta.height ?? 0) < query.minHeight) return false;

  if (query.durationMs) {
    const d = asset.meta.durationMs ?? 0;
    if (query.durationMs.min !== undefined && d < query.durationMs.min) return false;
    if (query.durationMs.max !== undefined && d > query.durationMs.max) return false;
  }

  if (query.createdAfter && asset.createdAt < query.createdAfter) return false;
  if (query.createdBefore && asset.createdAt > query.createdBefore) return false;

  return true;
}

function compare(a: Asset, b: Asset, sort: AssetQuery["sort"]): number {
  switch (sort) {
    case "name":
      return a.name.localeCompare(b.name);
    case "size":
      return b.byteSize - a.byteSize;
    case "kind":
      return a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name);
    case "recent":
    default:
      return b.createdAt.localeCompare(a.createdAt); // newest first (ISO strings sort lexically)
  }
}

/** Filter and sort assets for a query (FR-9). Pure; no pagination. */
export function searchAssets(assets: Asset[], query: AssetQuery = {}): Asset[] {
  return assets.filter((a) => matchAsset(a, query)).sort((a, b) => compare(a, b, query.sort));
}
