// Template search. Canonical filter/relevance logic
// the backend mirrors; also enforces visibility scope so personal/team
// templates never leak across workspaces (Section 10).

import type { Template, TemplateQuery } from "./types";

function hexToRgb(hex: string): [number, number, number] | null {
  const h = hex.replace("#", "");
  if (h.length < 6) return null;
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function colorMatches(t: Template, hex: string, maxDist = 70): boolean {
  const target = hexToRgb(hex);
  if (!target) return false;
  return t.style.palette.some((c) => {
    const rgb = hexToRgb(c);
    if (!rgb) return false;
    const d = Math.sqrt((rgb[0] - target[0]) ** 2 + (rgb[1] - target[1]) ** 2 + (rgb[2] - target[2]) ** 2);
    return d <= maxDist;
  });
}

function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

/** Parse query-string-style params into a typed TemplateQuery (FR-2). */
export function filtersToTemplateQuery(params: Record<string, string | undefined>, workspaceId?: string | null): TemplateQuery {
  const q: TemplateQuery = {};
  if (params.q) q.text = params.q;
  if (params.color) q.color = params.color;
  if (params.style) q.style = params.style.split(",");
  if (params.category) q.category = params.category.split(",");
  if (params.scope === "personal" || params.scope === "team" || params.scope === "public" || params.scope === "all") q.scope = params.scope;
  if (params.format) {
    const [w, h] = params.format.split("x").map(Number);
    if (Number.isFinite(w) && Number.isFinite(h)) q.format = { width: w, height: h };
  }
  if (workspaceId !== undefined) q.workspaceId = workspaceId;
  return q;
}

/** Visibility-scope gate: enforce per-workspace isolation (Section 10). */
function scopeAllows(t: Template, query: TemplateQuery): boolean {
  const scope = query.scope ?? "all";
  const ws = query.workspaceId ?? null;
  const ownScope = t.visibility === "public" || ((t.visibility === "personal" || t.visibility === "team") && t.workspaceId === ws);
  if (scope === "all") return ownScope;
  if (scope === "public") return t.visibility === "public";
  // personal/team: must match the requested visibility AND the workspace.
  return t.visibility === scope && t.workspaceId === ws;
}

function textRelevance(t: Template, q: string): number {
  const n = q.toLowerCase();
  let s = 0;
  if (t.title.toLowerCase() === n) s += 100;
  else if (t.title.toLowerCase().includes(n)) s += 50;
  for (const tag of t.tags) if (tag.toLowerCase().includes(n)) s += 8;
  for (const cat of t.categories) if (cat.toLowerCase().includes(n)) s += 5;
  return s;
}

export function templateMatches(t: Template, query: TemplateQuery): boolean {
  if (!scopeAllows(t, query)) return false;
  if (query.text && textRelevance(t, query.text) === 0) return false;
  if (query.color && !colorMatches(t, query.color)) return false;
  const styles = asArray(query.style);
  if (styles.length && !styles.some((s) => (t.style.styleTags ?? []).includes(s))) return false;
  const cats = asArray(query.category);
  if (cats.length && !cats.some((c) => t.categories.includes(c))) return false;
  if (query.format && (t.format.width !== query.format.width || t.format.height !== query.format.height)) return false;
  return true;
}

/** Filter and relevance-rank templates for a query (FR-2, AC-1). */
export function searchTemplates(templates: Template[], query: TemplateQuery = {}): Template[] {
  const matched = templates.filter((t) => templateMatches(t, query));
  if (!query.text) return matched;
  return matched
    .map((t) => ({ t, score: textRelevance(t, query.text!) }))
    .sort((a, b) => b.score - a.score || a.t.title.localeCompare(b.t.title))
    .map((r) => r.t);
}
