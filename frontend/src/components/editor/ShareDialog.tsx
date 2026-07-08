// Share dialog. Two areas: People (invite anyone by email at view/comment/edit
// and manage existing grants) and Link (create one or more "anyone with the
// link" links at an access level with an optional password, expiry, and a
// require-sign-in toggle, then copy, edit, rotate, disable, or delete them). The
// Share button and all mutations are gated on the caller holding the `share`
// capability (resolved via GET /v1/designs/:id/access); a caller without it sees
// a read-only summary. Matches the app's modal + button + input language.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Link2, RotateCw, Trash2, Ban, Check, Eye, EyeOff, Lock, Crown, X, UserCheck, ChevronRight, Plus } from "lucide-react";
import { ApiError } from "@hc/sdk";
import type { AccessMode, AccessRequestView, DesignSharingView, ShareGrant, ShareLinkView } from "@hc/sdk";
import { oc } from "@/lib/sdk";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";

const MODES: AccessMode[] = ["view", "comment", "edit"];
const MODE_LABEL: Record<AccessMode, string> = {
  view: "Can view",
  comment: "Can comment",
  edit: "Can edit",
};

function ModeSelect({ value, onChange, disabled }: { value: AccessMode; onChange: (m: AccessMode) => void; disabled?: boolean }) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as AccessMode)}
      className="h-9 rounded-lg border border-neutral-200 bg-surface px-2 text-sm text-neutral-800 outline-none focus:border-brand-500 disabled:opacity-50"
    >
      {MODES.map((m) => (
        <option key={m} value={m}>{MODE_LABEL[m]}</option>
      ))}
    </select>
  );
}

/** Build the absolute landing URL for a share token (the /shared?token= route). */
function linkUrl(token: string): string {
  const path = `/shared?token=${encodeURIComponent(token)}`;
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${path}`;
}

/** Pull a human message out of a problem+json error, else the fallback. */
function errMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    const body = e.body as { detail?: string; title?: string } | null;
    if (body?.detail) return body.detail;
    if (body?.title) return body.title;
  }
  return fallback;
}

/** Copy text to the clipboard, falling back to a hidden textarea + execCommand
 *  for insecure-context self-hosts where navigator.clipboard is unavailable.
 *  Returns whether the copy succeeded. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** ISO timestamp -> the value a <input type="datetime-local"> expects (local). */
function toLocalInput(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Display label for a grant: a person's name (with email subtitle) or the
 *  invited email; never a raw id. */
function principalLabel(g: ShareGrant): { primary: string; secondary?: string } {
  if (g.principal.kind === "email") return { primary: g.principal.id };
  const name = g.principal.name?.trim();
  const email = g.principal.email?.trim();
  if (name) return { primary: name, secondary: email || undefined };
  if (email) return { primary: email };
  return { primary: "Member" };
}

export function ShareDialog({ open, onClose, designId, focusRequests }: { open: boolean; onClose: () => void; designId: string | null; focusRequests?: boolean }) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<DesignSharingView | null>(null);
  const [requests, setRequests] = useState<AccessRequestView[]>([]);
  // The pending-requests inbox, scrolled into view when opened from an
  // access-request notification deep link (focusRequests).
  const requestsRef = useRef<HTMLElement>(null);
  // Per-request access level chosen when approving (defaults to the requested mode).
  const [approveMode, setApproveMode] = useState<Record<string, AccessMode>>({});

  // Invite form.
  const [invitee, setInvitee] = useState("");
  const [inviteMode, setInviteMode] = useState<AccessMode>("comment");
  const [inviting, setInviting] = useState(false);

  // New-link form.
  const [linkMode, setLinkMode] = useState<AccessMode>("view");
  const [linkPassword, setLinkPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [linkExpiry, setLinkExpiry] = useState("");
  const [linkRequireSignin, setLinkRequireSignin] = useState(false);
  const [creatingLink, setCreatingLink] = useState(false);
  // Advanced link settings (password/expiry/require sign-in) collapse by default
  // so the common case is just "pick access, Create link".
  const [linkOptionsOpen, setLinkOptionsOpen] = useState(false);

  // Per-row in-flight state (keyed by grant/link id) and two-click confirm
  // arming for destructive actions.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [armed, setArmed] = useState<string | null>(null);

  const isPending = (id: string) => !!pending[id];
  const withPending = useCallback(async <T,>(id: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setPending((p) => ({ ...p, [id]: true }));
    try {
      return await fn();
    } finally {
      setPending((p) => {
        const next = { ...p };
        delete next[id];
        return next;
      });
    }
  }, []);

  // First click on a destructive action arms it (and auto-disarms after 3s);
  // a second click while armed returns true so the action proceeds.
  const confirmArmed = useCallback((key: string): boolean => {
    if (armed === key) {
      setArmed(null);
      return true;
    }
    setArmed(key);
    window.setTimeout(() => setArmed((a) => (a === key ? null : a)), 3000);
    return false;
  }, [armed]);

  // Re-fetch the sharing payload after a mutation. Does not toggle the loading
  // spinner (that only gates the initial open) so updates feel live.
  const reload = useCallback(async () => {
    if (!designId) return;
    try {
      const next = await oc.designSharing(designId);
      setData(next);
      // Pending access requests are share-gated; only fetch when the caller can act.
      if (next.myAccess.capabilities.includes("share")) {
        setRequests(await oc.listAccessRequests(designId).catch(() => []));
      }
    } catch {
      toast.error("Could not load sharing settings.");
    }
  }, [designId, toast]);

  // Initial load. The dialog is remounted per design (keyed by designId in the
  // parent) so `loading` starts true and we only ever clear it here.
  useEffect(() => {
    if (!designId) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await oc.designSharing(designId);
        if (cancelled) return;
        setData(next);
        if (next.myAccess.capabilities.includes("share")) {
          const reqs = await oc.listAccessRequests(designId).catch(() => []);
          if (!cancelled) setRequests(reqs);
        }
      } catch {
        if (!cancelled) toast.error("Could not load sharing settings.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [designId, toast]);

  // Deep-link focus: once the requests inbox has rendered, scroll it into view.
  // Deferred a tick so it runs after the dialog's open/render settles.
  useEffect(() => {
    if (!open || !focusRequests || loading || requests.length === 0) return;
    const t = window.setTimeout(() => {
      requestsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 60);
    return () => window.clearTimeout(t);
  }, [open, focusRequests, loading, requests.length]);

  const canShare = !!data?.myAccess.capabilities.includes("share");
  const canManageRoles = !!data?.myAccess.capabilities.includes("manage-roles");
  const roleName = useCallback(
    (roleId?: string | null) => (roleId && data ? data.customRoles.find((r) => r.id === roleId)?.name ?? null : null),
    [data],
  );

  async function setGrantRole(grant: ShareGrant, roleId: string) {
    await withPending(grant.id, async () => {
      try {
        await oc.updateGrant(grant.id, { roleId: roleId || null });
        toast.success(roleId ? "Role assigned." : "Role cleared.");
        await reload();
      } catch (e) {
        toast.error(errMessage(e, "Could not update the role."));
      }
    });
  }

  async function approveRequest(req: AccessRequestView) {
    await withPending(req.id, async () => {
      try {
        await oc.approveAccessRequest(req.id, approveMode[req.id] ?? req.mode);
        toast.success("Access granted.");
        await reload();
      } catch (e) {
        toast.error(errMessage(e, "Could not approve the request."));
      }
    });
  }

  async function denyRequest(req: AccessRequestView) {
    if (!confirmArmed(`deny-req:${req.id}`)) return;
    await withPending(req.id, async () => {
      try {
        await oc.denyAccessRequest(req.id);
        toast.success("Request denied.");
        await reload();
      } catch (e) {
        toast.error(errMessage(e, "Could not deny the request."));
      }
    });
  }

  // Whether any live link lets people in without an account, and whether one of
  // those grants edit access (a stronger warning).
  const anonLinks = useMemo(() => (data?.links ?? []).filter((l) => !l.disabled && !l.requireSignin), [data]);
  const anonEdit = anonLinks.some((l) => l.mode === "edit");

  async function invite() {
    if (!designId) return;
    const id = invitee.trim();
    if (!id) return;
    if (!id.includes("@")) {
      toast.error("Enter an email address.");
      return;
    }
    setInviting(true);
    try {
      await oc.addGrant(designId, { principal: { kind: "email", id }, mode: inviteMode });
      setInvitee("");
      toast.success("Access granted.");
      await reload();
    } catch (e) {
      toast.error(errMessage(e, "Could not add this person."));
    } finally {
      setInviting(false);
    }
  }

  async function changeGrant(grant: ShareGrant, mode: AccessMode) {
    await withPending(grant.id, async () => {
      try {
        await oc.updateGrant(grant.id, { mode });
        toast.success("Access updated.");
        await reload();
      } catch (e) {
        toast.error(errMessage(e, "Could not update access."));
      }
    });
  }

  async function removeGrant(grant: ShareGrant) {
    if (!confirmArmed(`rm-grant:${grant.id}`)) return;
    await withPending(grant.id, async () => {
      try {
        await oc.removeGrant(grant.id);
        toast.success("Access removed.");
        await reload();
      } catch (e) {
        toast.error(errMessage(e, "Could not remove access."));
      }
    });
  }

  async function createLink() {
    if (!designId) return;
    setCreatingLink(true);
    try {
      const created = await oc.createShareLink(designId, {
        mode: linkMode,
        password: linkPassword.trim() || undefined,
        expiresAt: linkExpiry ? new Date(linkExpiry).toISOString() : undefined,
        requireSignin: linkRequireSignin || undefined,
      });
      setLinkPassword("");
      setLinkExpiry("");
      setLinkRequireSignin(false);
      setLinkOptionsOpen(false);
      const copied = await copyText(linkUrl(created.token));
      toast.success(copied ? "Link created and copied." : "Link created.");
      await reload();
    } catch (e) {
      toast.error(errMessage(e, "Could not create the link."));
    } finally {
      setCreatingLink(false);
    }
  }

  async function copyLink(link: ShareLinkView) {
    const ok = await copyText(linkUrl(link.token));
    if (ok) toast.success("Link copied.");
    else toast.error("Could not copy. Select the link and copy it manually.");
  }

  async function patchLink(link: ShareLinkView, patch: Parameters<typeof oc.updateShareLink>[1], successMsg: string) {
    await withPending(link.id, async () => {
      try {
        await oc.updateShareLink(link.id, patch);
        toast.success(successMsg);
        await reload();
      } catch (e) {
        toast.error(errMessage(e, "Could not update the link."));
      }
    });
  }

  async function rotateLink(link: ShareLinkView) {
    if (!confirmArmed(`rot-link:${link.id}`)) return;
    await withPending(link.id, async () => {
      try {
        const next = await oc.rotateShareLink(link.id);
        const copied = await copyText(linkUrl(next.token));
        toast.success(copied ? "Link rotated; new link copied." : "Link rotated. Copy the new link below.");
        await reload();
      } catch (e) {
        toast.error(errMessage(e, "Could not rotate the link."));
      }
    });
  }

  async function deleteLink(link: ShareLinkView) {
    if (!confirmArmed(`del-link:${link.id}`)) return;
    await withPending(link.id, async () => {
      try {
        await oc.deleteShareLink(link.id);
        toast.success("Link deleted.");
        await reload();
      } catch (e) {
        toast.error(errMessage(e, "Could not delete the link."));
      }
    });
  }

  return (
    <Modal open={open} onClose={onClose} title="Share" width="w-[34rem]">
      {loading ? (
        <div className="grid place-items-center py-10 text-neutral-400"><Spinner /></div>
      ) : !canShare ? (
        <div className="py-6 text-sm text-neutral-600">
          <p>
            You have {data ? MODE_LABEL[data.myAccess.mode].toLowerCase() : "limited"} access to this design and
            cannot change its sharing.
          </p>
          <p className="mt-1 text-neutral-500">Ask an owner or admin to grant you access.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {/* Pending access requests (actionable; only when there are any). */}
          {requests.length > 0 && (
            <section ref={requestsRef} className="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
              <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-amber-800">
                <UserCheck size={15} /> Requests to access ({requests.length})
              </h3>
              <ul className="flex flex-col gap-1.5">
                {requests.map((req) => {
                  const armedDeny = armed === `deny-req:${req.id}`;
                  return (
                    <li key={req.id} className="flex items-center gap-2 rounded-lg border border-amber-100 bg-surface px-3 py-2">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-neutral-800">{req.requester.name || req.requester.email || "Someone"}</span>
                        <span className="block truncate text-xs text-neutral-400">
                          wants {MODE_LABEL[req.mode].toLowerCase()}
                          {req.message ? ` · “${req.message}”` : ""}
                        </span>
                      </span>
                      <ModeSelect
                        value={approveMode[req.id] ?? req.mode}
                        onChange={(m) => setApproveMode((s) => ({ ...s, [req.id]: m }))}
                        disabled={isPending(req.id)}
                      />
                      <Button size="sm" onClick={() => void approveRequest(req)} disabled={isPending(req.id)}>Approve</Button>
                      <button
                        aria-label={armedDeny ? "Click again to deny" : "Deny request"}
                        title={armedDeny ? "Click again to deny" : "Deny request"}
                        disabled={isPending(req.id)}
                        className={`grid h-8 w-8 place-items-center rounded-lg disabled:opacity-40 ${armedDeny ? "bg-red-50 text-red-600 ring-1 ring-red-300" : "text-neutral-400 hover:bg-neutral-200 hover:text-red-600"}`}
                        onClick={() => void denyRequest(req)}
                      >
                        <X size={15} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/* People */}
          <section>
            <h3 className="mb-2 text-sm font-semibold text-neutral-800">Invite people</h3>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Input
                  type="email"
                  placeholder="Email address"
                  value={invitee}
                  onChange={(e) => setInvitee(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !inviting) void invite();
                  }}
                  className="h-9"
                />
              </div>
              <ModeSelect value={inviteMode} onChange={setInviteMode} disabled={inviting} />
              <Button size="sm" onClick={() => void invite()} disabled={inviting || !invitee.trim()}>
                {inviting ? "Inviting…" : "Invite"}
              </Button>
            </div>

            <ul className="mt-3 flex flex-col gap-1.5">
              {/* Owner attribution row. */}
              {data?.owner && (
                <li className="flex items-center gap-2 rounded-lg border border-neutral-100 bg-neutral-50 px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-neutral-800">{data.owner.name || data.owner.email || "Owner"}</span>
                    {data.owner.email && data.owner.name && <span className="block truncate text-xs text-neutral-400">{data.owner.email}</span>}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700">
                    <Crown size={11} /> Owner
                  </span>
                </li>
              )}
              {data?.grants.map((g) => {
                const label = principalLabel(g);
                const role = roleName(g.roleId);
                const armedRemove = armed === `rm-grant:${g.id}`;
                return (
                  <li key={g.id} className="flex flex-col gap-1.5 rounded-lg border border-neutral-100 bg-neutral-50 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-neutral-800">{label.primary}</span>
                        {label.secondary && <span className="block truncate text-xs text-neutral-400">{label.secondary}</span>}
                        {g.invitedByName && <span className="block truncate text-[11px] text-neutral-400">Invited by {g.invitedByName}</span>}
                      </span>
                      {!canManageRoles && role && <span className="rounded bg-brand-50 px-1.5 py-0.5 text-xs font-medium text-brand-ink">{role}</span>}
                      <ModeSelect value={g.mode} onChange={(m) => void changeGrant(g, m)} disabled={isPending(g.id)} />
                      <button
                        aria-label={armedRemove ? "Click again to remove access" : "Remove access"}
                        title={armedRemove ? "Click again to remove" : "Remove access"}
                        disabled={isPending(g.id)}
                        className={`grid h-8 w-8 place-items-center rounded-lg disabled:opacity-40 ${armedRemove ? "bg-red-50 text-red-600 ring-1 ring-red-300" : "text-neutral-400 hover:bg-neutral-200 hover:text-red-600"}`}
                        onClick={() => void removeGrant(g)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                    {canManageRoles && (data?.customRoles.length ?? 0) > 0 && (
                      <div className="flex items-center gap-2 text-xs text-neutral-500">
                        <span>Role</span>
                        <select
                          value={g.roleId ?? ""}
                          disabled={isPending(g.id)}
                          onChange={(e) => void setGrantRole(g, e.target.value)}
                          className="h-7 rounded border border-neutral-200 bg-surface px-1.5 text-xs text-neutral-700 outline-none focus:border-brand-500 disabled:opacity-50"
                        >
                          <option value="">No role</option>
                          {data?.customRoles.map((r) => (
                            <option key={r.id} value={r.id}>{r.name}</option>
                          ))}
                        </select>
                      </div>
                    )}
                  </li>
                );
              })}
              {!data?.owner && data?.grants.length === 0 && (
                <li className="rounded-lg px-1 py-1 text-xs text-neutral-400">Only you have access.</li>
              )}
            </ul>
          </section>

          {/* Link */}
          <section className="border-t border-neutral-100 pt-5">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-neutral-800">
              <Link2 size={15} /> Share links
            </h3>
            <p className="mb-3 mt-0.5 text-xs text-neutral-500">
              Create a link anyone can open. Add a password, expiry, or require sign-in for more control.
            </p>

            {/* Create form: a clean primary row, with advanced settings tucked away. */}
            <div className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-3">
              <div className="flex items-center gap-2">
                <span className="hidden text-sm text-neutral-600 sm:inline">Anyone with the link</span>
                <ModeSelect value={linkMode} onChange={setLinkMode} disabled={creatingLink} />
                <Button size="sm" className="ml-auto gap-1" onClick={() => void createLink()} disabled={creatingLink}>
                  <Plus size={15} /> {creatingLink ? "Creating…" : "Create link"}
                </Button>
              </div>

              <button
                type="button"
                onClick={() => setLinkOptionsOpen((v) => !v)}
                className="mt-2.5 flex items-center gap-1 text-xs font-medium text-neutral-500 transition-colors hover:text-neutral-700"
                aria-expanded={linkOptionsOpen}
              >
                <ChevronRight size={13} className={`transition-transform ${linkOptionsOpen ? "rotate-90" : ""}`} />
                Link options
                {(linkPassword || linkExpiry || linkRequireSignin) && (
                  <span className="rounded-full bg-brand-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-ink">set</span>
                )}
              </button>

              {linkOptionsOpen && (
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600">
                    Password
                    <div className="relative">
                      <Input
                        type={showPassword ? "text" : "password"}
                        placeholder="Optional"
                        value={linkPassword}
                        onChange={(e) => setLinkPassword(e.target.value)}
                        className="h-9 pr-8"
                      />
                      <button
                        type="button"
                        aria-label={showPassword ? "Hide password" : "Show password"}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600"
                        onClick={() => setShowPassword((v) => !v)}
                      >
                        {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                  </label>
                  <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600">
                    Expires
                    <Input type="datetime-local" value={linkExpiry} onChange={(e) => setLinkExpiry(e.target.value)} className="h-9" />
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-neutral-600 sm:col-span-2">
                    <input type="checkbox" checked={linkRequireSignin} onChange={(e) => setLinkRequireSignin(e.target.checked)} />
                    Require people to sign in to open the link
                  </label>
                </div>
              )}
            </div>

            {data && data.links.length > 0 ? (
              <ul className="mt-3 flex flex-col gap-2">
                {data.links.map((l) => {
                  const url = linkUrl(l.token);
                  const busy = isPending(l.id);
                  const armedRotate = armed === `rot-link:${l.id}`;
                  const armedDelete = armed === `del-link:${l.id}`;
                  return (
                    <li key={l.id} className={`flex flex-col gap-2 rounded-xl border px-3 py-2.5 ${l.disabled ? "border-neutral-100 bg-neutral-50 opacity-70" : "border-neutral-200 bg-surface"}`}>
                      <div className="flex items-center gap-2">
                        <ModeSelect value={l.mode} onChange={(m) => void patchLink(l, { mode: m }, "Link access updated.")} disabled={busy} />
                        <span className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-neutral-500">
                          {l.hasPassword && <span className="inline-flex items-center gap-0.5 rounded bg-neutral-100 px-1.5 py-0.5"><Lock size={11} /> password</span>}
                          {l.requireSignin && <span className="rounded bg-neutral-100 px-1.5 py-0.5">sign-in</span>}
                          {l.expiresAt && <span className="rounded bg-neutral-100 px-1.5 py-0.5">expires {new Date(l.expiresAt).toLocaleString()}</span>}
                          {l.disabled && <span className="rounded bg-red-50 px-1.5 py-0.5 text-red-600">disabled</span>}
                        </span>
                        <span className="ml-auto flex items-center gap-0.5">
                          <button aria-label="Rotate link" title={armedRotate ? "Click again to rotate" : "Rotate (issue a new link)"} disabled={busy} className={`grid h-8 w-8 place-items-center rounded-lg disabled:opacity-40 ${armedRotate ? "bg-amber-50 text-amber-600 ring-1 ring-amber-300" : "text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"}`} onClick={() => void rotateLink(l)}>
                            <RotateCw size={15} />
                          </button>
                          <button aria-label={l.disabled ? "Enable link" : "Disable link"} title={l.disabled ? "Enable" : "Disable"} disabled={busy} className="grid h-8 w-8 place-items-center rounded-lg text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-40" onClick={() => void patchLink(l, { disabled: !l.disabled }, l.disabled ? "Link enabled." : "Link disabled.")}>
                            {l.disabled ? <Check size={15} /> : <Ban size={15} />}
                          </button>
                          <button aria-label={armedDelete ? "Click again to delete link" : "Delete link"} title={armedDelete ? "Click again to delete" : "Delete link"} disabled={busy} className={`grid h-8 w-8 place-items-center rounded-lg disabled:opacity-40 ${armedDelete ? "bg-red-50 text-red-600 ring-1 ring-red-300" : "text-neutral-400 hover:bg-neutral-100 hover:text-red-600"}`} onClick={() => void deleteLink(l)}>
                            <Trash2 size={15} />
                          </button>
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <input
                          readOnly
                          value={url}
                          onFocus={(e) => e.currentTarget.select()}
                          className="h-8 min-w-0 flex-1 truncate rounded-lg border border-neutral-200 bg-neutral-50 px-2 font-mono text-xs text-neutral-600 outline-none"
                        />
                        <button aria-label="Copy link" title="Copy link" disabled={l.disabled} className="grid h-8 w-8 place-items-center rounded-lg text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-40" onClick={() => void copyLink(l)}>
                          <Copy size={15} />
                        </button>
                      </div>
                      <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-500">
                        <label className="flex items-center gap-1">
                          <span>Expires</span>
                          <input
                            type="datetime-local"
                            value={toLocalInput(l.expiresAt)}
                            disabled={busy}
                            onChange={(e) => void patchLink(l, { expiresAt: e.target.value ? new Date(e.target.value).toISOString() : null }, e.target.value ? "Expiry updated." : "Expiry removed.")}
                            className="h-7 rounded border border-neutral-200 bg-surface px-1.5 text-xs text-neutral-700 outline-none focus:border-brand-500 disabled:opacity-50"
                          />
                        </label>
                        <label className="flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={l.requireSignin}
                            disabled={busy}
                            onChange={(e) => void patchLink(l, { requireSignin: e.target.checked }, e.target.checked ? "Sign-in required." : "Sign-in no longer required.")}
                          />
                          <span>Require sign-in</span>
                        </label>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="mt-3 text-xs text-neutral-400">No share links yet.</p>
            )}

            {anonLinks.length > 0 && (
              <p className={`mt-2 text-xs ${anonEdit ? "text-red-500" : "text-neutral-400"}`}>
                {anonEdit
                  ? "Anyone with an edit link can change this design without an account."
                  : "Anyone with this link can open this design without an account."}
              </p>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}
