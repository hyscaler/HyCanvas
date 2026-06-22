// Workspace invitations. Tokens are single-use and expiring;
// accepting an invite for a different email is refused. Accepting an invite to a
// workspace the user already belongs to is idempotent - decided at the
// membership layer; here we only validate the token itself.

import type { Invitation } from "./types";

export type InviteCheck =
  | { ok: true }
  | { ok: false; reason: "used" | "expired" | "email-mismatch" };

function norm(email: string): string {
  return email.trim().toLowerCase();
}

export function isExpired(inv: Invitation, now: number): boolean {
  return Date.parse(inv.expiresAt) <= now;
}

/** Validate an invitation for acceptance at time `now` by `acceptingEmail`. */
export function validateInvitation(inv: Invitation, now: number, acceptingEmail?: string): InviteCheck {
  if (inv.acceptedAt) return { ok: false, reason: "used" };
  if (isExpired(inv, now)) return { ok: false, reason: "expired" };
  if (acceptingEmail !== undefined && norm(acceptingEmail) !== norm(inv.email)) {
    return { ok: false, reason: "email-mismatch" };
  }
  return { ok: true };
}
