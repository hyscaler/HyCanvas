// F28 T10 - the per-slide image pipeline's pure decisions: the stable
// prompt-key used to tag and reuse generated assets (identical prompt = same
// asset, zero cost), and the stock-vs-generate routing heuristic. UI-free.

/** Stable reuse key for a generation prompt: normalized (case/whitespace) and
 *  hashed (FNV-1a 32-bit) into a workspace-asset tag. Two visually identical
 *  prompts map to one key, so a regenerated deck finds and reuses the assets
 *  the first run produced. */
export function promptAssetKey(prompt: string): string {
  const norm = prompt.toLowerCase().replace(/\s+/g, " ").trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `aiimg-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

/** Markers of stylized/abstract intent: prompts carrying them want a GENERATED
 *  image; without them a short, concrete-noun prompt is well served by stock
 *  photography (cheaper, instant, licensed). */
const stylizedMarkers = /\b(abstract|gradient|texture|pattern|illustration|3d|render(?:ed|ing)?|isometric|watercolor|neon|surreal|futuristic|low.?poly|pixel.?art|line.?art|flat.?design|minimalis\w*|vaporwave|cinematic|dramatic|bokeh|logo|icon|background|backdrop|wallpaper|style|styled)\b/i;

/** Route an image request: "stock" when the prompt reads as a short, concrete
 *  subject a photo library can match ("a barista pouring latte art"); else
 *  "generate". The caller still degrades stock misses to generation. */
export function routeImageSource(prompt: string): "stock" | "generate" {
  const p = prompt.trim();
  if (!p || stylizedMarkers.test(p)) return "generate";
  // Word count over significant tokens: articles and glue words don't add
  // specificity, so they don't count against the concreteness budget.
  const words = p.toLowerCase().split(/\s+/).filter((w) => !["a", "an", "the", "of", "in", "on", "at", "with", "and"].includes(w));
  return words.length <= 5 ? "stock" : "generate";
}

/** Diff desired image prompts against the ones already materialized on the
 *  page: only slots whose prompt CHANGED (or is new) get regenerated, so a
 *  per-slide regeneration keeps its unchanged images (and their cost) intact.
 *  Comparison uses the same normalization as the reuse key, so a whitespace or
 *  case difference is not a change. */
export function changedImagePrompts(
  current: Record<string, string>,
  next: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [slot, prompt] of Object.entries(next)) {
    const prev = current[slot];
    if (!prev || promptAssetKey(prev) !== promptAssetKey(prompt)) out[slot] = prompt;
  }
  return out;
}
