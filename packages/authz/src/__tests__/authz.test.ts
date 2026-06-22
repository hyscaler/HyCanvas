import { describe, it, expect } from "vitest";
import {
  accessibleWorkspaceIds,
  assertMember,
  AuthzError,
  canAccess,
  canChangeRole,
  canDeleteWorkspace,
  canRemoveMember,
  personalWorkspaceFor,
  resolveIdentity,
  roleAtLeast,
  rotateRefresh,
  scopeToMemberships,
  searchHome,
  startSession,
  validateInvitation,
  type AuthIdentity,
  type HomeItem,
  type Invitation,
  type Membership,
  type User,
  type Workspace,
} from "../index";

function mem(userId: string, workspaceId: string, role: Membership["role"], status: Membership["status"] = "active"): Membership {
  return { id: `${userId}-${workspaceId}`, userId, workspaceId, role, status };
}

describe("roles + isolation (FR-11, FR-16, AC-8)", () => {
  const memberships = [mem("u1", "wa", "admin"), mem("u1", "wb", "viewer"), mem("u2", "wa", "owner")];

  it("ranks roles and enforces minimums", () => {
    expect(roleAtLeast("admin", "member")).toBe(true);
    expect(roleAtLeast("viewer", "admin")).toBe(false);
    expect(assertMember(memberships, "u1", "wa", "member").role).toBe("admin");
    expect(() => assertMember(memberships, "u1", "wb", "admin")).toThrow(AuthzError);
    expect(() => assertMember(memberships, "u1", "wc")).toThrow(/not a member/);
  });

  it("rejects non-active memberships", () => {
    const m = [mem("u3", "wa", "admin", "invited")];
    expect(() => assertMember(m, "u3", "wa")).toThrow(/invited/);
    expect(canAccess(m, "u3", "wa")).toBe(false);
  });

  it("lists accessible workspaces and scopes rows so no cross-workspace read leaks", () => {
    expect(accessibleWorkspaceIds(memberships, "u1").sort()).toEqual(["wa", "wb"]);
    const rows = [{ workspaceId: "wa", id: "d1" }, { workspaceId: "wc", id: "d2" }, { workspaceId: "wb", id: "d3" }];
    expect(scopeToMemberships(rows, memberships, "u1").map((r) => r.id).sort()).toEqual(["d1", "d3"]);
  });
});

describe("identity linking (FR-1, Section 9)", () => {
  const users: User[] = [
    { id: "u1", email: "a@x.com", emailVerified: true, name: "A", locale: "en", theme: "system", prefs: { accessibility: { reduceMotion: false, highContrast: false } }, mfaEnabled: false, createdAt: "t" },
  ];
  const identities: AuthIdentity[] = [{ id: "i1", userId: "u1", provider: "password", providerSubject: "a@x.com" }];

  it("logs in on an exact identity match", () => {
    expect(resolveIdentity(identities, users, { provider: "password", providerSubject: "a@x.com", email: "a@x.com", emailVerified: true }))
      .toMatchObject({ action: "login", userId: "u1" });
  });

  it("links a new provider when both emails are verified", () => {
    expect(resolveIdentity(identities, users, { provider: "google", providerSubject: "g-1", email: "A@x.com", emailVerified: true }))
      .toEqual({ action: "link", userId: "u1" });
  });

  it("requires verification on an unverified collision, and creates for a new email", () => {
    expect(resolveIdentity(identities, users, { provider: "google", providerSubject: "g-2", email: "a@x.com", emailVerified: false }))
      .toEqual({ action: "verify-required", userId: "u1" });
    expect(resolveIdentity(identities, users, { provider: "google", providerSubject: "g-3", email: "new@x.com", emailVerified: true }))
      .toEqual({ action: "create" });
  });
});

describe("session rotation + reuse detection (FR-4, Section 9)", () => {
  it("rotates on the current token and rejects a revoked family", () => {
    let s = startSession("fam", "t0", 1000);
    const r = rotateRefresh(s, "t0", "t1", 2000);
    expect(r.action).toBe("rotate");
    s = r.state;
    expect(s.currentTokenId).toBe("t1");
    expect(s.previousTokenId).toBe("t0");
  });

  it("tolerates the previous token within grace (multi-tab) but revokes after", () => {
    const s = startSession("fam", "t0", 1000);
    const rotated = rotateRefresh(s, "t0", "t1", 2000).state;
    expect(rotateRefresh(rotated, "t0", "t2", 2000 + 5_000).action).toBe("tolerate");
    const revoked = rotateRefresh(rotated, "t0", "t2", 2000 + 60_000);
    expect(revoked.action).toBe("revoke-family");
    expect(revoked.state.revoked).toBe(true);
  });

  it("revokes the family on an unknown (replayed) token", () => {
    const s = startSession("fam", "t0", 1000);
    expect(rotateRefresh(s, "stolen", "t1", 1500).action).toBe("revoke-family");
    const dead = { ...s, revoked: true };
    expect(rotateRefresh(dead, "t0", "t1", 1500).action).toBe("reject");
  });
});

describe("invitations (Section 9)", () => {
  const base: Invitation = { id: "inv", workspaceId: "w", email: "b@x.com", role: "member", invitedBy: "u1", expiresAt: "2026-12-31T00:00:00Z" };

  it("accepts a valid invite and rejects expired/used/mismatched", () => {
    const now = Date.parse("2026-06-01T00:00:00Z");
    expect(validateInvitation(base, now, "b@x.com")).toEqual({ ok: true });
    expect(validateInvitation(base, Date.parse("2027-01-01T00:00:00Z"))).toEqual({ ok: false, reason: "expired" });
    expect(validateInvitation({ ...base, acceptedAt: "2026-05-01T00:00:00Z" }, now)).toEqual({ ok: false, reason: "used" });
    expect(validateInvitation(base, now, "other@x.com")).toEqual({ ok: false, reason: "email-mismatch" });
  });
});

describe("workspace invariants (FR-2, FR-11, Section 9)", () => {
  const user: User = { id: "u1", email: "a@x.com", emailVerified: true, name: "Ann", locale: "en", theme: "system", prefs: { accessibility: { reduceMotion: false, highContrast: false } }, mfaEnabled: false, createdAt: "t" };

  it("auto-provisions a personal workspace that cannot be deleted", () => {
    const ws = personalWorkspaceFor(user, "wp-123456", "t");
    expect(ws).toMatchObject({ kind: "personal", ownerId: "u1" });
    expect(ws.slug).toMatch(/^[a-z0-9-]+$/);
    expect(canDeleteWorkspace(ws)).toBe(false);
    expect(canDeleteWorkspace({ ...ws, kind: "team" } as Workspace)).toBe(true);
  });

  it("never removes or demotes the last owner", () => {
    const single = [mem("u1", "w", "owner"), mem("u2", "w", "admin")];
    expect(canRemoveMember(single, "w", "u1")).toBe(false);
    expect(canRemoveMember(single, "w", "u2")).toBe(true);
    expect(canChangeRole(single, "w", "u1", "admin")).toBe(false);
    const twoOwners = [mem("u1", "w", "owner"), mem("u2", "w", "owner")];
    expect(canRemoveMember(twoOwners, "w", "u1")).toBe(true);
    expect(canChangeRole(twoOwners, "w", "u1", "member")).toBe(true);
  });
});

describe("universal search (FR-9, AC-6)", () => {
  const items: HomeItem[] = [
    { kind: "design", id: "d1", title: "Sales Deck", workspaceId: "w", updatedAt: "2026-03-01", starred: false, sharedWithMe: false },
    { kind: "design", id: "d2", title: "Sale Banner", workspaceId: "w", updatedAt: "2026-04-01", starred: true, sharedWithMe: false },
    { kind: "template", id: "t1", title: "Sale Flyer", workspaceId: "pub", updatedAt: "2026-01-01", starred: false, sharedWithMe: false },
    { kind: "project", id: "p1", title: "Marketing", workspaceId: "w", updatedAt: "2026-05-01", starred: false, sharedWithMe: false },
  ];

  it("filters by type facet", () => {
    expect(searchHome(items, { type: "template" }).map((i) => i.id)).toEqual(["t1"]);
    expect(searchHome(items, { type: ["design", "project"] }).map((i) => i.id).sort()).toEqual(["d1", "d2", "p1"]);
  });

  it("ranks by text relevance then recency, empty query sorts starred+recent first", () => {
    const r = searchHome(items, { q: "sale" });
    // d1/d2/t1 all prefix-match "sale" (60); ties break by starred then recency:
    // d2 (starred) > d1 (2026-03) > t1 (2026-01). "Marketing" has no match.
    expect(r.map((i) => i.id)).toEqual(["d2", "d1", "t1"]);
    expect(r).not.toContain(items[3]);
    const browse = searchHome(items, {});
    expect(browse[0].id).toBe("d2"); // starred first
  });
});
