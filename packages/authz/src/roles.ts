// Workspace roles and isolation. This is the
// security keystone: every API route and the realtime gateway call assertMember
// before touching workspace-scoped data, so there is no code path that reads or
// writes across a workspace the user does not belong to.

import type { Membership, WorkspaceRole } from "./types";

/** Higher rank = more authority. */
export const roleRank: Record<WorkspaceRole, number> = {
  viewer: 1,
  member: 2,
  admin: 3,
  owner: 4,
};

export class AuthzError extends Error {
  constructor(
    public code: "not-a-member" | "insufficient-role" | "not-active",
    message: string,
  ) {
    super(message);
    this.name = "AuthzError";
  }
}

/** True when `role` meets or exceeds `min`. */
export function roleAtLeast(role: WorkspaceRole, min: WorkspaceRole): boolean {
  return roleRank[role] >= roleRank[min];
}

/** The user's active membership in a workspace, or undefined. */
export function membershipOf(
  memberships: Membership[],
  userId: string,
  workspaceId: string,
): Membership | undefined {
  return memberships.find((m) => m.userId === userId && m.workspaceId === workspaceId);
}

/**
 * Assert the user is an active member of the workspace with at least `minRole`,
 * returning the membership for downstream per-design checks. Throws
 * AuthzError otherwise. `minRole` defaults to viewer (any active member).
 */
export function assertMember(
  memberships: Membership[],
  userId: string,
  workspaceId: string,
  minRole: WorkspaceRole = "viewer",
): Membership {
  const m = membershipOf(memberships, userId, workspaceId);
  if (!m) throw new AuthzError("not-a-member", `user ${userId} is not a member of workspace ${workspaceId}`);
  if (m.status !== "active") throw new AuthzError("not-active", `membership is ${m.status}`);
  if (!roleAtLeast(m.role, minRole)) {
    throw new AuthzError("insufficient-role", `role ${m.role} is below required ${minRole}`);
  }
  return m;
}

/** Non-throwing membership/role check. */
export function canAccess(
  memberships: Membership[],
  userId: string,
  workspaceId: string,
  minRole: WorkspaceRole = "viewer",
): boolean {
  const m = membershipOf(memberships, userId, workspaceId);
  return !!m && m.status === "active" && roleAtLeast(m.role, minRole);
}

/** The set of workspace ids a user may access (active memberships only). */
export function accessibleWorkspaceIds(memberships: Membership[], userId: string): string[] {
  return memberships
    .filter((m) => m.userId === userId && m.status === "active")
    .map((m) => m.workspaceId);
}

/**
 * Filter a list of workspace-scoped rows to those in workspaces the user may
 * access (FR-16). The single choke point used by query helpers so no
 * cross-workspace read can leak.
 */
export function scopeToMemberships<T extends { workspaceId: string }>(
  rows: T[],
  memberships: Membership[],
  userId: string,
): T[] {
  const allowed = new Set(accessibleWorkspaceIds(memberships, userId));
  return rows.filter((r) => allowed.has(r.workspaceId));
}
