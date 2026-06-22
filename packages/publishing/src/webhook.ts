// Outbound webhook signing/verification (FR-16). Uses node:crypto's HMAC-SHA256,
// which is deterministic and dependency-free. The signature covers the request
// timestamp and the raw body so replay/tamper can be detected by subscribers.

import { createHmac, timingSafeEqual } from "node:crypto";

/** Lifecycle event names delivered to webhook subscribers. */
export const WEBHOOK_EVENTS = {
  postPublished: "post.published",
  postFailed: "post.failed",
  postScheduled: "post.scheduled",
  insightsUpdated: "insights.updated",
} as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[keyof typeof WEBHOOK_EVENTS];

/**
 * Compute the hex HMAC-SHA256 signature over `${timestamp}.${bodyString}` using
 * the per-webhook secret. The timestamp binds the signature to a moment so a
 * captured payload cannot be replayed indefinitely (subscribers reject old
 * timestamps).
 */
export function signPayload(secret: string, bodyString: string, timestamp: number | string): string {
  const signed = `${timestamp}.${bodyString}`;
  return createHmac("sha256", secret).update(signed).digest("hex");
}

/**
 * Constant-time verification of a signature produced by signPayload. Returns
 * false (never throws) on any mismatch, including malformed/length-mismatched
 * signatures.
 */
export function verifySignature(
  secret: string,
  bodyString: string,
  timestamp: number | string,
  signature: string,
): boolean {
  const expected = signPayload(secret, bodyString, timestamp);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
