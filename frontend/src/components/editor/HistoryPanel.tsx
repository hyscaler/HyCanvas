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
import type { BranchEntry, DesignUpdateEntry, VersionEntry } from "@hc/sdk";
import { oc } from "@/lib/sdk";
import { useEditor } from "@/store/editor";
import { applyRestoredFile, resyncFromLiveDoc } from "@/lib/useRealtime";
import { foldUpdatesToFile } from "@/lib/historyFold";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { promptText } from "@/lib/promptDialog";

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
    const name = u.authorName || "Unknown";
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

const KIND_LABEL: Record<string, string> = {
  auto: "Auto-saved",
  checkpoint: "Saved",
  named: "Checkpoint",
  restore: "Restored",
  branch: "Branched",
};

function authorName(v: VersionEntry): string {
  return v.author?.name ?? "Unknown";
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
  const [scrubOpen, setScrubOpen] = useState(false);
  const [scrubLoading, setScrubLoading] = useState(false);
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const [scrubFile, setScrubFile] = useState<ReturnType<typeof foldUpdatesToFile> | null>(null);
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

  const MAX_PAGES = 40;
  const loadUpdates = useCallback(async () => {
    setScrubLoading(true);
    try {
      const all: DesignUpdateEntry[] = [];
      let after: number | undefined = undefined;
      let wasTruncated = false;
      // Page forward (oldest-first); cap pages so an enormous log can't hang the
      // panel. If the cap is hit with more rows remaining, we are missing the
      // NEWEST edits -> mark truncated so the UI never presents the end as live.
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await oc.designUpdates(designId, after);
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
      toast.error("Could not load the timeline.");
    } finally {
      setScrubLoading(false);
    }
  }, [designId, toast]);

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
          toast.error("Nothing to preview that early in history.");
          return;
        }
        setActiveId(null);
        setScrubFile(file); // kept so this point can be restored as a new version
        enterPreview(file, `${op.authorName} · ${relativeTime(new Date(op.lastMs).toISOString())}`);
      } catch {
        toast.error("Could not reconstruct that point in history.");
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
        toast.error("Could not load history.");
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
      const [page, branchList] = await Promise.all([
        oc.listVersions(designId).catch(() => null),
        oc.listBranches(designId).catch(() => []),
      ]);
      if (cancelled) return;
      if (page) {
        setVersions(page.items);
        setCursor(page.nextCursor);
        setHasMore(!!page.nextCursor);
      } else {
        toast.error("Could not load history.");
      }
      setBranches(branchList);
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
      toast.error("Could not load that version.");
    } finally {
      setBusyId(null);
    }
  }

  // Restore the previewed version as a NEW snapshot, then make it the live doc
  // (reconciled into the shared Y.Doc when connected) (AC-7).
  async function restore() {
    if (!activeId) return;
    setBusyId(activeId);
    try {
      await oc.restoreVersion(designId, activeId);
      const file = await oc.getDesignFile(designId);
      applyRestoredFile(file);
      setActiveId(null);
      await loadPage(undefined); // the restore added a new version
      toast.success("Restored. This is now the current version.");
    } catch {
      toast.error("Restore failed.");
    } finally {
      setBusyId(null);
    }
  }

  // Branch the previewed version into a new design (AC-7), then offer to open it.
  async function branch() {
    if (!activeId) return;
    const name = await promptText({
      title: "Branch from this version",
      label: "Name the new branch",
      placeholder: "Variation",
      confirmText: "Create branch",
    });
    if (name === null) return;
    setBusyId(activeId);
    try {
      const created = await oc.branchFromVersion(designId, activeId, name || undefined);
      setBranches(await oc.listBranches(designId).catch(() => branches));
      toast.success("Branch created.");
      void router.push(`/editor?id=${created.id}`);
    } catch {
      toast.error("Branch failed.");
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

  // Restore the currently-scrubbed point as a NEW snapshot (non-destructive,
  // AC-7), then make it live. Unlike version restore there is no versionId: we
  // persist the folded file directly (kind "restore") and reconcile it in.
  async function restoreScrub() {
    // Never restore from a truncated timeline: scrubFile is folded from a stale
    // prefix (newest edits not loaded), so persisting it would roll the doc back.
    if (!scrubFile || busyId || truncated) return;
    setBusyId("scrub");
    try {
      await oc.saveSnapshot(designId, { file: scrubFile, kind: "restore", label: "Restored from history" });
      const current = await oc.getDesignFile(designId);
      applyRestoredFile(current);
      exitPreview();
      setActiveId(null);
      setScrubIndex(null);
      setScrubFile(null);
      await loadPage(undefined); // the restore added a new version
      scrubLoaded.current = false; // the timeline gained an entry; reload if open
      if (scrubOpen) void loadUpdates();
      toast.success("Restored. This is now the current version.");
    } catch {
      toast.error("Restore failed.");
    } finally {
      setBusyId(null);
    }
  }

  // Save a named checkpoint of the CURRENT live state (AC-6), not a preview.
  async function saveCheckpoint() {
    if (preview) return; // never checkpoint a preview
    const label = await promptText({
      title: "Save a checkpoint",
      label: "Name this version",
      placeholder: "Client approved",
      confirmText: "Save checkpoint",
    });
    if (!label) return;
    try {
      const file = useEditor.getState().doc;
      await oc.saveSnapshot(designId, { file, kind: "named", label });
      await loadPage(undefined);
      toast.success("Checkpoint saved.");
    } catch {
      toast.error("Could not save checkpoint.");
    }
  }

  return (
    <aside className="oc-scroll flex w-80 shrink-0 flex-col overflow-y-auto border-l border-neutral-200 bg-white">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-neutral-200 bg-white px-3 py-2.5">
        <History size={18} className="text-brand-600" />
        <h2 className="text-sm font-semibold text-neutral-800">Version history</h2>
        <IconButton aria-label="Close history" onClick={onClose} className="ml-auto">
          <X size={18} />
        </IconButton>
      </header>

      <div className="border-b border-neutral-100 p-3">
        <Button
          variant="secondary"
          size="sm"
          block
          onClick={() => void saveCheckpoint()}
          disabled={!!preview}
          title={preview ? "Exit preview to save a checkpoint" : "Save a named checkpoint of the current version"}
        >
          <Bookmark size={16} /> Save checkpoint
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
          {scrubOpen ? <ChevronUp size={14} className="ml-auto" /> : <ChevronDown size={14} className="ml-auto" />}
        </button>
        {scrubOpen && (
          <div className="mt-3">
            {scrubLoading ? (
              <div className="flex items-center gap-2 py-1 text-xs text-neutral-400">
                <Loader2 size={14} className="animate-spin" /> Loading timeline…
              </div>
            ) : ops.length === 0 ? (
              <p className="py-1 text-xs text-neutral-400">
                No live edits recorded yet. Edits made with the realtime connection on build a scrubbable timeline.
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
                  aria-label="Scrub edit history"
                />
                <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-neutral-500">
                  <span className="shrink-0">{ops.length} edit {ops.length === 1 ? "burst" : "bursts"}</span>
                  <span className="truncate text-right">
                    {scrubIndex === null || !ops[scrubIndex]
                      ? truncated
                        ? "Latest loaded (older edits only)"
                        : "Now (live)"
                      : `${ops[scrubIndex].authorName} · ${ops[scrubIndex].count} edit${ops[scrubIndex].count > 1 ? "s" : ""} · ${relativeTime(new Date(ops[scrubIndex].lastMs).toISOString())}`}
                  </span>
                </div>
                {truncated && (
                  <p className="mt-1.5 text-[11px] text-amber-600">
                    History is long; only the oldest edits are loaded, so the newest state isn&apos;t shown here and restoring from this timeline is disabled.
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {branches.length > 0 && (
        <div className="border-b border-neutral-100 p-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-400">
            <GitBranch size={13} /> Branches
          </p>
          <ul className="flex flex-col gap-1">
            {branches.map((b) => (
              <li key={b.id}>
                <button
                  onClick={() => void router.push(`/editor?id=${b.id}`)}
                  className="w-full truncate rounded-lg px-2 py-1.5 text-left text-sm text-neutral-700 hover:bg-neutral-100"
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
          <li className="px-3 py-8 text-center text-sm text-neutral-400">History starts here.</li>
        )}
        {versions.map((v) => {
          const named = v.kind === "named";
          const isActive = v.id === activeId;
          return (
            <li key={v.id}>
              <button
                onClick={() => void previewVersion(v)}
                disabled={!!busyId}
                className={`flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition hover:bg-neutral-100 ${
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
                      {v.label ?? KIND_LABEL[v.kind ?? "checkpoint"] ?? "Version"}
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
              {loading ? "Loading…" : "Load older versions"}
            </Button>
          </li>
        )}
      </ol>

      {/* Preview controls live in the in-canvas banner (PreviewBanner); the panel
          surfaces the same actions here for discoverability when previewing. */}
      {preview && (
        <footer className="sticky bottom-0 border-t border-neutral-200 bg-white p-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs text-neutral-500">
            <Eye size={13} /> {activeId ? "Previewing a past version (read-only)" : "Scrubbing history (read-only)"}
          </p>
          {activeId ? (
            <>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => void restore()} disabled={!!busyId} title="Make this the current version">
                  <RotateCcw size={15} /> Restore
                </Button>
                <Button variant="secondary" size="sm" onClick={() => void branch()} disabled={!!busyId} title="Create a branch from here">
                  <GitBranch size={15} /> Branch
                </Button>
                <Button variant="ghost" size="sm" onClick={exit} disabled={!!busyId}>
                  Exit
                </Button>
              </div>
              {!workspaceId && <p className="mt-1 text-[11px] text-neutral-400">Branching needs a saved design.</p>}
            </>
          ) : (
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => void restoreScrub()}
                disabled={!!busyId || !scrubFile || truncated}
                title={truncated ? "Restore is disabled on a truncated timeline (the newest edits aren't loaded)" : "Make this point the current version"}
              >
                <RotateCcw size={15} /> Restore
              </Button>
              <Button variant="ghost" size="sm" onClick={exit} disabled={!!busyId}>
                Return to now
              </Button>
            </div>
          )}
        </footer>
      )}
    </aside>
  );
}
