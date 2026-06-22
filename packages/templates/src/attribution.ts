// Attribution merge. When a template that embeds
// attribution-required stock is applied into a design, its inherited credits
// merge into the design's credits, deduped by asset with node ids unioned.

import type { AttributionEntry } from "@hc/stock";

/** Merge incoming attribution entries into existing ones, dedup by assetId. */
export function mergeAttributions(existing: AttributionEntry[], incoming: AttributionEntry[]): AttributionEntry[] {
  const byAsset = new Map<string, AttributionEntry>();
  for (const e of existing) byAsset.set(e.assetId, { ...e, nodeIds: [...e.nodeIds] });
  for (const e of incoming) {
    const prev = byAsset.get(e.assetId);
    if (prev) {
      for (const id of e.nodeIds) if (!prev.nodeIds.includes(id)) prev.nodeIds.push(id);
    } else {
      byAsset.set(e.assetId, { ...e, nodeIds: [...e.nodeIds] });
    }
  }
  return [...byAsset.values()].sort((a, b) => a.assetId.localeCompare(b.assetId));
}
