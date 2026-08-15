// Approval workflow UI (FR-10, FR-11, AC-7). Three surfaces:
//   - a "Request approval" dialog (pick approvers from the mentionable/access
//     people, choose an any/all policy, submit),
//   - a status banner over the canvas: "Approval pending - N of M approved" with
//     Approve / Reject (+ note) for approvers, and "Approved - locked" with a
//     Reopen action for owner/admin/approver when granted,
//   - it reports the derived lock state up so the editor disables editing
//     (reusing the access-mode read-only gating) the moment an approval grants.
// All permission decisions come from the server-computed `actions` on the
// approval view; the client never re-derives them. The live `{ t: "role" }`
// downgrade/upgrade is handled by the editor shell (it refetches on a role flip).

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Clock, Lock, ShieldCheck, X } from "lucide-react";
import type { ApprovalPolicy, DesignApprovalView, MentionablePerson } from "@hc/sdk";
import { oc } from "@/lib/sdk";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { tr } from "@/lib/i18n";

interface Props {
  designId: string;
  /** Open the request dialog (driven from the top-bar action). */
  requestOpen: boolean;
  onRequestClose: () => void;
  /** Called with the derived lock state whenever the approval state changes, so
   *  the editor shell can flip the read-only gating without a reload. */
  onLockChange: (locked: boolean) => void;
  /** A monotonically-increasing token the shell bumps on a live role frame to
   *  force a refetch of the approval state (keeps the banner in sync). */
  refreshToken: number;
}

export function ApprovalBanner({ designId, requestOpen, onRequestClose, onLockChange, refreshToken }: Props) {
  const toast = useToast();
  const [view, setView] = useState<DesignApprovalView | null>(null);
  const [people, setPeople] = useState<MentionablePerson[]>([]);
  const [busy, setBusy] = useState(false);

  // Request-dialog form state.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [policy, setPolicy] = useState<ApprovalPolicy>("any");

  // Reject-note prompt state (which decision is asking for a note).
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");

  // Apply a freshly-fetched approval view to local state + report the lock up.
  const apply = useCallback(
    (next: DesignApprovalView) => {
      setView(next);
      onLockChange(next.locked);
    },
    [onLockChange],
  );

  // Refetch the approval state on mount, design change, and every live role flip
  // (refreshToken bump). The async work + setState live inside a nested IIFE so
  // the effect body itself does not call setState synchronously.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await oc.designApproval(designId);
        if (!cancelled) apply(next);
      } catch {
        /* best effort; the server stays the source of truth */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [designId, refreshToken, apply]);

  // Load the pickable approvers lazily when the request dialog opens.
  useEffect(() => {
    if (!requestOpen) return;
    let cancelled = false;
    void (async () => {
      try {
        const p = await oc.mentionablePeople(designId);
        if (!cancelled) setPeople(p);
      } catch {
        /* leave empty; the form still validates server-side */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requestOpen, designId]);

  async function submitRequest() {
    const approverIds = [...selected];
    if (approverIds.length === 0) {
      toast.error(tr("editor.pick_at_least_one_approver"));
      return;
    }
    setBusy(true);
    try {
      const next = await oc.requestApproval(designId, { approverIds, policy });
      apply(next);
      setSelected(new Set());
      toast.success(tr("editor.approval_requested"));
      onRequestClose();
    } catch {
      toast.error(tr("editor.could_not_request_approval_one_may_already_b"));
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: "approve" | "reject", noteText?: string) {
    const approval = view?.approval;
    if (!approval) return;
    setBusy(true);
    try {
      const next = await oc.decideApproval(approval.id, { decision, note: noteText });
      apply(next);
      setRejecting(false);
      setNote("");
      toast.success(decision === "approve" ? tr("editor.approved") : tr("editor.rejected"));
    } catch {
      toast.error(tr("editor.could_not_record_your_decision"));
    } finally {
      setBusy(false);
    }
  }

  async function reopen() {
    const approval = view?.approval;
    if (!approval) return;
    setBusy(true);
    try {
      const next = await oc.reopenApproval(approval.id);
      apply(next);
      toast.success(tr("editor.reopened_for_editing_the_prior_approval_is_i"));
    } catch {
      toast.error(tr("editor.could_not_reopen_this_design"));
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const approval = view?.approval;
  const actions = view?.actions;
  const pending = approval?.status === "pending";
  const locked = view?.locked ?? false;

  return (
    <>
      {/* Status banner. Pending (amber) shows progress + approver actions; locked
          (emerald) shows the approved+locked state + reopen. */}
      {(pending || locked) && approval && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center p-3">
          <div
            className={`pointer-events-auto flex max-w-[44rem] items-center gap-3 rounded-xl border px-4 py-2 shadow-md ${
              locked ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"
            }`}
          >
            {locked ? <Lock size={16} className="shrink-0 text-emerald-600" /> : <Clock size={16} className="shrink-0 text-amber-700" />}
            <div className="min-w-0">
              <p className={`text-sm font-medium ${locked ? "text-emerald-900" : "text-amber-900"}`}>
                {locked
                  ? tr("editor.approved_editing_is_locked")
                  : `Approval pending - ${approval.approvedCount} of ${approval.approverCount} approved`}
              </p>
              <p className="truncate text-xs text-neutral-500">
                Requested by {approval.requester.name}
                {approval.decisions.length > 0 &&
                  " · " +
                    approval.decisions
                      .map((d) => `${d.approverName} ${d.decision === "approve" ? "approved" : "rejected"}`)
                      .join(", ")}
              </p>
            </div>
            <div className="ms-auto flex shrink-0 items-center gap-1.5">
              {pending && actions?.canDecide && (
                <>
                  <Button size="sm" onClick={() => void decide("approve")} disabled={busy}>
                    <CheckCircle2 size={15} /> {tr("editor.approve")}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setRejecting(true)} disabled={busy}>
                    <X size={15} /> {tr("editor.reject")}
                  </Button>
                </>
              )}
              {locked && actions?.canReopen && (
                <Button variant="secondary" size="sm" onClick={() => void reopen()} disabled={busy} title={tr("editor.reopening_invalidates_the_approval")}>
                  {tr("editor.reopen_for_editing")}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Reject-note prompt. */}
      <Modal open={rejecting} onClose={() => setRejecting(false)} title={tr("editor.reject_with_a_note")}>
        <div className="flex flex-col gap-3">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={tr("editor.optional_note_explaining_the_rejection")}
            rows={3}
            className="oc-scroll w-full resize-none rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-brand-500"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setRejecting(false)}>{tr("editor.cancel")}</Button>
            <Button size="sm" onClick={() => void decide("reject", note.trim() || undefined)} disabled={busy}>{tr("editor.reject")}</Button>
          </div>
        </div>
      </Modal>

      {/* Request-approval dialog. */}
      <Modal open={requestOpen} onClose={onRequestClose} title={tr("editor.request_approval")} width="w-[30rem]">
        <div className="flex flex-col gap-4">
          <div>
            <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-neutral-800">
              <ShieldCheck size={15} /> {tr("editor.approvers")}
            </p>
            {people.length === 0 ? (
              <p className="text-sm text-neutral-500">{tr("editor.no_people_with_access_to_pick_from_yet")}</p>
            ) : (
              <ul className="oc-scroll max-h-56 overflow-y-auto rounded-lg border border-neutral-100">
                {people.map((p) => (
                  <li key={p.id}>
                    <label className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-neutral-50">
                      <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                      <span className="min-w-0 flex-1 truncate text-sm text-neutral-700">{p.name}</span>
                      {p.email && <span className="truncate text-xs text-neutral-400">{p.email}</span>}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="mb-2 text-sm font-semibold text-neutral-800">{tr("editor.policy")}</p>
            <div className="flex gap-4 text-sm text-neutral-700">
              <label className="flex items-center gap-2">
                <input type="radio" name="policy" checked={policy === "any"} onChange={() => setPolicy("any")} />
                {tr("editor.any_approver")}
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="policy" checked={policy === "all"} onChange={() => setPolicy("all")} />
                {tr("editor.all_approvers")}
              </label>
            </div>
          </div>
          <p className="text-xs text-neutral-400">
            {tr("editor.when_granted_the_design_locks_to_read_only_f")}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onRequestClose}>{tr("editor.cancel")}</Button>
            <Button size="sm" onClick={() => void submitRequest()} disabled={busy || selected.size === 0}>
              {busy ? <Spinner /> : tr("editor.request_approval")}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
