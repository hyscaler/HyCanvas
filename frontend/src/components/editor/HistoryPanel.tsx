// The edit-history time machine (FR-9/FR-10/FR-11, AC-6/AC-7).
// A side panel listing a design's versions newest-first with author, relative
// time, kind, and label (named checkpoints highlighted). Selecting a version
// loads it READ-ONLY into the canvas behind a preview banner with Restore /
// Branch / Exit; preview never mutates the live doc or the undo stack. Restore
// applies the version as a NEW snapshot and reconciles it into the shared Y.Doc
// so peers converge; Branch forks a new design and offers to open it. Older
// history lazy-loads via the cursor. Reuses persistence's version/branch API entirely
// (oc.listVersions / versionFile / restoreVersion / branchFromVersion /
// listBranches); no history logic is duplicated here.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import {
  History,
  X,
  RotateCcw,
  GitBranch,
  Bookmark,
  Eye,
  Loader2,
  SlidersHorizontal,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import type { BranchEntry, CrdtBranch, DesignUpdateEntry, VersionEntry } from "@hc/sdk";
import { oc } from "@/lib/sdk";
import { useEditor } from "@/store/editor";
import { usePresence } from "@/store/presence";
import { applyRestoredFile, getDesignDoc, resyncFromLiveDoc } from "@/lib/useRealtime";
import { foldUpdatesToFile } from "@/lib/historyFold";
import { diffLabel } from "@hc/realtime";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { promptText } from "@/lib/promptDialog";
import { tr } from "@/lib/i18n";

// A scrub "op": consecutive updates by one author within a short window, folded
// into a single timeline stop. prefixCount is how many updates (from the start)
// to fold to reconstruct the document as it stood at the end of this group.
type ScrubOp = { authorName: string; count: number; lastSeq: number; lastMs: number; prefixCount: number };

const SCRUB_WINDOW_MS = 60_000;

// Group the raw update log into op stops so the scrubber has meaningful ticks
// (one per burst of edits) rather than one tick per micro-update. The server
// cannot label what each update changed (no Go CRDT decoder), so we group by
// author + time and show edit counts.
function groupOps(updates: DesignUpdateEntry[]): ScrubOp[] {
  const ops: ScrubOp[] = [];
  for (let i = 0; i < updates.length; i++) {
    const u = updates[i];
    const name = u.authorName || tr("editor.unknown");
    const t = new Date(u.createdAt).getTime();
    const last = ops[ops.length - 1];
    if (last && last.authorName === name && t - last.lastMs <= SCRUB_WINDOW_MS) {
      last.count++;
      last.lastSeq = u.seq;
      last.lastMs = t;
      last.prefixCount = i + 1;
    } else {
      ops.push({ authorName: name, count: 1, lastSeq: u.seq, lastMs: t, prefixCount: i + 1 });
    }
  }
  return ops;
}

/** Compact "x ago" / date for a version timestamp. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

const kindLabel = (): Record<string, string> => ({
  auto: tr("editor.auto_saved"),
  checkpoint: tr("editor.saved_2"),
  named: tr("editor.checkpoint"),
  restore: tr("editor.restored"),
  branch: tr("editor.branched"),
});

function authorName(v: VersionEntry): string {
  return v.author?.name ?? tr("editor.unknown");
}

/** The History side panel. `designId` is the live design; null disables it. */
export function HistoryPanel({
  designId,
  workspaceId,
  onClose,
}: {
  designId: string;
  workspaceId: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const enterPreview = useEditor((s) => s.enterPreview);
  const exitPreview = useEditor((s) => s.exitPreview);
  const preview = useEditor((s) => s.preview);

  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [branches, setBranches] = useState<BranchEntry[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  // CRDT scrubber (FR-9): the raw update log, grouped into op stops. Loaded
  // lazily when the scrubber is opened. scrubIndex null = live/now.
  const [updates, setUpdates] = useState<DesignUpdateEntry[]>([]);
  // In-CRDT branches (FR-10): the design's named live branches plus the active
  // one (presence store; switching rebinds the realtime session to the branch's
  // own room and lineage).
  const activeBranch = usePresence((st) => st.branch);
  const [crdtBranches, setCrdtBranches] = useState<CrdtBranch[]>([]);
  const [scrubOpen, setScrubOpen] = useState(false);
  const [scrubLoading, setScrubLoading] = useState(false);
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const [scrubFile, setScrubFile] = useState<ReturnType<typeof foldUpdatesToFile> | null>(null);
  // Semantic label for the scrubbed op ("Moved 3 elements"), keyed to its op
  // index so the debounced fold can't show a stale label for a different stop.
  const [scrubLabel, setScrubLabel] = useState<{ idx: number; text: string } | null>(null);
  // True when the log exceeded the page cap: we hold only the OLDEST frames, so
  // the newest edits are missing. The right end is then NOT live, and restoring
  // from a scrub point is unsafe (it would fold a stale prefix).
  const [truncated, setTruncated] = useState(false);
  const scrubLoaded = useRef(false);
  const scrubTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ops = useMemo(() => groupOps(updates), [updates]);

  useEffect(() => () => { if (scrubTimer.current) clearTimeout(scrubTimer.current); }, []);

  // Whenever the preview ends by ANY route (the in-canvas PreviewBanner Exit, not
  // just the panel footer), drop the panel's local selection so a stale version
  // highlight / scrubber position can't linger out of sync with the live doc.
  // Subscribe to the store (allowed setState-in-callback) so this fires exactly on
  // the preview->null transition, not synchronously in the effect body.
  useEffect(() => {
    return useEditor.subscribe((s, prev) => {
      if (prev.preview && !s.preview) {
        setActiveId(null);
        setScrubIndex(null);
        setScrubFile(null);
      }
    });
  }, []);

  // Refresh the in-CRDT branch list (after creating one; the mount effect
  // below fetches the initial list alongside versions and forks).
  const loadCrdtBranches = useCallback(async () => {
    try {
      setCrdtBranches(await oc.listCrdtBranches(designId));
    } catch {
      setCrdtBranches([]); // non-fatal: the section just hides
    }
  }, [designId]);

  const MAX_PAGES = 40;
  const loadUpdates = useCallback(async (branchArg: string | null = activeBranch) => {
    setScrubLoading(true);
    try {
      const all: DesignUpdateEntry[] = [];
      let after: number | undefined = undefined;
      let wasTruncated = false;
      // Page forward (oldest-first); cap pages so an enormous log can't hang the
      // panel. If the cap is hit with more rows remaining, we are missing the
      // NEWEST edits -> mark truncated so the UI never presents the end as live.
      for (let page = 0; page < MAX_PAGES; page++) {
        // On a branch, the timeline is the BRANCH lineage (parent prefix up to
        // the fork + the branch's own edits), same fold, same cursor.
        const res = await oc.designUpdates(designId, after, 0, branchArg ?? undefined);
        all.push(...res.items);
        if (!res.nextSeq) break;
        after = res.nextSeq;
        if (page === MAX_PAGES - 1) wasTruncated = true; // more pages exist past the cap
      }
      setUpdates(all);
      setTruncated(wasTruncated);
      scrubLoaded.current = true;
      if (wasTruncated) toast.toast("Timeline is long; showing the oldest edits. Scrub-restore is disabled here.", "info");
    } catch {
      toast.error(tr("editor.could_not_load_the_timeline"));
    } finally {
      setScrubLoading(false);
    }
  }, [designId, toast, activeBranch]);

  function toggleScrub() {
    const next = !scrubOpen;
    setScrubOpen(next);
    if (next && !scrubLoaded.current && !scrubLoading) void loadUpdates();
  }


  // Fold the update prefix up to a stop and preview it read-only; null = live.
  // Folding is client-side (Yjs); re-folds the prefix each commit (fine for
  // typical logs, a future optimization can fold incrementally).
  const commitScrub = useCallback(
    (idx: number | null) => {
      if (idx === null || idx >= ops.length) {
        // Reaching the live end means the user wants the live doc: exit ANY active
        // preview (version or scrub) and clear its selection, so the canvas matches
        // the "Now (live)" label rather than staying on a previewed version.
        if (preview) {
          exitPreview();
          resyncFromLiveDoc();
          setActiveId(null);
        }
        setScrubFile(null);
        return;
      }
      const op = ops[idx];
      const prefix = updates.slice(0, op.prefixCount).map((u) => u.update);
      try {
        const file = foldUpdatesToFile(prefix);
        if (!file?.pages?.length) {
          toast.error(tr("editor.nothing_to_preview_that_early_in_history"));
          return;
        }
        setActiveId(null);
        setScrubFile(file); // kept so this point can be restored as a new version
        enterPreview(file, `${op.authorName} · ${relativeTime(new Date(op.lastMs).toISOString())}`);
        // Semantic label (FR-9): diff the folded state against the previous op
        // boundary (empty design for the first op) to say what actually changed.
        try {
          const prevCount = idx > 0 ? ops[idx - 1].prefixCount : 0;
          const before = prevCount > 0
            ? foldUpdatesToFile(updates.slice(0, prevCount).map((u) => u.update))
            : ({ schemaVersion: file.schemaVersion, pages: [] } as unknown as typeof file);
          setScrubLabel({ idx, text: diffLabel(before, file) });
        } catch {
          setScrubLabel(null);
        }
      } catch {
        toast.error(tr("editor.could_not_reconstruct_that_point_in_history"));
      }
    },
    [ops, updates, preview, exitPreview, enterPreview, toast],
  );

  function onScrub(v: number) {
    const idx = v >= ops.length ? null : v;
    setScrubIndex(idx);
    if (scrubTimer.current) clearTimeout(scrubTimer.current);
    scrubTimer.current = setTimeout(() => commitScrub(idx), 140);
  }

  const loadPage = useCallback(
    async (c?: string) => {
      setLoading(true);
      try {
        const page = await oc.listVersions(designId, c);
        setVersions((prev) => (c ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
        setHasMore(!!page.nextCursor);
      } catch {
        toast.error(tr("editor.could_not_load_history"));
      } finally {
        setLoading(false);
      }
    },
    [designId, toast],
  );

  // Initial load (and branch list) for the open design. Fetch in an async IIFE
  // so no setState fires synchronously in the effect body.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [page, branchList, crdtList] = await Promise.all([
        oc.listVersions(designId).catch(() => null),
        oc.listBranches(designId).catch(() => []),
        oc.listCrdtBranches(designId).catch(() => []),
      ]);
      if (cancelled) return;
      if (page) {
        setVersions(page.items);
        setCursor(page.nextCursor);
        setHasMore(!!page.nextCursor);
      } else {
        toast.error(tr("editor.could_not_load_history"));
      }
      setBranches(branchList);
      setCrdtBranches(crdtList);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [designId, toast]);

  // Selecting a version previews it read-only (AC-6).
  async function previewVersion(v: VersionEntry) {
    if (busyId) return;
    setBusyId(v.id);
    try {
      const file = await oc.versionFile(designId, v.id);
      const when = relativeTime(v.createdAt);
      enterPreview(file, `${when} by ${authorName(v)}`);
      setActiveId(v.id);
    } catch {
      toast.error(tr("editor.could_not_load_that_version"));
    } finally {
      setBusyId(null);
    }
  }

  // Restore the previewed version as a NEW snapshot, then make it the live doc
  // (reconciled into the shared Y.Doc when connected) (AC-7).
  async function restore() {
    // Defense in depth: restore rotates the design's CURRENT (main) file and is
    // gated in the UI while a branch session is active.
    if (usePresence.getState().branch) return;
    if (!activeId) return;
    setBusyId(activeId);
    try {
      // Safety net: edits made after the last auto-save exist only in memory;
      // land them as a version first so the restore never silently discards
      // work. Prefer the live shared Y.Doc (peers may have edited during the
      // preview) over the point-in-time stash. The server dedupes an unchanged
      // AUTO save. If this save FAILS (offline, brand lock), abort the restore:
      // proceeding would discard the only copy of that work.
      const live = getDesignDoc()?.snapshot() ?? useEditor.getState().preview?.live;
      if (live?.pages?.length) {
        try {
          await oc.saveSnapshot(designId, { file: live, kind: "auto" });
        } catch {
          toast.error(tr("editor.couldnt_back_up_your_latest_edits_so_the_res"));
          return;
        }
      }
      await oc.restoreVersion(designId, activeId);
      const file = await oc.getDesignFile(designId);
      applyRestoredFile(file);
      setActiveId(null);
      await loadPage(undefined); // the restore added a new version
      toast.success(tr("editor.restored_this_is_now_the_current_version"));
    } catch {
      toast.error(tr("editor.restore_failed"));
    } finally {
      setBusyId(null);
    }
  }

  // Branch the previewed version into a new design (AC-7), then offer to open it.
  async function branch() {
    if (!activeId) return;
    const name = await promptText({
      title: tr("editor.branch_from_this_version"),
      label: tr("editor.name_the_new_branch"),
      placeholder: tr("editor.variation"),
      confirmText: tr("editor.create_branch"),
    });
    if (name === null) return;
    setBusyId(activeId);
    try {
      const created = await oc.branchFromVersion(designId, activeId, name || undefined);
      setBranches(await oc.listBranches(designId).catch(() => branches));
      toast.success(tr("editor.branch_created"));
      void router.push(`/editor?id=${created.id}`);
    } catch {
      toast.error(tr("editor.branch_failed"));
    } finally {
      setBusyId(null);
    }
  }

  function exit() {
    exitPreview();
    resyncFromLiveDoc(); // return to the true live state (incl. peer edits)
    setActiveId(null);
    setScrubIndex(null);
    setScrubFile(null);
  }

  // Switch the live session to a branch lineage (null = main). The realtime
  // hook rebinds (own room + IndexedDB namespace) and seeds the doc from the
  // branch's folded journal; any preview or scrub state belongs to the old
  // lineage and is dropped.
  function switchBranch(id: string | null) {
    if (id === activeBranch) return;
    if (preview) {
      exitPreview();
    }
    // The loaded timeline and any scrub preview belong to the OLD lineage.
    setActiveId(null);
    setScrubIndex(null);
    setScrubFile(null);
    setScrubLabel(null);
    setUpdates([]);
    setTruncated(false);
    scrubLoaded.current = false;
    usePresence.getState().setBranch(id);
    if (scrubOpen) void loadUpdates(id); // refetch the new lineage in place
    toast.success(id ? tr("editor.switched_to_the_branch_edits_now_stay_on_it") : tr("editor.back_on_the_main_lineage"));
  }

  // Fork a named in-CRDT branch at the scrubbed point (FR-10) and switch to it.
  // Never touches existing history: main keeps every row, the branch adds its
  // own from here on.
  async function branchFromScrub() {
    if (scrubIndex === null || !ops[scrubIndex] || truncated || busyId) return;
    const name = await promptText({
      title: tr("editor.branch_from_here"),
      label: tr("editor.branch_name"),
      placeholder: tr("editor.big_rework_idea"),
      confirmText: tr("editor.create_branch"),
    });
    if (!name) return;
    setBusyId("scrub-branch");
    try {
      const created = await oc.createCrdtBranch(designId, {
        name,
        forkedFromSeq: ops[scrubIndex].lastSeq,
        ...(activeBranch ? { parentBranchId: activeBranch } : {}),
      });
      await loadCrdtBranches();
      switchBranch(created.id);
    } catch {
      toast.error(tr("editor.could_not_create_the_branch"));
    } finally {
      setBusyId(null);
    }
  }

  // Restore the currently-scrubbed point as a NEW snapshot (non-destructive,
  // AC-7), then make it live. Unlike version restore there is no versionId: we
  // persist the folded file directly (kind "restore") and reconcile it in.
  async function restoreScrub() {
    // Never restore from a truncated timeline: scrubFile is folded from a stale
    // prefix (newest edits not loaded), so persisting it would roll the doc back.
    // And never from a BRANCH session: restore rotates the design's CURRENT
    // (main) file, which must never receive branch-lineage state.
    if (!scrubFile || busyId || truncated || activeBranch) return;
    setBusyId("scrub");
    try {
      await oc.saveSnapshot(designId, { file: scrubFile, kind: "restore", label: tr("editor.restored_from_history") });
      const current = await oc.getDesignFile(designId);
      applyRestoredFile(current);
      exitPreview();
      setActiveId(null);
      setScrubIndex(null);
      setScrubFile(null);
      await loadPage(undefined); // the restore added a new version
      scrubLoaded.current = false; // the timeline gained an entry; reload if open
      if (scrubOpen) void loadUpdates();
      toast.success(tr("editor.restored_this_is_now_the_current_version"));
    } catch {
      toast.error(tr("editor.restore_failed"));
    } finally {
      setBusyId(null);
    }
  }

  // Save a named checkpoint of the CURRENT live state (AC-6), not a preview.
  async function saveCheckpoint() {
    if (preview) return; // never checkpoint a preview
    if (activeBranch) return; // a named snapshot is main-lineage state; gated in the UI too
    const label = await promptText({
      title: tr("editor.save_a_checkpoint"),
      label: tr("editor.name_this_version"),
      placeholder: tr("editor.client_approved"),
      confirmText: tr("editor.save_checkpoint"),
    });
    if (!label) return;
    try {
      const file = useEditor.getState().doc;
      await oc.saveSnapshot(designId, { file, kind: "named", label });
      await loadPage(undefined);
      toast.success(tr("editor.checkpoint_saved"));
    } catch {
      toast.error(tr("editor.could_not_save_checkpoint"));
    }
  }

  return (
    <aside className="oc-scroll flex w-80 shrink-0 flex-col overflow-y-auto border-s border-neutral-200 bg-surface">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-neutral-200 bg-surface px-3 py-2.5">
        <History size={18} className="text-brand-ink" />
        <h2 className="text-sm font-semibold text-neutral-800">{tr("editor.version_history")}</h2>
        <IconButton aria-label={tr("editor.close_history")} onClick={onClose} className="ms-auto">
          <X size={18} />
        </IconButton>
      </header>

      <div className="border-b border-neutral-100 p-3">
        <Button
          variant="secondary"
          size="sm"
          block
          onClick={() => void saveCheckpoint()}
          disabled={!!preview || !!activeBranch}
          title={
            activeBranch
              ? "Checkpoints capture the main lineage; switch back to Main first"
              : preview
                ? tr("editor.exit_preview_to_save_a_checkpoint")
                : tr("editor.save_a_named_checkpoint_of_the_current_versi")
          }
        >
          <Bookmark size={16} /> {tr("editor.save_checkpoint")}
        </Button>
      </div>

      {/* CRDT scrubber (FR-9): drag through the live edit log; the canvas
          previews the folded state read-only. */}
      <div className="border-b border-neutral-100 p-3">
        <button
          onClick={toggleScrub}
          className="flex w-full items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-400 transition hover:text-neutral-600"
        >
          <SlidersHorizontal size={13} /> Scrub timeline
          {scrubOpen ? <ChevronUp size={14} className="ms-auto" /> : <ChevronDown size={14} className="ms-auto" />}
        </button>
        {scrubOpen && (
          <div className="mt-3">
            {scrubLoading ? (
              <div className="flex items-center gap-2 py-1 text-xs text-neutral-400">
                <Loader2 size={14} className="animate-spin" /> {tr("editor.loading_timeline")}
              </div>
            ) : ops.length === 0 ? (
              <p className="py-1 text-xs text-neutral-400">
                {tr("editor.no_live_edits_recorded_yet_edits_made_with_t")}
              </p>
            ) : (
              <>
                <input
                  type="range"
                  min={0}
                  max={ops.length}
                  step={1}
                  value={scrubIndex ?? ops.length}
                  onChange={(e) => onScrub(Number(e.target.value))}
                  className="w-full accent-brand-600"
                  aria-label={tr("editor.scrub_edit_history")}
                />
                <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-neutral-500">
                  <span className="shrink-0">{ops.length} edit {ops.length === 1 ? "burst" : "bursts"}</span>
                  <span className="truncate text-end">
                    {scrubIndex === null || !ops[scrubIndex]
                      ? truncated
                        ? tr("editor.latest_loaded_older_edits_only")
                        : tr("editor.now_live")
                      : `${ops[scrubIndex].authorName} · ${
                          scrubLabel && scrubLabel.idx === scrubIndex && scrubLabel.text
                            ? scrubLabel.text
                            : `${ops[scrubIndex].count} edit${ops[scrubIndex].count > 1 ? "s" : ""}`
                        } · ${relativeTime(new Date(ops[scrubIndex].lastMs).toISOString())}`}
                  </span>
                </div>
                {truncated && (
                  <p className="mt-1.5 text-[11px] text-amber-700">
                    {tr("editor.history_truncated_notice")}
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {(crdtBranches.length > 0 || activeBranch) && (
        <div className="border-b border-neutral-100 p-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-400">
            <GitBranch size={13} /> {tr("editor.branches")}
          </p>
          <ul className="flex flex-col gap-1">
            <li>
              <button
                onClick={() => switchBranch(null)}
                className={`w-full truncate rounded-lg px-2 py-1.5 text-start text-sm transition ${
                  activeBranch === null ? "bg-brand-50 font-semibold text-brand-ink ring-1 ring-brand-200" : "text-neutral-700 hover:bg-neutral-100"
                }`}
                title={tr("editor.the_designs_main_lineage")}
              >
                {tr("editor.main")}
              </button>
            </li>
            {crdtBranches.map((b) => (
              <li key={b.id}>
                <button
                  onClick={() => switchBranch(b.id)}
                  className={`w-full truncate rounded-lg px-2 py-1.5 text-start text-sm transition ${
                    activeBranch === b.id ? "bg-brand-50 font-semibold text-brand-ink ring-1 ring-brand-200" : "text-neutral-700 hover:bg-neutral-100"
                  }`}
                  title={`Switch to branch "${b.name}" (its own live session and history)`}
                >
                  {b.name}
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-neutral-400">
            {tr("editor.branches_hint")}
          </p>
        </div>
      )}

      {branches.length > 0 && (
        <div className="border-b border-neutral-100 p-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-400">
            <GitBranch size={13} /> {tr("editor.forked_designs")}
          </p>
          <ul className="flex flex-col gap-1">
            {branches.map((b) => (
              <li key={b.id}>
                <button
                  onClick={() => void router.push(`/editor?id=${b.id}`)}
                  className="w-full truncate rounded-lg px-2 py-1.5 text-start text-sm text-neutral-700 hover:bg-neutral-100"
                  title={`Open branch "${b.title}"`}
                >
                  {b.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ol className="flex flex-1 flex-col p-2">
        {versions.length === 0 && !loading && (
          <li className="px-3 py-8 text-center text-sm text-neutral-400">{tr("editor.history_starts_here")}</li>
        )}
        {versions.map((v) => {
          const named = v.kind === "named";
          const isActive = v.id === activeId;
          return (
            <li key={v.id}>
              <button
                onClick={() => void previewVersion(v)}
                disabled={!!busyId}
                className={`flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-start transition hover:bg-neutral-100 ${
                  isActive ? "bg-brand-50 ring-1 ring-brand-200" : ""
                }`}
              >
                <span
                  className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-[10px] font-semibold ${
                    named ? "bg-amber-100 text-amber-700" : "bg-neutral-100 text-neutral-500"
                  }`}
                  aria-hidden
                >
                  {named ? <Bookmark size={13} /> : authorName(v).slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className={`truncate text-sm ${named ? "font-semibold text-neutral-900" : "font-medium text-neutral-700"}`}>
                      {v.label ?? kindLabel()[v.kind ?? "checkpoint"] ?? tr("editor.version")}
                    </span>
                    {busyId === v.id && <Loader2 size={13} className="animate-spin text-neutral-400" />}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-neutral-400">
                    {authorName(v)} · {relativeTime(v.createdAt)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
        {hasMore && (
          <li className="px-2 py-2">
            <Button
              variant="ghost"
              size="sm"
              block
              onClick={() => void loadPage(cursor)}
              disabled={loading}
            >
              {loading ? tr("editor.loading") : tr("editor.load_older_versions")}
            </Button>
          </li>
        )}
      </ol>

      {/* Preview controls live in the in-canvas banner (PreviewBanner); the panel
          surfaces the same actions here for discoverability when previewing. */}
      {preview && (
        <footer className="sticky bottom-0 border-t border-neutral-200 bg-surface p-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs text-neutral-500">
            <Eye size={13} /> {activeId ? tr("editor.previewing_a_past_version_read_only") : tr("editor.scrubbing_history_read_only")}
          </p>
          {activeId ? (
            <>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => void restore()}
                  disabled={!!busyId || !!activeBranch}
                  title={activeBranch ? "Restore targets the main lineage; switch back to Main first" : tr("editor.make_this_the_current_version")}
                >
                  <RotateCcw size={15} /> {tr("editor.restore")}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => void branch()} disabled={!!busyId} title={tr("editor.create_a_branch_from_here")}>
                  <GitBranch size={15} /> {tr("editor.branch")}
                </Button>
                <Button variant="ghost" size="sm" onClick={exit} disabled={!!busyId}>
                  {tr("editor.exit")}
                </Button>
              </div>
              {!workspaceId && <p className="mt-1 text-[11px] text-neutral-400">{tr("editor.branching_needs_a_saved_design")}</p>}
            </>
          ) : (
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => void restoreScrub()}
                disabled={!!busyId || !scrubFile || truncated || !!activeBranch}
                title={
                  activeBranch
                    ? "Restore targets the main lineage; switch back to Main first"
                    : truncated
                      ? tr("editor.restore_is_disabled_on_a_truncated_timeline")
                      : tr("editor.make_this_point_the_current_version")
                }
              >
                <RotateCcw size={15} /> {tr("editor.restore")}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void branchFromScrub()}
                disabled={!!busyId || scrubIndex === null || truncated}
                title={truncated ? tr("editor.branching_is_disabled_on_a_truncated_timelin") : "Fork a named branch at this point (FR-10); nothing is discarded"}
              >
                <GitBranch size={15} /> {tr("editor.branch_from_here")}
              </Button>
              <Button variant="ghost" size="sm" onClick={exit} disabled={!!busyId}>
                {tr("editor.return_to_now")}
              </Button>
            </div>
          )}
        </footer>
      )}
    </aside>
  );
}
