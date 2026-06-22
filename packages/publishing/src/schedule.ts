// Scheduling time-math and the post lifecycle state machine (FR-7/FR-8/FR-9).
// Pure: no clock access. All "now" values arrive as explicit parameters so the
// scheduler/worker and tests are fully deterministic.

import type { PostStatus } from "./types";

/** Lifecycle events that drive a post between statuses. */
export type PostEvent =
  | "schedule" // draft -> scheduled
  | "publishStart" // scheduled -> publishing (worker picks it up)
  | "publishOk" // publishing -> published
  | "publishFail" // publishing -> failed
  | "cancel" // draft|scheduled -> canceled
  | "requeue"; // failed -> scheduled (user fixed and re-queued)

/**
 * A post is editable until publishing actually starts. Drafts and scheduled
 * posts can be edited; once publishing/published/failed/canceled it is not.
 * Failed posts are re-queued (which returns them to scheduled) before editing.
 */
export function canEdit(status: PostStatus): boolean {
  return status === "draft" || status === "scheduled";
}

/** A post can be canceled until publishing starts. */
export function canCancel(status: PostStatus): boolean {
  return status === "draft" || status === "scheduled";
}

// Legal transitions: status -> event -> next status.
const TRANSITIONS: Record<PostStatus, Partial<Record<PostEvent, PostStatus>>> = {
  draft: {
    schedule: "scheduled",
    cancel: "canceled",
  },
  scheduled: {
    publishStart: "publishing",
    cancel: "canceled",
    // re-scheduling a scheduled post is a no-op transition on status:
    schedule: "scheduled",
  },
  publishing: {
    publishOk: "published",
    publishFail: "failed",
  },
  published: {},
  failed: {
    requeue: "scheduled",
  },
  canceled: {},
};

/**
 * Advance the state machine. Throws on an illegal transition so callers cannot
 * silently corrupt a post's lifecycle.
 */
export function nextTransition(status: PostStatus, event: PostEvent): PostStatus {
  const next = TRANSITIONS[status]?.[event];
  if (!next) {
    throw new Error(`illegal transition: cannot ${event} a ${status} post`);
  }
  return next;
}

/**
 * Resolve the absolute epoch-ms instant a post is due, from an ISO local
 * wall-clock time and the target timezone's UTC offset in minutes.
 *
 * Offset-based by design (no tz database): the caller resolves the IANA tz to
 * an offset for the relevant instant (handling DST) and passes it here. A
 * positive offset means ahead of UTC (e.g. UTC+5:30 => 330).
 *
 * The ISO string is interpreted as a *local* wall-clock time. Any trailing
 * "Z" or explicit offset in the string is ignored in favor of the supplied
 * offset, so "9:00 local" stays anchored to the supplied offset.
 */
export function dueAt(scheduledAtIso: string, timezoneOffsetMinutes: number): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?/.exec(
    scheduledAtIso,
  );
  if (!m) {
    throw new Error(`dueAt: unparseable ISO local time: ${scheduledAtIso}`);
  }
  const [, y, mo, d, h, mi, s, ms] = m;
  // Treat the wall-clock fields as if they were UTC, then subtract the offset
  // to get the true UTC instant.
  const asUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    s ? Number(s) : 0,
    ms ? Number(ms.padEnd(3, "0")) : 0,
  );
  return asUtc - timezoneOffsetMinutes * 60_000;
}

/** A minimal due-able shape: a resolved epoch-ms due time. */
export interface DueablePost {
  dueMs?: number;
  status: PostStatus;
}

/**
 * Is this post due to fire at `nowMs`? Only scheduled posts with a due time at
 * or before now are due.
 */
export function isDue(post: DueablePost, nowMs: number): boolean {
  return post.status === "scheduled" && post.dueMs != null && post.dueMs <= nowMs;
}

export interface BackoffOptions {
  baseMs?: number; // first-attempt delay (default 1000)
  factor?: number; // exponential factor (default 2)
  maxMs?: number; // cap (default 5 minutes)
  jitter?: number; // 0..1 deterministic multiplier supplied by caller
}

/**
 * Exponential backoff delay for retry `attempt` (0-based: attempt 0 is the
 * first retry). Capped at maxMs. Jitter is a caller-supplied 0..1 multiplier
 * (NOT random here, so the function stays deterministic): the computed delay is
 * scaled down by up to that fraction, giving a result in
 * `[capped * (1 - jitter), capped]`. jitter=0 returns the full delay; jitter=1
 * returns 0. The result never exceeds the cap.
 */
export function backoffDelayMs(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 1000;
  const factor = opts.factor ?? 2;
  const max = opts.maxMs ?? 5 * 60_000;
  const a = Math.max(0, Math.floor(attempt));
  const raw = base * Math.pow(factor, a);
  const capped = Math.min(raw, max);
  if (opts.jitter == null) return capped;
  const j = Math.min(1, Math.max(0, opts.jitter));
  return Math.round(capped * (1 - j));
}
