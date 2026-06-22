// Workspace lifecycle invariants. A personal
// workspace is auto-provisioned per user and can never be deleted while the
// account exists; a workspace must always retain at least one owner.

import { ROLE_RANK } from "./roles";
import type { Membership, User, Workspace, WorkspaceRole } from "./types";

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "workspace";
}

/** The personal workspace auto-provisioned on first sign-in (FR-2). */
export function personalWorkspaceFor(user: User, id: string, now: string): Workspace {
  return {
    id,
    kind: "personal",
    name: `${user.name || "My"} Workspace`,
    slug: slugify(`${user.name || user.email}-${id.slice(0, 6)}`),
    ownerId: user.id,
    createdAt: now,
  };
}

/** Personal workspaces can never be deleted while the account exists. */
export function canDeleteWorkspace(ws: Workspace): boolean {
  return ws.kind !== "personal";
}

function owners(memberships: Membership[], workspaceId: string): Membership[] {
  return memberships.filter((m) => m.workspaceId === workspaceId && m.role === "owner" && m.status === "active");
}

/** A workspace must always keep at least one active owner. */
export function canRemoveMember(memberships: Membership[], workspaceId: string, targetUserId: string): boolean {
  const target = memberships.find((m) => m.workspaceId === workspaceId && m.userId === targetUserId);
  if (!target) return false;
  if (target.role !== "owner") return true;
  return owners(memberships, workspaceId).length > 1;
}

/** Whether a role change is allowed (never demote the last owner). */
export function canChangeRole(
  memberships: Membership[],
  workspaceId: string,
  targetUserId: string,
  newRole: WorkspaceRole,
): boolean {
  const target = memberships.find((m) => m.workspaceId === workspaceId && m.userId === targetUserId);
  if (!target) return false;
  if (target.role === "owner" && ROLE_RANK[newRole] < ROLE_RANK.owner) {
    return owners(memberships, workspaceId).length > 1; // can't demote the last owner
  }
  return true;
}
