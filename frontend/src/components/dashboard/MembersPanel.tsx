// Workspace member management (team invitations): roster
// with role changes + removal, invite-by-email, and pending invitations with
// resend/revoke. The backend (accounts members) enforces the real authority +
// last-owner invariants; this UI hides clearly-disallowed controls and surfaces
// server errors via toast. Personal workspaces are single-user, so management is
// hidden.

import { useCallback, useEffect, useState } from "react";
import { Trash2, Mail, Clock, Crown, Shield, Plus, ChevronDown, Users, UserPlus, Pencil, AlertTriangle } from "lucide-react";
import type { Capability, CustomRoleView, WorkspaceInvitation, WorkspaceMemberView, WorkspaceRole } from "@hc/sdk";
import { oc } from "@/lib/sdk";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { tr } from "@/lib/i18n";

const ROLE_RANK: Record<WorkspaceRole, number> = { viewer: 1, member: 2, admin: 3, owner: 4 };
const ROLES: WorkspaceRole[] = ["viewer", "member", "admin", "owner"];
const roleLabel = (): Record<WorkspaceRole, string> => ({ viewer: tr("dashboard.viewer"), member: tr("dashboard.member"), admin: tr("dashboard.admin"), owner: tr("dashboard.owner") });

// One-line description of each role, shown under the invite picker so the inviter
// knows what they're granting.
const roleDesc = (): Record<WorkspaceRole, string> => ({
  owner: tr("dashboard.full_access_plus_workspace_settings_and_dele"),
  admin: tr("dashboard.manage_members_content_and_brand_settings"),
  member: tr("dashboard.create_edit_and_share_designs"),
  viewer: tr("dashboard.view_and_comment_only"),
});

// Color-coded role chip styling, by authority.
const ROLE_BADGE: Record<WorkspaceRole, string> = {
  owner: "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200",
  admin: "bg-brand-50 text-brand-ink ring-1 ring-inset ring-brand-200",
  member: "bg-neutral-100 text-neutral-700 ring-1 ring-inset ring-neutral-200",
  viewer: "bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-200",
};

// Capabilities a custom role can grant, with friendly labels.
const capabilities = (): { id: Capability; label: string }[] => [
  { id: "view", label: tr("dashboard.view") },
  { id: "comment", label: tr("dashboard.comment") },
  { id: "edit", label: tr("dashboard.edit") },
  { id: "share", label: tr("dashboard.share") },
  { id: "approve", label: tr("dashboard.approve") },
  { id: "manage-brand", label: tr("dashboard.manage_brand") },
  { id: "manage-roles", label: tr("dashboard.manage_roles") },
  { id: "delete", label: tr("dashboard.delete") },
];

function initials(nameOrEmail: string): string {
  const s = (nameOrEmail || "?").trim();
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}

function relativeExpiry(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return "expired";
  const days = Math.round(ms / 86_400_000);
  if (days >= 1) return `in ${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.round(ms / 3_600_000);
  if (hours >= 1) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  return "soon";
}

// Small section header: an icon, an uppercase label, an optional count, and an
// optional trailing action (e.g. "New role").
function SectionHeader({
  icon: Icon,
  label,
  count,
  action,
}: {
  icon: typeof Users;
  label: string;
  count?: number;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        <Icon size={14} className="text-neutral-400" />
        <span>{label}</span>
        {count !== undefined && (
          <span className="rounded-full bg-neutral-100 px-1.5 py-0.5 text-[11px] font-semibold text-neutral-500">{count}</span>
        )}
      </div>
      {action}
    </div>
  );
}

function RoleBadge({ role }: { role: WorkspaceRole }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${ROLE_BADGE[role]}`}>
      {role === "owner" && <Crown size={12} />}
      {roleLabel()[role]}
    </span>
  );
}

// Styled native <select> for picking a role (accessible, no extra deps). `size`
// "md" matches the invite input; "sm" is the compact inline roster control.
function RoleSelect({
  value,
  roles,
  onChange,
  ariaLabel,
  size = "md",
}: {
  value: WorkspaceRole;
  roles: WorkspaceRole[];
  onChange: (r: WorkspaceRole) => void;
  ariaLabel: string;
  size?: "md" | "sm";
}) {
  const dims =
    size === "md"
      ? "h-11 rounded-xl ps-3.5 pe-9 text-sm font-medium"
      : "h-8 rounded-lg ps-2.5 pe-7 text-xs font-medium";
  const chevron = size === "md" ? "end-3" : "end-2";
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as WorkspaceRole)}
        aria-label={ariaLabel}
        className={`${dims} w-full appearance-none border border-neutral-200 bg-surface text-neutral-700 outline-none transition hover:border-neutral-300 focus:border-brand-500 focus:ring-2 focus:ring-brand-100`}
      >
        {roles.map((r) => (
          <option key={r} value={r}>
            {roleLabel()[r]}
          </option>
        ))}
      </select>
      <ChevronDown size={size === "md" ? 16 : 14} className={`pointer-events-none absolute ${chevron} top-1/2 -translate-y-1/2 text-neutral-400`} />
    </div>
  );
}

function Avatar({ label }: { label: string }) {
  return (
    <span className="oc-gradient grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-bold text-white shadow-sm">
      {initials(label)}
    </span>
  );
}

export function MembersPanel({
  workspaceId,
  workspaceName,
  workspaceKind,
  myRole,
  myUserId,
  onExit,
}: {
  workspaceId: string | null;
  workspaceName: string;
  workspaceKind: string;
  myRole: WorkspaceRole;
  myUserId: string;
  onExit?: () => void; // the caller left or deleted this workspace -> leave the page
}) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [members, setMembers] = useState<WorkspaceMemberView[]>([]);
  const [invites, setInvites] = useState<WorkspaceInvitation[]>([]);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>("member");
  const [busy, setBusy] = useState(false);
  // Delete-workspace confirmation (owner-only, non-personal). The user must type
  // the workspace name to arm the destructive action.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);

  const isPersonal = workspaceKind === "personal";
  const canManage = myRole === "admin" || myRole === "owner";
  const myRank = ROLE_RANK[myRole];

  async function deleteWorkspace() {
    if (!workspaceId || deleteConfirm !== workspaceName) return;
    setDeleting(true);
    try {
      await oc.deleteWorkspace(workspaceId);
      toast.success(`Deleted "${workspaceName}".`);
      onExit?.();
    } catch {
      toast.error(tr("dashboard.could_not_delete_the_workspace"));
    } finally {
      setDeleting(false);
    }
  }

  const reload = useCallback(async () => {
    if (!workspaceId || isPersonal) return;
    try {
      const m = await oc.workspaceMembers(workspaceId);
      setMembers(m);
      if (canManage) {
        setInvites(await oc.workspaceInvitations(workspaceId).catch(() => []));
      }
    } catch {
      toast.error(tr("dashboard.could_not_load_members"));
    }
  }, [workspaceId, isPersonal, canManage, toast]);

  useEffect(() => {
    if (!workspaceId || isPersonal) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const m = await oc.workspaceMembers(workspaceId);
        if (cancelled) return;
        setMembers(m);
        if (canManage) {
          const inv = await oc.workspaceInvitations(workspaceId).catch(() => []);
          if (!cancelled) setInvites(inv);
        }
      } catch {
        if (!cancelled) toast.error(tr("dashboard.could_not_load_members"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, isPersonal, canManage, toast]);

  async function sendInvite(toEmail = email, role = inviteRole, isResend = false) {
    const addr = toEmail.trim();
    if (!workspaceId || !addr) return;
    setBusy(true);
    try {
      await oc.invite(workspaceId, { email: addr, role });
      if (!isResend) setEmail("");
      toast.success(isResend ? `Invitation resent to ${addr}.` : `Invitation sent to ${addr}.`);
      await reload();
    } catch {
      toast.error(tr("dashboard.could_not_send_the_invitation"));
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(m: WorkspaceMemberView, role: WorkspaceRole) {
    if (!workspaceId || role === m.role) return;
    try {
      await oc.changeMemberRole(workspaceId, m.userId, role);
      toast.success(`${m.name || m.email} is now a ${roleLabel()[role].toLowerCase()}.`);
      await reload();
    } catch {
      toast.error(tr("dashboard.could_not_change_the_role"));
    }
  }

  async function removeMember(m: WorkspaceMemberView) {
    if (!workspaceId) return;
    const self = m.userId === myUserId;
    try {
      await oc.removeMember(workspaceId, m.userId);
      toast.success(self ? tr("dashboard.you_left_the_workspace") : `Removed ${m.name || m.email}.`);
      if (self) {
        onExit?.();
        return;
      }
      await reload();
    } catch {
      toast.error(self ? tr("dashboard.could_not_leave_a_workspace_needs_an_owner") : tr("dashboard.could_not_remove_this_member"));
    }
  }

  async function revoke(inv: WorkspaceInvitation) {
    if (!workspaceId) return;
    try {
      await oc.revokeInvitation(workspaceId, inv.id);
      toast.success(tr("dashboard.invitation_revoked"));
      await reload();
    } catch {
      toast.error(tr("dashboard.could_not_revoke_the_invitation"));
    }
  }

  // Whether the caller may manage (change role / remove) the given member.
  const canManageTarget = (m: WorkspaceMemberView) => {
    if (!canManage) return false;
    if (m.userId === myUserId) return false; // self handled by "Leave"
    if (ROLE_RANK[m.role] > myRank) return false; // cannot manage someone higher
    if (m.role === "owner" && myRole !== "owner") return false;
    return true;
  };
  // The roles this caller may assign (never above their own; owner only by owner).
  const assignableRoles = (m: WorkspaceMemberView) =>
    ROLES.filter((r) => ROLE_RANK[r] <= myRank && (r !== "owner" || myRole === "owner")).concat(
      ROLES.includes(m.role) && !(ROLE_RANK[m.role] <= myRank) ? [m.role] : [],
    );
  const invitableRoles = ROLES.filter((r) => ROLE_RANK[r] <= myRank);
  const alone = members.length <= 1;

  return (
    <div className="w-full">
      {isPersonal ? (
        <div className="rounded-xl border border-dashed border-neutral-300 bg-neutral-50 p-8 text-center">
          <Users size={28} className="mx-auto mb-3 text-neutral-400" />
          <p className="text-sm font-medium text-neutral-700">{tr("dashboard.this_is_your_personal_workspace")}</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-neutral-500">
            It&apos;s just for you. Create a team workspace to invite people and collaborate in real time.
          </p>
        </div>
      ) : (
        <div className="space-y-7">
          {/* Invite (admins/owners only). */}
          {canManage && (
            <section>
              <SectionHeader icon={UserPlus} label={tr("dashboard.invite_people")} />
              <div className="flex items-stretch gap-2">
                <div className="relative min-w-0 flex-1">
                  <Mail size={16} className="pointer-events-none absolute start-3.5 top-1/2 -translate-y-1/2 text-neutral-400" />
                  <input
                    type="email"
                    placeholder={tr("dashboard.teammate_example_com")}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && email.trim() && !busy) void sendInvite();
                    }}
                    aria-label={tr("dashboard.invite_by_email")}
                    className="h-11 w-full rounded-xl border border-neutral-200 bg-surface ps-10 pe-3 text-sm text-neutral-900 placeholder:text-neutral-400 outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                  />
                </div>
                <div className="w-32 shrink-0">
                  <RoleSelect value={inviteRole} roles={invitableRoles} onChange={setInviteRole} ariaLabel={tr("dashboard.invite_role")} />
                </div>
                <Button className="h-11 shrink-0 px-5" disabled={busy || !email.trim()} onClick={() => void sendInvite()}>
                  <Mail size={16} /> {tr("dashboard.invite")}
                </Button>
              </div>
              <p className="mt-2 text-xs text-neutral-500">
                <span className="font-medium text-neutral-600">{roleLabel()[inviteRole]}:</span> {roleDesc()[inviteRole]} They&apos;ll
                get an email with a link to join.
              </p>
            </section>
          )}

          {/* Roster. */}
          <section>
            <SectionHeader icon={Users} label={tr("dashboard.people_with_access")} count={members.length} />
            {loading ? (
              <SkeletonList />
            ) : (
              <ul className="divide-y divide-neutral-100 overflow-hidden rounded-xl border border-neutral-200">
                {members.map((m) => {
                  const self = m.userId === myUserId;
                  const manageable = canManageTarget(m);
                  return (
                    <li key={m.userId} className="flex items-center gap-3 px-3.5 py-3 transition-colors hover:bg-neutral-50/70">
                      <Avatar label={m.name || m.email} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-semibold text-neutral-800">{m.name || m.email}</span>
                          {self && <span className="shrink-0 text-xs font-normal text-neutral-400">(you)</span>}
                        </div>
                        <div className="truncate text-xs text-neutral-500">{m.email}</div>
                      </div>
                      {manageable ? (
                        <div className="w-28 shrink-0">
                          <RoleSelect
                            value={m.role}
                            roles={assignableRoles(m)}
                            onChange={(r) => void changeRole(m, r)}
                            ariaLabel={`Role for ${m.name || m.email}`}
                            size="sm"
                          />
                        </div>
                      ) : (
                        <RoleBadge role={m.role} />
                      )}
                      {self && !alone ? (
                        <button
                          onClick={() => void removeMember(m)}
                          className="shrink-0 rounded-lg px-2.5 py-1 text-xs font-medium text-neutral-500 transition-colors hover:bg-red-50 hover:text-red-600"
                          title={tr("dashboard.leave_workspace")}
                        >
                          {tr("dashboard.leave")}
                        </button>
                      ) : manageable ? (
                        <button
                          onClick={() => void removeMember(m)}
                          aria-label={`Remove ${m.name || m.email}`}
                          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-600"
                          title={tr("dashboard.remove_member")}
                        >
                          <Trash2 size={15} />
                        </button>
                      ) : (
                        <span className="w-8 shrink-0" />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Pending invitations (admins/owners only). */}
          {canManage && invites.length > 0 && (
            <section>
              <SectionHeader icon={Clock} label={tr("dashboard.pending_invitations")} count={invites.length} />
              <ul className="divide-y divide-neutral-100 overflow-hidden rounded-xl border border-neutral-200">
                {invites.map((inv) => (
                  <li key={inv.id} className="flex items-center gap-3 px-3.5 py-3 transition-colors hover:bg-neutral-50/70">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-100">
                      <Clock size={16} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-neutral-800">{inv.email}</div>
                      <div className="truncate text-xs text-neutral-500">
                        {tr("dashboard.invited_as_role_expires", { role: roleLabel()[inv.role], expiry: relativeExpiry(inv.expiresAt) })}
                      </div>
                    </div>
                    <button
                      onClick={() => void sendInvite(inv.email, inv.role, true)}
                      disabled={busy}
                      className="shrink-0 rounded-lg px-2.5 py-1 text-xs font-medium text-brand-ink transition-colors hover:bg-brand-50 disabled:opacity-50"
                    >
                      {tr("dashboard.resend")}
                    </button>
                    <button
                      onClick={() => void revoke(inv)}
                      className="shrink-0 rounded-lg px-2.5 py-1 text-xs font-medium text-neutral-500 transition-colors hover:bg-red-50 hover:text-red-600"
                    >
                      {tr("dashboard.revoke")}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Custom roles (admins/owners only). */}
          {canManage && workspaceId && (
            <section className="border-t border-neutral-100 pt-5">
              <CustomRolesSection workspaceId={workspaceId} />
            </section>
          )}

          {/* Danger zone: delete the workspace (owner only). */}
          {myRole === "owner" && workspaceId && (
            <section className="border-t border-neutral-100 pt-5">
              <SectionHeader icon={AlertTriangle} label={tr("dashboard.danger_zone")} />
              <div className="rounded-xl border border-red-200 bg-red-50/40 p-4">
                <p className="text-sm font-semibold text-neutral-800">{tr("dashboard.delete_this_workspace")}</p>
                <p className="mt-1 text-xs text-neutral-600">
                  {tr("dashboard.permanently_deletes")} <span className="font-semibold">{workspaceName}</span> and everything in it:
                  all designs, members, brand kits, custom roles, and uploads. This cannot be undone.
                </p>
                {!confirmingDelete ? (
                  <Button variant="danger" size="sm" className="mt-3" onClick={() => setConfirmingDelete(true)}>
                    <Trash2 size={15} /> {tr("dashboard.delete_workspace")}
                  </Button>
                ) : (
                  <div className="mt-3">
                    <label htmlFor="ws-delete-confirm" className="block text-xs font-medium text-neutral-700">
                      {tr("dashboard.type")} <span className="font-semibold">{workspaceName}</span> {tr("dashboard.to_confirm")}
                    </label>
                    <input
                      id="ws-delete-confirm"
                      value={deleteConfirm}
                      onChange={(e) => setDeleteConfirm(e.target.value)}
                      autoFocus
                      placeholder={workspaceName}
                      className="mt-1.5 h-10 w-full rounded-xl border border-neutral-200 bg-surface px-3 text-sm text-neutral-900 placeholder:text-neutral-300 outline-none transition focus:border-red-400 focus:ring-2 focus:ring-red-100"
                    />
                    <div className="mt-3 flex justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={() => { setConfirmingDelete(false); setDeleteConfirm(""); }}>
                        {tr("dashboard.cancel")}
                      </Button>
                      <Button variant="danger" size="sm" disabled={deleting || deleteConfirm !== workspaceName} onClick={() => void deleteWorkspace()}>
                        {deleting ? tr("dashboard.deleting") : tr("dashboard.delete_forever")}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

// Placeholder rows while the roster loads.
function SkeletonList() {
  return (
    <ul className="divide-y divide-neutral-100 overflow-hidden rounded-xl border border-neutral-200">
      {[0, 1, 2].map((i) => (
        <li key={i} className="flex items-center gap-3 px-3.5 py-3">
          <span className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-neutral-200" />
          <div className="flex-1 space-y-1.5">
            <span className="block h-3 w-32 animate-pulse rounded bg-neutral-200" />
            <span className="block h-2.5 w-48 animate-pulse rounded bg-neutral-100" />
          </div>
          <span className="h-6 w-16 animate-pulse rounded-full bg-neutral-100" />
        </li>
      ))}
    </ul>
  );
}

// CustomRolesSection: list + create + delete workspace custom roles (a named set
// of capabilities that can be assigned per design from the editor's Share
// dialog). Manage-roles is owner/admin only (the parent already gates this).
function CustomRolesSection({ workspaceId }: { workspaceId: string }) {
  const toast = useToast();
  const [roles, setRoles] = useState<CustomRoleView[]>([]);
  const [creating, setCreating] = useState(false);
  // The role being edited (null = the form, when open, creates a new role).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [caps, setCaps] = useState<Capability[]>(["view", "comment"]);
  const formOpen = creating || editingId !== null;

  function startEdit(r: CustomRoleView) {
    setEditingId(r.id);
    setCreating(false);
    setName(r.name);
    setCaps(r.capabilities);
  }
  function closeForm() {
    setCreating(false);
    setEditingId(null);
    setName("");
    setCaps(["view", "comment"]);
  }

  const reload = useCallback(async () => {
    try {
      setRoles((await oc.listCustomRoles(workspaceId)).filter((r) => r.scope === "workspace"));
    } catch {
      /* surfaced on create/delete instead */
    }
  }, [workspaceId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await oc.listCustomRoles(workspaceId).catch(() => []);
      if (!cancelled) setRoles(r.filter((x) => x.scope === "workspace"));
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const toggleCap = (c: Capability) => setCaps((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  async function save() {
    if (!name.trim() || caps.length === 0) return;
    try {
      if (editingId) {
        await oc.updateCustomRole(editingId, { name: name.trim(), capabilities: caps });
        toast.success(tr("dashboard.custom_role_updated"));
      } else {
        await oc.createCustomRole(workspaceId, { name: name.trim(), capabilities: caps });
        toast.success(tr("dashboard.custom_role_created"));
      }
      closeForm();
      await reload();
    } catch {
      toast.error(editingId ? tr("dashboard.could_not_update_the_role") : tr("dashboard.could_not_create_the_role"));
    }
  }

  async function remove(r: CustomRoleView) {
    try {
      await oc.deleteCustomRole(r.id);
      toast.success(tr("dashboard.role_deleted"));
      await reload();
    } catch {
      toast.error(tr("dashboard.could_not_delete_the_role"));
    }
  }

  return (
    <div>
      <SectionHeader
        icon={Shield}
        label={tr("dashboard.custom_roles")}
        count={roles.length || undefined}
        action={
          !formOpen && (
            <button onClick={() => { closeForm(); setCreating(true); }} className="flex items-center gap-1 text-xs font-semibold text-brand-ink transition-colors hover:text-brand-800">
              <Plus size={14} /> {tr("dashboard.new_role")}
            </button>
          )
        }
      />

      {roles.length === 0 && !formOpen ? (
        <p className="rounded-xl border border-dashed border-neutral-200 bg-neutral-50/60 px-3.5 py-3 text-xs text-neutral-500">
          {tr("dashboard.no_custom_roles_yet_create_one_to_assign_a_n")}
        </p>
      ) : (
        roles.length > 0 && (
          <ul className="divide-y divide-neutral-100 overflow-hidden rounded-xl border border-neutral-200">
            {roles.map((r) => (
              <li key={r.id} className={`flex items-center gap-3 px-3.5 py-3 transition-colors hover:bg-neutral-50/70 ${editingId === r.id ? "bg-brand-50/40" : ""}`}>
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-ink ring-1 ring-inset ring-brand-100">
                  <Shield size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-neutral-800">{r.name}</div>
                  <div className="truncate text-xs capitalize text-neutral-500">{r.capabilities.join(", ").replace(/-/g, " ")}</div>
                </div>
                <button
                  onClick={() => startEdit(r)}
                  aria-label={`Edit role ${r.name}`}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
                  title={tr("dashboard.edit_role")}
                >
                  <Pencil size={15} />
                </button>
                <button
                  onClick={() => void remove(r)}
                  aria-label={`Delete role ${r.name}`}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-600"
                  title={tr("dashboard.delete_role")}
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        )
      )}

      {formOpen && (
        <div className="mt-3 rounded-xl border border-neutral-200 bg-neutral-50/40 p-4">
          <label htmlFor="custom-role-name" className="mb-1.5 block text-sm font-medium text-neutral-700">
            {editingId ? tr("dashboard.edit_role") : tr("dashboard.role_name")}
          </label>
          <input
            id="custom-role-name"
            placeholder={tr("dashboard.e_g_reviewer")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            className="h-11 w-full rounded-xl border border-neutral-200 bg-surface px-3.5 text-sm text-neutral-900 placeholder:text-neutral-400 outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
          <p className="mb-2 mt-3 text-xs font-medium text-neutral-600">{tr("dashboard.capabilities")}</p>
          <div className="flex flex-wrap gap-2">
            {capabilities().map((c) => (
              <label
                key={c.id}
                className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                  caps.includes(c.id) ? "border-brand-300 bg-brand-50 font-medium text-brand-ink" : "border-neutral-200 text-neutral-600 hover:border-neutral-300"
                }`}
              >
                <input type="checkbox" className="sr-only" checked={caps.includes(c.id)} onChange={() => toggleCap(c.id)} />
                {c.label}
              </label>
            ))}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={closeForm}>
              {tr("dashboard.cancel")}
            </Button>
            <Button size="sm" disabled={!name.trim() || caps.length === 0} onClick={() => void save()}>
              {editingId ? tr("dashboard.save_changes") : tr("dashboard.create_role")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
