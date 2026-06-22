// Caption composition and per-platform validation (FR-3). Pure string helpers.

import type { SocialPlatform } from "./types";

/** Max caption length (characters) per platform. */
export const PLATFORM_LIMITS: Record<SocialPlatform, number> = {
  instagram: 2200,
  x: 280,
  linkedin: 3000,
  facebook: 63206,
  tiktok: 2200,
  pinterest: 500,
  youtube: 5000,
};

/**
 * Max number of hashtags per platform where the platform enforces or strongly
 * recommends a cap. Platforms without a meaningful cap are omitted (undefined).
 */
export const PLATFORM_MAX_HASHTAGS: Partial<Record<SocialPlatform, number>> = {
  instagram: 30,
  tiktok: 30,
  youtube: 15,
  pinterest: 20,
  // x and linkedin have no hard hashtag cap; facebook has no meaningful cap.
};

const HASHTAG_RE = /#([\p{L}\p{N}_]+)/gu;

/**
 * Extract hashtag tokens from free text, in first-seen order, WITHOUT the
 * leading '#'. Duplicates are preserved here (use normalizeHashtags to dedupe).
 */
export function extractHashtags(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(HASHTAG_RE)) {
    out.push(m[1]);
  }
  return out;
}

/**
 * Normalize a list of tags: strip a leading '#', drop empties, and dedupe
 * case-insensitively while preserving the FIRST-seen casing of each tag.
 */
export function normalizeHashtags(tags: readonly string[]): string[] {
  const seen = new Map<string, string>(); // lower -> first-seen original
  for (const raw of tags) {
    const t = raw.replace(/^#+/, "").trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (!seen.has(key)) seen.set(key, t);
  }
  return [...seen.values()];
}

/**
 * Compose a final caption string: body, then a blank line and the
 * space-separated '#'-prefixed hashtags, then (optionally) a first comment
 * appended after a separator. firstComment is included in the returned string
 * for length estimation but real platforms post it separately; callers that
 * post it natively can pass it through PublishTargetSelection instead.
 */
export function composeCaption(
  body: string,
  hashtags: readonly string[] = [],
  firstComment?: string,
): string {
  const tags = normalizeHashtags(hashtags).map((t) => `#${t}`);
  let out = body.trim();
  if (tags.length > 0) {
    out = out ? `${out}\n\n${tags.join(" ")}` : tags.join(" ");
  }
  if (firstComment && firstComment.trim()) {
    out = out ? `${out}\n\n${firstComment.trim()}` : firstComment.trim();
  }
  return out;
}

export interface CaptionValidation {
  ok: boolean;
  limit: number;
  length: number;
  errors: string[];
}

/**
 * Validate a composed caption for a platform: character limit and (where known)
 * hashtag count. Returns a structured result rather than throwing.
 */
export function validateCaption(
  platform: SocialPlatform,
  caption: string,
): CaptionValidation {
  const limit = PLATFORM_LIMITS[platform];
  const length = [...caption].length; // count code points, not UTF-16 units
  const errors: string[] = [];

  if (length > limit) {
    errors.push(`caption is ${length} characters; ${platform} limit is ${limit}`);
  }

  const maxTags = PLATFORM_MAX_HASHTAGS[platform];
  if (maxTags != null) {
    const count = extractHashtags(caption).length;
    if (count > maxTags) {
      errors.push(`caption has ${count} hashtags; ${platform} allows at most ${maxTags}`);
    }
  }

  return { ok: errors.length === 0, limit, length, errors };
}
