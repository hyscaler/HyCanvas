// Share dialog. Two areas: People (invite a member by user
// id or anyone by email at view/comment/edit, and manage existing grants) and
// Link (create an "anyone with the link" link at an access level with an
// optional password and expiry, copy it, disable it, or rotate it). The Share
// button and all actions are gated on the caller holding the `share` capability
// (resolved via GET /v1/designs/:id/access); a caller without it sees a
// read-only summary. Matches the app's modal + button + input language.

import { useCallback, useEffect, useState } from "react";
import { Copy, Link2, RotateCw, Trash2, Ban, Check } from "lucide-react";
import type { AccessMode, DesignSharingView, ShareGrant, ShareLinkView } from "@hc/sdk";
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
      className="h-9 rounded-lg border border-neutral-200 bg-white px-2 text-sm text-neutral-800 outline-none focus:border-brand-500 disabled:opacity-50"
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

export function ShareDialog({ open, onClose, designId }: { open: boolean; onClose: () => void; designId: string | null }) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<DesignSharingView | null>(null);

  // Invite form.
  const [invitee, setInvitee] = useState("");
  const [inviteMode, setInviteMode] = useState<AccessMode>("comment");

  // New-link form.
  const [linkMode, setLinkMode] = useState<AccessMode>("view");
  const [linkPassword, setLinkPassword] = useState("");
  const [linkExpiry, setLinkExpiry] = useState("");
  const [busy, setBusy] = useState(false);

  // Re-fetch the sharing payload after a mutation. Does not toggle the loading
  // spinner (that only gates the initial open) so updates feel live.
  const reload = useCallback(async () => {
    if (!designId) return;
    try {
      setData(await oc.designSharing(designId));
    } catch {
      toast.error("Could not load sharing settings.");
    }
  }, [designId, toast]);

  // Initial load. The dialog is remounted per design (keyed by designId in the
  // parent) so `loading` starts true and we only ever clear it here; the fetch
  // runs inside an async IIFE so no setState fires synchronously in the effect.
  useEffect(() => {
    if (!designId) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await oc.designSharing(designId);
        if (!cancelled) setData(next);
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

  const canShare = !!data?.myAccess.capabilities.includes("share");

  async function invite() {
    if (!designId || !invitee.trim()) return;
    const id = invitee.trim();
    // Treat an input containing "@" as an email invite, otherwise a user id.
    const principal = id.includes("@") ? { kind: "email" as const, id } : { kind: "user" as const, id };
    setBusy(true);
    try {
      await oc.addGrant(designId, { principal, mode: inviteMode });
      setInvitee("");
      toast.success("Access granted.");
      await reload();
    } catch {
      toast.error("Could not add this person.");
    } finally {
      setBusy(false);
    }
  }

  async function changeGrant(grant: ShareGrant, mode: AccessMode) {
    try {
      await oc.updateGrant(grant.id, { mode });
      await reload();
    } catch {
      toast.error("Could not update access.");
    }
  }

  async function removeGrant(grant: ShareGrant) {
    try {
      await oc.removeGrant(grant.id);
      await reload();
    } catch {
      toast.error("Could not remove access.");
    }
  }

  async function createLink() {
    if (!designId) return;
    setBusy(true);
    try {
      await oc.createShareLink(designId, {
        mode: linkMode,
        password: linkPassword.trim() || undefined,
        // A date input gives YYYY-MM-DD; send end-of-day ISO so the chosen day
        // remains valid through its end.
        expiresAt: linkExpiry ? new Date(`${linkExpiry}T23:59:59`).toISOString() : undefined,
      });
      setLinkPassword("");
      setLinkExpiry("");
      toast.success("Link created.");
      await reload();
    } catch {
      toast.error("Could not create the link.");
    } finally {
      setBusy(false);
    }
  }

  async function copyLink(link: ShareLinkView) {
    try {
      await navigator.clipboard.writeText(linkUrl(link.token));
      toast.success("Link copied.");
    } catch {
      toast.error("Could not copy.");
    }
  }

  async function toggleLink(link: ShareLinkView) {
    try {
      await oc.updateShareLink(link.id, { disabled: !link.disabled });
      await reload();
    } catch {
      toast.error("Could not update the link.");
    }
  }

  async function rotateLink(link: ShareLinkView) {
    try {
      const next = await oc.rotateShareLink(link.id);
      await navigator.clipboard.writeText(linkUrl(next.token)).catch(() => undefined);
      toast.success("Link rotated; new link copied.");
      await reload();
    } catch {
      toast.error("Could not rotate the link.");
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Share" width="w-[34rem]">
      {loading ? (
        <div className="grid place-items-center py-10 text-neutral-400"><Spinner /></div>
      ) : !canShare ? (
        <p className="py-6 text-sm text-neutral-600">
          You do not have permission to change sharing for this design. Ask an owner or admin for access.
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {/* People */}
          <section>
            <h3 className="mb-2 text-sm font-semibold text-neutral-800">Invite people</h3>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Input
                  placeholder="Email address or member id"
                  value={invitee}
                  onChange={(e) => setInvitee(e.target.value)}
                  className="h-9"
                />
              </div>
              <ModeSelect value={inviteMode} onChange={setInviteMode} />
              <Button size="sm" onClick={() => void invite()} disabled={busy || !invitee.trim()}>Invite</Button>
            </div>

            {data && data.grants.length > 0 && (
              <ul className="mt-3 flex flex-col gap-1.5">
                {data.grants.map((g) => (
                  <li key={g.id} className="flex items-center gap-2 rounded-lg border border-neutral-100 bg-neutral-50 px-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-neutral-700">
                      {g.principal.kind === "email" ? g.principal.id : `Member ${g.principal.id.slice(0, 8)}`}
                    </span>
                    <ModeSelect value={g.mode} onChange={(m) => void changeGrant(g, m)} />
                    <button aria-label="Remove access" className="grid h-8 w-8 place-items-center rounded-lg text-neutral-400 hover:bg-neutral-200 hover:text-red-600" onClick={() => void removeGrant(g)}>
                      <Trash2 size={15} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Link */}
          <section className="border-t border-neutral-100 pt-5">
            <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-neutral-800">
              <Link2 size={15} /> Share links
            </h3>
            <div className="flex flex-wrap items-end gap-2">
              <ModeSelect value={linkMode} onChange={setLinkMode} />
              <div className="w-36">
                <Input type="password" placeholder="Password (optional)" value={linkPassword} onChange={(e) => setLinkPassword(e.target.value)} className="h-9" />
              </div>
              <div className="w-40">
                <Input type="date" value={linkExpiry} onChange={(e) => setLinkExpiry(e.target.value)} className="h-9" />
              </div>
              <Button size="sm" onClick={() => void createLink()} disabled={busy}>Create link</Button>
            </div>

            {data && data.links.length > 0 && (
              <ul className="mt-3 flex flex-col gap-1.5">
                {data.links.map((l) => (
                  <li key={l.id} className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${l.disabled ? "border-neutral-100 bg-neutral-50 opacity-60" : "border-neutral-100 bg-white"}`}>
                    <span className="flex items-center gap-1.5 text-xs font-medium text-neutral-500">
                      {MODE_LABEL[l.mode]}
                      {l.hasPassword && <span className="rounded bg-neutral-100 px-1.5 py-0.5">password</span>}
                      {l.expiresAt && <span className="rounded bg-neutral-100 px-1.5 py-0.5">expires {new Date(l.expiresAt).toLocaleDateString()}</span>}
                      {l.disabled && <span className="rounded bg-red-50 px-1.5 py-0.5 text-red-600">disabled</span>}
                    </span>
                    <span className="ml-auto flex items-center gap-0.5">
                      <button aria-label="Copy link" title="Copy link" className="grid h-8 w-8 place-items-center rounded-lg text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700" onClick={() => void copyLink(l)} disabled={l.disabled}>
                        <Copy size={15} />
                      </button>
                      <button aria-label="Rotate link" title="Rotate (issue a new link)" className="grid h-8 w-8 place-items-center rounded-lg text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700" onClick={() => void rotateLink(l)}>
                        <RotateCw size={15} />
                      </button>
                      <button aria-label={l.disabled ? "Enable link" : "Disable link"} title={l.disabled ? "Enable" : "Disable"} className="grid h-8 w-8 place-items-center rounded-lg text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700" onClick={() => void toggleLink(l)}>
                        {l.disabled ? <Check size={15} /> : <Ban size={15} />}
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-neutral-400">
              Anyone with a view or comment link can open this design without an account.
            </p>
          </section>
        </div>
      )}
    </Modal>
  );
}
