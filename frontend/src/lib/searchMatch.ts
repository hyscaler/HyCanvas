// Client-side helpers for showing search matches. They mirror the backend's
// title match (@hc/authz and home.Search): a case-insensitive substring, ranked
// exact, then prefix, then anywhere.

export interface MatchPart { text: string; match: boolean }

/** Splits `text` into runs, marking every case-insensitive occurrence of `q`. */
export function matchParts(text: string, q: string): MatchPart[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [{ text, match: false }];
  const hay = text.toLowerCase();
  const parts: MatchPart[] = [];
  let from = 0;
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, from)) {
    if (at > from) parts.push({ text: text.slice(from, at), match: false });
    parts.push({ text: text.slice(at, at + needle.length), match: true });
    from = at + needle.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), match: false });
  return parts.length ? parts : [{ text, match: false }];
}

/** Titles containing `q`, best match first (exact, prefix, then anywhere). */
export function rankByTitle<T extends { title: string }>(items: T[], q: string): T[] {
  const n = q.trim().toLowerCase();
  if (!n) return items;
  const score = (t: string) => (t === n ? 3 : t.startsWith(n) ? 2 : t.includes(n) ? 1 : 0);
  return items
    .map((item, i) => ({ item, i, s: score(item.title.toLowerCase()) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.item);
}
