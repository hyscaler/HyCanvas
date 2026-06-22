// Published-post insights aggregation (FR-14). Pure summation; the platform
// fetch/upsert layer is the backend's responsibility.

import type { PostInsights, SocialPlatform } from "./types";

export interface InsightTotals {
  impressions: number;
  reach: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  clicks: number;
}

export interface AggregatedInsights {
  totals: InsightTotals;
  perPlatform: Record<string, InsightTotals>; // keyed by SocialPlatform
  perDesign: Record<string, InsightTotals>; // keyed by postId-derived design grouping
}

const METRIC_KEYS = [
  "impressions",
  "reach",
  "likes",
  "comments",
  "shares",
  "saves",
  "clicks",
] as const;

function zero(): InsightTotals {
  return { impressions: 0, reach: 0, likes: 0, comments: 0, shares: 0, saves: 0, clicks: 0 };
}

function addInto(acc: InsightTotals, row: PostInsights): void {
  for (const k of METRIC_KEYS) {
    acc[k] += row[k] ?? 0;
  }
}

/**
 * A row optionally carries a designId so insights can roll up per design. If
 * absent, the row's postId is used as the design grouping key.
 */
export interface InsightRow extends PostInsights {
  designId?: string;
}

/**
 * Aggregate insight rows into overall totals, per-platform totals, and
 * per-design totals. Missing metrics count as zero.
 */
export function aggregateInsights(rows: readonly InsightRow[]): AggregatedInsights {
  const totals = zero();
  const perPlatform: Record<string, InsightTotals> = {};
  const perDesign: Record<string, InsightTotals> = {};

  for (const row of rows) {
    addInto(totals, row);

    const p: SocialPlatform = row.platform;
    (perPlatform[p] ??= zero());
    addInto(perPlatform[p], row);

    const designKey = row.designId ?? row.postId;
    (perDesign[designKey] ??= zero());
    addInto(perDesign[designKey], row);
  }

  return { totals, perPlatform, perDesign };
}

/**
 * Engagement rate for a single row: (likes + comments + shares + saves) divided
 * by reach (falling back to impressions if reach is absent). Returns 0 when
 * there is no denominator.
 */
export function engagementRate(row: PostInsights): number {
  const engagements =
    (row.likes ?? 0) + (row.comments ?? 0) + (row.shares ?? 0) + (row.saves ?? 0);
  const denom = row.reach ?? row.impressions ?? 0;
  if (denom <= 0) return 0;
  return engagements / denom;
}
