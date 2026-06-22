// Marketplace ranking + faceting: pure sort/aggregate helpers for the
// template marketplace surface. searchTemplates handles text relevance + scoped
// filtering; this adds the marketplace-specific ordering (popular / recent /
// relevance) over PUBLISHED templates and the facet counts the filter sidebar
// needs. No I/O; the catalog/CDN and preview rendering remain backend concerns.

import type { Template } from "./types";

export type MarketplaceSort = "popular" | "recent" | "relevance";

/** Only templates published to the marketplace are eligible to be listed. */
export function isPublished(t: Template): boolean {
  return t.marketplace?.status === "published";
}

function usage(t: Template): number {
  return t.marketplace?.usageCount ?? 0;
}

/** Rank published templates for the marketplace. "popular" orders by usage,
 *  "recent" by last update, "relevance" preserves the caller's (already
 *  relevance-sorted) order. Ties break by usage then title for stability. */
export function rankMarketplace(templates: Template[], sort: MarketplaceSort = "popular"): Template[] {
  const listed = templates.filter(isPublished);
  if (sort === "relevance") return listed;
  const byTitle = (a: Template, b: Template) => a.title.localeCompare(b.title);
  if (sort === "recent") {
    return [...listed].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || usage(b) - usage(a) || byTitle(a, b));
  }
  return [...listed].sort((a, b) => usage(b) - usage(a) || b.updatedAt.localeCompare(a.updatedAt) || byTitle(a, b));
}

export interface Facet {
  value: string;
  count: number;
}
export interface TemplateFacets {
  categories: Facet[];
  tags: Facet[];
  styles: Facet[];
}

function countField(templates: Template[], pick: (t: Template) => string[]): Facet[] {
  const counts = new Map<string, number>();
  for (const t of templates) for (const v of pick(t)) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/** Aggregate category / tag / style facets (with counts) for the filter sidebar,
 *  over the published templates only. */
export function templateFacets(templates: Template[]): TemplateFacets {
  const listed = templates.filter(isPublished);
  return {
    categories: countField(listed, (t) => t.categories),
    tags: countField(listed, (t) => t.tags),
    styles: countField(listed, (t) => t.style?.styleTags ?? []),
  };
}
