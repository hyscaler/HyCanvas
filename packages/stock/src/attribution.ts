// Attribution compilation. Credits are always derived from
// the design's node provenance, never stored stale: removing the last node that
// used an attribution-required asset drops its entry; re-adding restores it.

import { childrenOf, type DesignFile, type Node } from "@hc/schema";
import { provenanceKey, type AttributionEntry, type NodeProvenance } from "./types";

type AnyRec = Record<string, unknown>;

function visit(node: Node, fn: (n: Node) => void): void {
  fn(node);
  for (const c of childrenOf(node)) visit(c, fn);
  const rec = node as unknown as AnyRec;
  if (node.type === "mask" && rec.child) visit(rec.child as Node, fn);
  if (node.type === "boolean" && Array.isArray(rec.operands)) {
    for (const op of rec.operands as Node[]) visit(op, fn);
  }
}

/** Read provenance stamped on a node (by {@link withProvenance}), if any. */
export function nodeProvenance(node: Node): NodeProvenance | undefined {
  const data = (node as unknown as AnyRec).data as AnyRec | undefined;
  return data?.[provenanceKey] as NodeProvenance | undefined;
}

/**
 * Compile the required attribution credits for a design (FR-14). Groups by
 * source asset, lists the contributing node ids, and includes only
 * attribution-required stock provenance. Deterministically ordered by assetId.
 */
export function compileAttribution(file: DesignFile): AttributionEntry[] {
  const byAsset = new Map<string, AttributionEntry>();
  for (const page of file.pages) {
    for (const root of page.children) {
      visit(root, (node) => {
        const prov = nodeProvenance(node);
        if (!prov || prov.origin !== "stock" || !prov.stockAssetId) return;
        const lic = prov.license;
        if (!lic?.attributionRequired) return;
        const key = prov.stockAssetId;
        const existing = byAsset.get(key);
        if (existing) {
          if (!existing.nodeIds.includes(node.id)) existing.nodeIds.push(node.id);
        } else {
          byAsset.set(key, {
            assetId: key,
            source: "stock",
            attributionText: lic.attributionText ?? `Asset ${key}`,
            attributionUrl: lic.attributionUrl,
            nodeIds: [node.id],
          });
        }
      });
    }
  }
  return [...byAsset.values()].sort((a, b) => a.assetId.localeCompare(b.assetId));
}

/** Render compiled credits as plain text lines (for copy or export metadata). */
export function attributionText(entries: AttributionEntry[]): string {
  return entries.map((e) => (e.attributionUrl ? `${e.attributionText} (${e.attributionUrl})` : e.attributionText)).join("\n");
}
