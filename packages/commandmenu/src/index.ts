// @hc/commandmenu: fuzzy search over command-palette items.
// Framework-agnostic and decoupled from @hc/editor: callers pass plain MenuItems
// (the editor's Command satisfies this structurally) with a precomputed
// `enabled` flag for the current context. Ranking is subsequence match quality
// plus a recency/frequency boost; disabled items are kept but ranked lower so
// the UI can grey them (they are never silently dropped).

export interface MenuItem {
  id: string;
  label: string;
  keywords?: string[];
  category?: string;
  /** Precomputed for the active context; disabled items rank lower (FR-11). */
  enabled?: boolean;
  /** Bound shortcut to display, if any. */
  shortcut?: string;
}

export interface SearchOptions {
  recents?: string[]; // command ids, most-recent first
  frequency?: Record<string, number>; // command id -> run count
  limit?: number;
}

export interface SearchResult {
  item: MenuItem;
  score: number;
}

/**
 * Subsequence fuzzy score of `query` against `text`. Returns null when `query`
 * is not a subsequence of `text`. Higher is better: consecutive matches, matches
 * at word starts, and an earlier first match all score higher.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return 0;

  let score = 0;
  let ti = 0;
  let firstIndex = -1;
  let prevMatch = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    for (let j = ti; j < t.length; j++) {
      if (t[j] === ch) {
        found = j;
        break;
      }
    }
    if (found < 0) return null;
    if (firstIndex < 0) firstIndex = found;
    if (found === prevMatch + 1) score += 6; // consecutive run bonus
    else score += 1;
    const isBoundary = found === 0 || t[found - 1] === " " || t[found - 1] === "-" || t[found - 1] === "/";
    if (isBoundary) score += 4; // word-start bonus
    prevMatch = found;
    ti = found + 1;
  }
  // Reward matches that start near the beginning of the label.
  score += Math.max(0, 5 - firstIndex);
  return score;
}

/** Best subsequence score of the query over the item's label and keywords. */
function itemScore(query: string, item: MenuItem): number | null {
  let best: number | null = fuzzyScore(query, item.label);
  for (const kw of item.keywords ?? []) {
    const s = fuzzyScore(query, kw);
    // A keyword hit scores slightly below an equivalent label hit.
    if (s !== null) {
      const adjusted = s - 1;
      best = best === null ? adjusted : Math.max(best, adjusted);
    }
  }
  return best;
}

const RECENCY_WEIGHT = 12;
const FREQUENCY_WEIGHT = 2;
const DISABLED_PENALTY = 1000;

function boost(id: string, opts: SearchOptions): number {
  let b = 0;
  const ri = opts.recents?.indexOf(id) ?? -1;
  if (ri >= 0) b += RECENCY_WEIGHT - ri; // more recent -> larger boost
  const freq = opts.frequency?.[id] ?? 0;
  b += Math.min(freq, 10) * FREQUENCY_WEIGHT;
  return b;
}

/**
 * Rank items for the palette. With an empty query, returns items ordered by
 * recency/frequency (the "Recent" section first), then the rest. Disabled items
 * are included but penalized so they sort to the bottom.
 */
export function search(query: string, items: MenuItem[], opts: SearchOptions = {}): SearchResult[] {
  const q = query.trim();
  const scored: SearchResult[] = [];
  for (const item of items) {
    let base: number | null;
    if (q.length === 0) {
      // Empty query: only surface recents/frequent, plus everything at base 0.
      base = 0;
    } else {
      base = itemScore(q, item);
      if (base === null) continue; // no match -> excluded from filtered results
    }
    let score = base + boost(item.id, opts);
    if (item.enabled === false) score -= DISABLED_PENALTY;
    scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label));
  return typeof opts.limit === "number" ? scored.slice(0, opts.limit) : scored;
}
