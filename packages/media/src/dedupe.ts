// Duplicate classification at ingest. Exact match on the
// sha-256 checksum; near match on perceptual-hash Hamming distance. The result
// drives the user's resolution choices ("use existing" / "keep both" /
// "replace as new version").

import { hammingDistance, nearDuplicateMaxDistance } from "./phash";
import type { Asset } from "./types";

export type DuplicateKind = "exact" | "near" | "none";

export type DuplicateAction = "use-existing" | "keep-both" | "replace-version";

export interface DuplicateResult {
  kind: DuplicateKind;
  match?: Asset;
  distance?: number; // perceptual distance for a near match
  /** Resolution choices to offer the user (FR-7). */
  actions: DuplicateAction[];
}

export interface IncomingFingerprint {
  checksum: string;
  perceptualHash?: string;
}

/**
 * Classify an incoming upload against existing library assets. Exact-dupe takes
 * precedence; otherwise the closest perceptual match within threshold is a
 * near-dupe. Trashed assets are ignored as match candidates.
 */
export function classifyDuplicate(
  incoming: IncomingFingerprint,
  candidates: Asset[],
  maxDistance = nearDuplicateMaxDistance,
): DuplicateResult {
  const live = candidates.filter((c) => c.status !== "trashed");

  const exact = live.find((c) => c.checksum === incoming.checksum);
  if (exact) {
    return { kind: "exact", match: exact, distance: 0, actions: ["use-existing", "keep-both"] };
  }

  if (incoming.perceptualHash) {
    let best: Asset | undefined;
    let bestDist = Infinity;
    for (const c of live) {
      if (!c.perceptualHash || c.perceptualHash.length !== incoming.perceptualHash.length) continue;
      const d = hammingDistance(incoming.perceptualHash, c.perceptualHash);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    if (best && bestDist <= maxDistance) {
      return { kind: "near", match: best, distance: bestDist, actions: ["use-existing", "keep-both", "replace-version"] };
    }
  }

  return { kind: "none", actions: ["keep-both"] };
}
