// Perceptual-similarity ranking: given a target perceptual hash,
// rank a set of assets by visual closeness (Hamming distance of their average
// hashes). Pure and model-free, this is the "find similar / more like this"
// retrieval over already-computed phashes (the embedding/pgvector path is a
// separate, heavier option). Lower distance = more similar.

import { hammingDistance } from "./phash";

export interface Hashed {
  hash: string;
}

export interface SimilarityHit<T> {
  item: T;
  distance: number;
}

export interface SimilarityOptions {
  /** Drop results whose distance exceeds this threshold (default: keep all). */
  maxDistance?: number;
  /** Cap the number of results returned (default: all). */
  limit?: number;
  /** Exclude an exact-match item (e.g. the query asset itself). */
  excludeExact?: boolean;
}

/** Rank `items` by similarity to `targetHash`, nearest first. Items with an
 *  unequal-length or empty hash are skipped (incomparable). Stable for ties. */
export function rankSimilar<T extends Hashed>(
  targetHash: string,
  items: T[],
  opts: SimilarityOptions = {},
): SimilarityHit<T>[] {
  const hits: SimilarityHit<T>[] = [];
  for (const item of items) {
    if (!item.hash || item.hash.length !== targetHash.length) continue;
    const distance = hammingDistance(targetHash, item.hash);
    if (opts.excludeExact && distance === 0) continue;
    if (opts.maxDistance !== undefined && distance > opts.maxDistance) continue;
    hits.push({ item, distance });
  }
  hits.sort((a, b) => a.distance - b.distance);
  return opts.limit !== undefined ? hits.slice(0, opts.limit) : hits;
}
