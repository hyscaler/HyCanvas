// Catalog search: filter-to-query mapping and the canonical match/sort the
// backend mirrors. Color filtering matches against
// extracted dominant colors within a tolerance (Section 9), not exact hex.

import type { StockAsset, StockKind, StockQuery } from "./types";

function hexToRgb(hex: string): [number, number, number] | null {
  const h = hex.replace("#", "");
  if (h.length !== 6) return null;
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Whether any of the asset's dominant colors is within `maxDist` of `hex`. */
export function colorMatches(asset: StockAsset, hex: string, maxDist = 60): boolean {
  const target = hexToRgb(hex);
  if (!target) return false;
  for (const c of asset.dominantColors) {
    const rgb = hexToRgb(c);
    if (!rgb) continue;
    const d = Math.sqrt((rgb[0] - target[0]) ** 2 + (rgb[1] - target[1]) ** 2 + (rgb[2] - target[2]) ** 2);
    if (d <= maxDist) return true;
  }
  return false;
}

/** Parse raw query-string-style filter params into a typed StockQuery (FR-2). */
export function filtersToQuery(params: Record<string, string | undefined>): StockQuery {
  const q: StockQuery = {};
  if (params.q) q.text = params.q;
  if (params.kind) q.kind = params.kind.split(",") as StockKind[];
  if (params.orientation === "landscape" || params.orientation === "portrait" || params.orientation === "square") {
    q.orientation = params.orientation;
  }
  if (params.color) q.color = params.color;
  if (params.category) q.category = params.category;
  if (params.style) q.style = params.style.split(",");
  if (params.license) q.license = params.license.split(",") as StockQuery["license"];
  const min = params.durMin !== undefined ? Number(params.durMin) : undefined;
  const max = params.durMax !== undefined ? Number(params.durMax) : undefined;
  if (min !== undefined || max !== undefined) q.durationMs = { min, max };
  if (params.collection) q.collectionId = params.collection;
  if (params.sort === "newest") q.sort = "newest";
  return q;
}

function textRelevance(asset: StockAsset, q: string): number {
  const needle = q.toLowerCase();
  if (asset.title.toLowerCase() === needle) return 100;
  let score = 0;
  if (asset.title.toLowerCase().includes(needle)) score += 50;
  for (const t of asset.tags) {
    if (t.toLowerCase() === needle) score += 20;
    else if (t.toLowerCase().includes(needle)) score += 8;
  }
  return score;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

/** Whether an asset satisfies a query (no text-relevance gate beyond a match). */
export function stockMatches(asset: StockAsset, query: StockQuery): boolean {
  if (query.text && textRelevance(asset, query.text) === 0) return false;

  const kinds = asArray(query.kind);
  if (kinds.length && !kinds.includes(asset.kind)) return false;

  if (query.orientation && asset.orientation !== query.orientation) return false;

  if (query.category && asset.category !== query.category) return false;

  if (query.color && !colorMatches(asset, query.color)) return false;

  const styles = asArray(query.style);
  if (styles.length && !styles.some((s) => (asset.style ?? []).includes(s))) return false;

  const licenses = asArray(query.license);
  if (licenses.length && !licenses.includes(asset.license.type)) return false;

  if (query.durationMs) {
    const d = asset.durationMs ?? 0;
    if (query.durationMs.min !== undefined && d < query.durationMs.min) return false;
    if (query.durationMs.max !== undefined && d > query.durationMs.max) return false;
  }

  if (query.collectionId && !asset.collectionIds.includes(query.collectionId)) return false;

  return true;
}

/** Filter and relevance-rank a catalog slice for a query (FR-1, AC-1). */
export function searchStock(assets: StockAsset[], query: StockQuery = {}): StockAsset[] {
  const matched = assets.filter((a) => stockMatches(a, query));
  if (query.sort === "newest") return matched; // caller supplies newest-first order
  if (!query.text) return matched;
  return matched
    .map((a) => ({ a, score: textRelevance(a, query.text!) }))
    .sort((x, y) => y.score - x.score || x.a.title.localeCompare(y.a.title))
    .map((r) => r.a);
}
