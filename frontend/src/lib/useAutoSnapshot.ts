// Automatic snapshot triggers (doc 16 FR-11, AC-11).
// Silently persists a deduped "auto" snapshot of the live design: a short while
// after the user goes idle following edits, at a periodic cap during long
// nonstop editing, and on tab-hidden (visibilitychange/pagehide). The tab-hidden
// flush is best-effort only: it is a plain (non-keepalive) request, so on a hard
// tab close it may be cancelled before it lands; the idle + interval-cap saves
// and the editor's beforeunload unsaved-changes guard are the real backstops.
// Client-driven because the relay server holds no folded Y.Doc to snapshot (no
// pure-Go CRDT decoder); the server dedups unchanged AUTO snapshots, so this
// never bloats history. It never toasts. The manual Save button (kind
// "checkpoint") and named checkpoints are unchanged.
//
// It also piggybacks CRDT update-log compaction (FR-11): when collaborating, at
// most every few minutes it uploads a full-state checkpoint so the server drops
// older update-log rows, keeping the history scrubber's log bounded.

import { useEffect, useRef } from "react";
import { oc } from "@/lib/sdk";
import { useEditor } from "@/store/editor";
import { usePresence } from "@/store/presence";
import { getDesignDoc } from "@/lib/useRealtime";

const IDLE_MS = 4000; // snapshot this long after the last edit
const MAX_INTERVAL_MS = 90_000; // ...and at least this often during nonstop editing
const CHECKPOINT_INTERVAL_MS = 5 * 60_000; // compact the CRDT update log at most this often
const CHECKPOINT_MAX_BYTES = 20 * 1024 * 1024 - 4096; // stay just under the server's 20MiB cap

/**
 * Drive automatic "auto"-kind snapshots off real document mutations. Pass a
 * stable-enough `onSaved` to reflect the auto-save time in the editor status;
 * it is read through a ref so the listener is installed once per design.
 */
export function useAutoSnapshot(designId: string | null, onSaved?: () => void) {
  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);

  useEffect(() => {
    if (!designId) return;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSavedAt = Date.now();
    let lastCheckpointAt = Date.now();
    let saving = false;
    let disposed = false;

    const snapshot = async () => {
      if (disposed || saving) return;
      const ed = useEditor.getState();
      if (ed.rev === ed.savedRev) return; // nothing new since the last (any) save
      if (ed.preview) return; // never snapshot a read-only history preview
      if (ed.playing) return; // never capture a transient mid-animation pose
      if (ed.manualSaving) return; // a manual Save is in flight; yield to it
      saving = true;
      const revAtSave = ed.rev;
      const doc = getDesignDoc(); // live shared Y.Doc, or null when not collaborating
      try {
        // Prefer the shared Y.Doc when realtime is live (the collaborative source
        // of truth); fall back to the local store doc otherwise. Mirrors save().
        const file = doc?.snapshot() ?? ed.doc;
        await oc.saveSnapshot(designId, { file, kind: "auto" });
        if (disposed) return;
        lastSavedAt = Date.now();
        // Mark clean only if no edits landed during the await, so we never hide a
        // genuinely-dirty state behind a stale save.
        const now = useEditor.getState();
        if (now.rev === revAtSave) now.markClean();
        onSavedRef.current?.();
        // Periodically compact the CRDT update log (FR-11): upload a full-state
        // checkpoint so the server drops older rows. Gated on SOLO (no other live
        // editors): the checkpoint is a point-in-time client capture, so a peer's
        // edit journaled during the upload could be compacted out of the scrub log;
        // compacting only when quiet avoids dropping another editor's history (the
        // log just grows during active collaboration and compacts once it settles).
        const solo = Object.keys(usePresence.getState().peers).length === 0;
        if (doc && solo && Date.now() - lastCheckpointAt > CHECKPOINT_INTERVAL_MS) {
          const cpFrame = doc.checkpointFrame(CHECKPOINT_MAX_BYTES); // null if too big to upload
          if (!cpFrame) {
            lastCheckpointAt = Date.now(); // back off so we don't re-encode a huge doc every tick
          } else {
            // Advance the throttle only on success, so a transient failure retries
            // on the next dirty save instead of waiting a full interval.
            void oc.checkpointDesign(designId, cpFrame).then(() => { lastCheckpointAt = Date.now(); }).catch(() => {});
          }
        }
      } catch {
        // Best-effort: the manual Save and the unsaved-changes unload guard stay
        // the backstop. Errors (offline, 403, brand-lock) are intentionally silent.
      } finally {
        saving = false;
      }
    };

    const scheduleIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => void snapshot(), IDLE_MS);
    };

    // Fire off real document mutations (rev bumps); ignore selection/UI changes.
    const unsub = useEditor.subscribe((s, prev) => {
      if (s.rev === prev.rev) return;
      if (Date.now() - lastSavedAt >= MAX_INTERVAL_MS) {
        void snapshot(); // interval cap during continuous editing
      } else {
        scheduleIdle();
      }
    });

    // Best-effort "last client leaves": tab hidden or page closing.
    const onHidden = () => {
      if (document.visibilityState === "hidden") void snapshot();
    };
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onHidden);

    return () => {
      disposed = true;
      if (idleTimer) clearTimeout(idleTimer);
      unsub();
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onHidden);
    };
  }, [designId]);
}
