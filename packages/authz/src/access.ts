// Per-design access resolution and the capability model (FR-7, FR-8,
// FR-9). This is the security keystone shared by the REST routes and the
// realtime gateway: the single pure place per-design AccessMode and the
// caller's capability set are computed. Pure logic only; grants, links, roles,
// and the approval-lock state are loaded by the backend and passed in.
//
// Resolution rule (FR-7): the effective mode is the HIGHEST of
//   1. the workspace role mapped to a mode (members can edit, viewers can view),
//   2. any explicit per-design grant for the user/email, and
//   3. the mode of a share link the caller entered through,
// then CAPPED by the approval-lock state (FR-11): a locked design downgrades
// every editor to read-only (view or comment, per policy) until reopened.

import { ROLE_RANK } from "./roles";
import type { WorkspaceRole } from "./types";

/** The three sharing access levels. */
export type AccessMode = "view" | "comment" | "edit";

/** A capability is the unit checked at every gate (FR-8); roles and grants
 *  resolve to a capability set so adding one never touches call sites. */
export type Capability =
  | "view"
  | "comment"
  | "edit"
  | "share"
  | "approve"
  | "manage-roles"
  | "manage-brand"
  | "delete";

/** Higher rank = more access. Used to take the highest of competing sources. */
export const MODE_RANK: Record<AccessMode, number> = {
  view: 1,
  comment: 2,
  edit: 3,
};

/** The capabilities an AccessMode implies on its own (no role bonus). A `view`
 *  link grants only view; a `comment` link adds comment; `edit` adds edit. */
const MODE_CAPABILITIES: Record<AccessMode, Capability[]> = {
  view: ["view"],
  comment: ["view", "comment"],
  edit: ["view", "comment", "edit"],
};

/** Built-in workspace roles mapped to their full capability set (FR-8). Owner
 *  and admin can manage roles and delete; members edit and share; viewers only
 *  view and comment. These seed every workspace and are immutable. */
export const BUILTIN_ROLE_CAPABILITIES: Record<WorkspaceRole, Capability[]> = {
  owner: ["view", "comment", "edit", "share", "approve", "manage-roles", "manage-brand", "delete"],
  admin: ["view", "comment", "edit", "share", "approve", "manage-roles", "manage-brand", "delete"],
  member: ["view", "comment", "edit", "share"],
  viewer: ["view", "comment"],
};

/** The base AccessMode a workspace role confers on a design before grants/links
 *  (FR-7). A viewer's floor is view; members and up can edit. */
export const ROLE_BASE_MODE: Record<WorkspaceRole, AccessMode> = {
  owner: "edit",
  admin: "edit",
  member: "edit",
  viewer: "view",
};

/** A named, editable capability set assignable at workspace or design scope
 *  (FR-8). Built-in roles are modeled by BUILTIN_ROLE_CAPABILITIES; this is the
 *  custom-role shape the backend stores and passes in. */
export interface CustomRole {
  id: string;
  name: string;
  capabilities: Capability[];
}

/** How an approval lock caps access (FR-11). Default policy keeps everyone able
 *  to comment (review continues) but blocks edits; "view" is stricter. */
export type LockPolicy = "comment" | "view";

/** The result of resolving a caller's access to one design. */
export interface DesignAccess {
  mode: AccessMode;
  capabilities: Capability[];
}

/** Inputs to resolveDesignAccess. Any source may be absent (e.g. an anonymous
 *  link visitor has no workspaceRole and no grants). */
export interface ResolveDesignAccessInput {
  /** The caller's workspace role for the design's workspace, if a member. */
  workspaceRole?: WorkspaceRole;
  /** Explicit per-design grant modes for this caller (by user id and/or email,
   *  already filtered to this design by the backend). */
  grants?: AccessMode[];
  /** The mode of a share link the caller entered through (validated already:
   *  not disabled, not expired, password ok), if any. */
  link?: AccessMode;
  /** Extra capabilities from custom roles assigned to the caller (workspace or
   *  design scope), unioned onto the resolved set. */
  customRoles?: CustomRole[];
  /** True when an approval has locked the design (FR-11); caps the mode. */
  approvalLocked?: boolean;
  /** How the lock caps access when locked. Defaults to "comment". */
  lockPolicy?: LockPolicy;
}

/** The higher of two modes. */
function maxMode(a: AccessMode, b: AccessMode): AccessMode {
  return MODE_RANK[a] >= MODE_RANK[b] ? a : b;
}

/** Cap a mode so it never exceeds `ceiling`. */
function capMode(mode: AccessMode, ceiling: AccessMode): AccessMode {
  return MODE_RANK[mode] <= MODE_RANK[ceiling] ? mode : ceiling;
}

/**
 * Resolve a caller's effective per-design access (FR-7). Takes the highest of
 * the workspace-role mode, every explicit grant, and any link mode, then caps
 * it by the approval-lock policy. Returns the resolved mode plus the union of
 * capabilities from the mode, the workspace role, and any custom roles.
 *
 * When NO source grants access (no role, no grant, no link), the caller has no
 * access: capabilities is empty (mode is reported as "view" only as a default
 * label). Callers must gate on `hasCapability(access, "view")`, not on the mode
 * field, to decide whether access exists at all.
 */
export function resolveDesignAccess(input: ResolveDesignAccessInput): DesignAccess {
  const sources: AccessMode[] = [];
  if (input.workspaceRole) sources.push(ROLE_BASE_MODE[input.workspaceRole]);
  if (input.grants) sources.push(...input.grants);
  if (input.link) sources.push(input.link);

  // No source means no access at all (e.g. a stranger with no link/grant).
  const hasAccess = sources.length > 0;
  let mode: AccessMode = hasAccess ? sources.reduce(maxMode) : "view";

  // Approval lock caps the mode for everyone (FR-11). The explicit reopen action
  // is handled by the backend clearing the lock before re-resolving, so here we
  // simply honor the cap.
  if (input.approvalLocked) {
    mode = capMode(mode, input.lockPolicy === "view" ? "view" : "comment");
  }

  const caps = new Set<Capability>();
  if (hasAccess) {
    for (const c of MODE_CAPABILITIES[mode]) caps.add(c);
    if (input.workspaceRole) {
      // A member/admin/owner keeps their management capabilities even when the
      // mode is bounded (e.g. a viewer floor), EXCEPT edit, which the resolved
      // mode governs (an approval lock must remove edit from an admin too).
      for (const c of BUILTIN_ROLE_CAPABILITIES[input.workspaceRole]) {
        if (c === "edit" && !MODE_CAPABILITIES[mode].includes("edit")) continue;
        caps.add(c);
      }
    }
    if (input.customRoles) {
      for (const r of input.customRoles)
        for (const c of r.capabilities) {
          if (c === "edit" && !MODE_CAPABILITIES[mode].includes("edit")) continue;
          caps.add(c);
        }
    }
  }

  return { mode, capabilities: [...caps] };
}

/** True when the resolved access includes a capability. The single gate the
 *  backend capability checks call (FR-8). */
export function hasCapability(access: DesignAccess, cap: Capability): boolean {
  return access.capabilities.includes(cap);
}

/** Whether a mode permits applying document updates over the realtime gateway
 *  (FR-9): only `edit`. Comment/view connect as viewers. */
export function modeCanEdit(mode: AccessMode): boolean {
  return mode === "edit";
}

/** True when `role` is one of the four built-in workspace roles. */
export function isBuiltinRole(name: string): name is WorkspaceRole {
  return name in ROLE_RANK;
}
