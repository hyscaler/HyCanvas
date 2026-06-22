import { describe, it, expect } from "vitest";
import {
  resolveDesignAccess,
  hasCapability,
  modeCanEdit,
  isBuiltinRole,
  BUILTIN_ROLE_CAPABILITIES,
  type CustomRole,
} from "../access";

describe("resolveDesignAccess precedence", () => {
  it("maps workspace roles to a base mode (members edit, viewers view)", () => {
    expect(resolveDesignAccess({ workspaceRole: "owner" }).mode).toBe("edit");
    expect(resolveDesignAccess({ workspaceRole: "admin" }).mode).toBe("edit");
    expect(resolveDesignAccess({ workspaceRole: "member" }).mode).toBe("edit");
    expect(resolveDesignAccess({ workspaceRole: "viewer" }).mode).toBe("view");
  });

  it("takes the highest of role, grant, and link (highest-wins)", () => {
    // A viewer (view) entering a comment grant rises to comment.
    expect(resolveDesignAccess({ workspaceRole: "viewer", grants: ["comment"] }).mode).toBe("comment");
    // A viewer with an edit grant rises to edit.
    expect(resolveDesignAccess({ workspaceRole: "viewer", grants: ["edit"] }).mode).toBe("edit");
    // Multiple grants take the max.
    expect(resolveDesignAccess({ grants: ["view", "edit", "comment"] }).mode).toBe("edit");
    // A higher role is never lowered by a weaker link.
    expect(resolveDesignAccess({ workspaceRole: "member", link: "view" }).mode).toBe("edit");
  });

  it("lets a link elevate a non-member (no role, no grant)", () => {
    const a = resolveDesignAccess({ link: "comment" });
    expect(a.mode).toBe("comment");
    expect(hasCapability(a, "view")).toBe(true);
    expect(hasCapability(a, "comment")).toBe(true);
    expect(hasCapability(a, "edit")).toBe(false);

    const e = resolveDesignAccess({ link: "edit" });
    expect(e.mode).toBe("edit");
    expect(hasCapability(e, "edit")).toBe(true);
  });

  it("grants no access when no source provides any (stranger, no link)", () => {
    const none = resolveDesignAccess({});
    expect(none.capabilities).toEqual([]);
    expect(hasCapability(none, "view")).toBe(false);
  });

  it("keeps a viewer floor: a viewer with no elevation stays at view", () => {
    const a = resolveDesignAccess({ workspaceRole: "viewer" });
    expect(a.mode).toBe("view");
    expect(hasCapability(a, "edit")).toBe(false);
    expect(hasCapability(a, "comment")).toBe(true);
  });
});

describe("approval-lock capping", () => {
  it("caps an editing member at comment by default policy", () => {
    const a = resolveDesignAccess({ workspaceRole: "member", approvalLocked: true });
    expect(a.mode).toBe("comment");
    expect(hasCapability(a, "edit")).toBe(false);
    expect(hasCapability(a, "comment")).toBe(true);
  });

  it("caps at view under the strict view policy", () => {
    const a = resolveDesignAccess({ workspaceRole: "owner", approvalLocked: true, lockPolicy: "view" });
    expect(a.mode).toBe("view");
    expect(hasCapability(a, "edit")).toBe(false);
  });

  it("caps an edit link too, and strips edit even from an admin/owner", () => {
    const link = resolveDesignAccess({ link: "edit", approvalLocked: true });
    expect(link.mode).toBe("comment");
    const owner = resolveDesignAccess({ workspaceRole: "owner", approvalLocked: true });
    expect(hasCapability(owner, "edit")).toBe(false);
    // Management capabilities survive the lock; only edit is removed.
    expect(hasCapability(owner, "manage-roles")).toBe(true);
    expect(hasCapability(owner, "approve")).toBe(true);
  });

  it("does not raise a viewer above their floor under a lock", () => {
    const a = resolveDesignAccess({ workspaceRole: "viewer", approvalLocked: true });
    expect(a.mode).toBe("view");
  });
});

describe("capability sets", () => {
  it("derives built-in role capabilities for share/manage/delete gates", () => {
    const owner = resolveDesignAccess({ workspaceRole: "owner" });
    expect(hasCapability(owner, "share")).toBe(true);
    expect(hasCapability(owner, "manage-roles")).toBe(true);
    expect(hasCapability(owner, "delete")).toBe(true);

    const member = resolveDesignAccess({ workspaceRole: "member" });
    expect(hasCapability(member, "share")).toBe(true);
    expect(hasCapability(member, "manage-roles")).toBe(false);
    expect(hasCapability(member, "delete")).toBe(false);

    const viewer = resolveDesignAccess({ workspaceRole: "viewer" });
    expect(hasCapability(viewer, "share")).toBe(false);
    expect(hasCapability(viewer, "edit")).toBe(false);
  });

  it("unions custom-role capabilities onto the resolved set", () => {
    // A reviewer role: comment + approve, no edit. Assigned to a viewer.
    const reviewer: CustomRole = { id: "r1", name: "Reviewer", capabilities: ["comment", "approve"] };
    const a = resolveDesignAccess({ workspaceRole: "viewer", customRoles: [reviewer] });
    expect(hasCapability(a, "approve")).toBe(true);
    expect(hasCapability(a, "comment")).toBe(true);
    expect(hasCapability(a, "edit")).toBe(false);
    // The link/grant mode still does not become edit just because the role lists it.
    const b = resolveDesignAccess({ link: "view", customRoles: [{ id: "r2", name: "X", capabilities: ["edit"] }] });
    expect(b.mode).toBe("view");
    expect(hasCapability(b, "edit")).toBe(false);
  });

  it("exposes the built-in capability table", () => {
    expect(BUILTIN_ROLE_CAPABILITIES.viewer).not.toContain("edit");
    expect(BUILTIN_ROLE_CAPABILITIES.admin).toContain("manage-roles");
  });
});

describe("manage-brand capability", () => {
  it("grants manage-brand to owner and admin, not member/viewer", () => {
    expect(hasCapability(resolveDesignAccess({ workspaceRole: "owner" }), "manage-brand")).toBe(true);
    expect(hasCapability(resolveDesignAccess({ workspaceRole: "admin" }), "manage-brand")).toBe(true);
    expect(hasCapability(resolveDesignAccess({ workspaceRole: "member" }), "manage-brand")).toBe(false);
    expect(hasCapability(resolveDesignAccess({ workspaceRole: "viewer" }), "manage-brand")).toBe(false);
  });

  it("appears in the built-in capability table for owner/admin only", () => {
    expect(BUILTIN_ROLE_CAPABILITIES.owner).toContain("manage-brand");
    expect(BUILTIN_ROLE_CAPABILITIES.admin).toContain("manage-brand");
    expect(BUILTIN_ROLE_CAPABILITIES.member).not.toContain("manage-brand");
    expect(BUILTIN_ROLE_CAPABILITIES.viewer).not.toContain("manage-brand");
  });

  it("can be granted to a member via a custom role", () => {
    const brandManager: CustomRole = { id: "rb", name: "Brand Manager", capabilities: ["manage-brand"] };
    const a = resolveDesignAccess({ workspaceRole: "member", customRoles: [brandManager] });
    expect(hasCapability(a, "manage-brand")).toBe(true);
    expect(hasCapability(a, "edit")).toBe(true);
  });

  it("survives an approval lock like other management capabilities (not edit)", () => {
    const a = resolveDesignAccess({ workspaceRole: "admin", approvalLocked: true });
    expect(hasCapability(a, "manage-brand")).toBe(true);
    expect(hasCapability(a, "edit")).toBe(false);
  });
});

describe("gateway + helper utilities", () => {
  it("modeCanEdit is true only for edit", () => {
    expect(modeCanEdit("edit")).toBe(true);
    expect(modeCanEdit("comment")).toBe(false);
    expect(modeCanEdit("view")).toBe(false);
  });

  it("identifies built-in roles", () => {
    expect(isBuiltinRole("owner")).toBe(true);
    expect(isBuiltinRole("reviewer")).toBe(false);
  });
});
