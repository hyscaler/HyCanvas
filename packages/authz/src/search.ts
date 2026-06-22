// Universal search ranking. Canonical relevance/type-facet
// logic over the unified HomeItem the backend mirrors; callers pre-scope items
// to the active workspace's accessible set (plus public templates).

import type { HomeItem } from "./types";

export interface SearchQuery {
  q?: string;
  type?: HomeItem["kind"] | HomeItem["kind"][];
}

function relevance(item: HomeItem, q: string): number {
  const t = item.title.toLowerCase();
  const n = q.toLowerCase();
  if (t === n) return 100;
  if (t.startsWith(n)) return 60;
  if (t.includes(n)) return 30;
  return 0;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

/**
 * Filter by type facet and (when a query is given) text relevance, then rank by
 * relevance, then starred, then most-recently-updated.
 */
export function searchHome(items: HomeItem[], query: SearchQuery = {}): HomeItem[] {
  const types = asArray(query.type);
  let pool = types.length ? items.filter((i) => types.includes(i.kind)) : items;

  if (query.q) {
    pool = pool
      .map((i) => ({ i, score: relevance(i, query.q!) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score
        || Number(b.i.starred) - Number(a.i.starred)
        || b.i.updatedAt.localeCompare(a.i.updatedAt))
      .map((r) => r.i);
    return pool;
  }

  return [...pool].sort((a, b) =>
    Number(b.starred) - Number(a.starred) || b.updatedAt.localeCompare(a.updatedAt),
  );
}
