// Wires the realtime presence client into the editor for one design.
// Connects on design load, disconnects on unmount/route change, feeds
// local selection + viewport as presence, and drives follow mode (AC-5): while
// following a peer, mirror their viewport on every update; break off as soon as
// the local user pans/zooms themselves or presses Esc.
//
// Cursor presence is fed separately by the Canvas (it owns the screen->page
// conversion); this hook exposes the live client via a module ref so the Canvas
// can push cursor frames without prop-drilling.

import { useEffect, useRef } from "react";
import type { DesignFile } from "@hc/schema";
import { connectRealtime, type RealtimeClient } from "@/lib/realtime";
import { DesignDoc } from "@/lib/ydoc";
import { oc } from "@/lib/sdk";
import { useEditor } from "@/store/editor";
import { usePresence } from "@/store/presence";

// The single active client, shared with the Canvas overlay for cursor frames.
let activeClient: RealtimeClient | null = null;
// The single active per-design Y.Doc binding (slice B), exposed so the editor
// shell can snapshot the live shared state when the user hits Save.
let activeDoc: DesignDoc | null = null;

/** The current realtime client, or null when realtime is not connected. */
export function getRealtimeClient(): RealtimeClient | null {
  return activeClient;
}

/**
 * Place a collaborative lock on the current editor selection via
 * the active realtime client. No-op when offline / on the unsaved local doc
 * (there is no client to send through and no peers to lock against).
 */
export function lockSelection(): void {
  const ids = useEditor.getState().selection;
  if (ids.length) activeClient?.sendLock(ids);
}

/** Release the collaborative lock on the current selection (only ids this client
 *  holds are dropped server-side). No-op when offline / on the local doc. */
export function unlockSelection(): void {
  const ids = useEditor.getState().selection;
  if (ids.length) activeClient?.sendUnlock(ids);
}

/** The live collaborative document binding, or null when not connected.
 *  Also null before the doc has any state: until initial sync lands (or when
 *  realtime never connects), the Y.Doc is empty and snapshotting it would
 *  produce a blank zero-page file that the server rightly rejects (422), so
 *  callers must keep using the REST-loaded store doc instead. */
export function getDesignDoc(): DesignDoc | null {
  return activeDoc?.hasState ? activeDoc : null;
}

/**
 * Apply a restored historical version as the live document.
 * Restore is always a NEW server snapshot already; here we make that restored
 * file the live editing state. When realtime is connected, reconcile it into the
 * shared Y.Doc (minimal ops under the local origin) so every peer converges on
 * the restored state; otherwise just load it into the local store. Either way it
 * starts a fresh editing session (cleared undo), never discarding the snapshot.
 */
export function applyRestoredFile(file: DesignFile): void {
  // Always end any preview and reset the local editing doc first.
  useEditor.getState().exitPreview();
  useEditor.getState().loadDoc(file);
  // Then, if connected AND synced, push it into the shared doc so peers see the
  // restore. Pre-sync the room must stay authoritative: reconciling into an
  // empty Y.Doc would mint a divergent CRDT identity space that merges into
  // duplicates once server state arrives (the restore already persisted a
  // server snapshot, so a later room seed converges on it anyway).
  if (activeDoc?.hasState) activeDoc.replaceDoc(file);
}

/**
 * Resync the local store from the live Y.Doc after leaving a history preview
 *. While previewing, peer edits accumulated in the Y.Doc but were not
 * applied to the store; calling this rebuilds the store from the authoritative
 * shared state so the user returns to the true current document, not a stale
 * stash. No-op when not connected (the store's stashed live doc is correct).
 */
export function resyncFromLiveDoc(): void {
  const doc = activeDoc;
  if (!doc?.hasState) return; // an unsynced doc would clobber the store with a blank file
  useEditor.getState().loadDoc(doc.snapshot());
}

/**
 * Connect realtime for `designId` (no-op when null, i.e. the unsaved local doc).
 * Returns nothing; reads/writes the editor + presence stores directly.
 */
export function useRealtime(designId: string | null): void {
  // Set true for exactly the duration of a programmatic viewport mirror (following
  // a peer), so the editor-store subscription can tell that synchronous change
  // apart from a genuine user pan/zoom that should break follow. A boolean flag
  // (not a value match) is robust when setViewport CLAMPS the zoom, which would
  // otherwise make the committed viewport differ from the value we recorded.
  const mirroring = useRef(false);

  // Connect / disconnect on design id OR branch change. Slice B: stand up the
  // per-design Y.Doc binding (store bridge), then open the socket carrying both
  // presence and Yjs sync. The server room Y.Doc is authoritative and is seeded
  // from the latest persisted snapshot, so the client does NOT independently
  // reconcile the REST-loaded file into the Y.Doc: doing so would create a
  // second, divergent set of CRDT items that merge into duplicate pages/nodes
  // once sync step 2 lands. The editor still renders immediately from the REST
  // file already in the store; Yjs sync then rebuilds `store.doc` from the
  // shared server state.
  //
  // BRANCH sessions (doc 16 FR-10): switching the presence store's `branch`
  // tears this binding down and rebinds against the branch's own room and
  // IndexedDB namespace, then seeds the fresh doc from the branch's journaled
  // lineage (paged from the server and applied like inbound sync). The seed is
  // CRDT-idempotent against room sync and offline state, so racing them is
  // safe; the store rebuilds from the doc as the frames land.
  const branch = usePresence((s) => s.branch);
  const lastDesign = useRef<string | null>(null);
  // Set when this rebind is a lineage SWITCH within one design (as opposed to
  // first open), which is exactly when the store holds the wrong document.
  const lastBranch = useRef<string | null>(null);
  const switchedLineage = useRef(false);
  useEffect(() => {
    if (!designId) return;
    // A branch id belongs to ONE design: navigating to a different design with
    // a stale branch set would join a nonexistent room (the gateway refuses the
    // unknown branch) and could seed from the wrong lineage. Reset to main and
    // let the effect re-run cleanly.
    if (lastDesign.current !== designId) {
      lastDesign.current = designId;
      if (branch) {
        usePresence.getState().setBranch(null);
        return;
      }
    }
    switchedLineage.current = lastDesign.current === designId && lastBranch.current !== branch;
    lastBranch.current = branch;
    const doc = new DesignDoc(designId, branch);
    activeDoc = doc;
    const client = connectRealtime(designId, doc, branch);
    activeClient = client;
    let cancelled = false;
    if (branch) {
      void (async () => {
        try {
          let after = 0;
          for (;;) {
            const page = await oc.designUpdates(designId, after, 0, branch);
            if (cancelled || doc !== activeDoc) return;
            doc.applyJournalFrames(page.items.map((it) => it.update));
            if (!page.nextSeq) break;
            after = page.nextSeq;
          }
        } catch {
          // Seed fetch failed (offline / stale branch): IndexedDB or room sync
          // may still provide state; otherwise the doc stays empty and the
          // branch-doc guards keep main state from leaking in.
        }
      })();
    } else if (switchedLineage.current) {
      // Coming back to MAIN from a branch. The store still holds the branch's
      // document (switching only rebinds the room), so it is neither safe to
      // seed the room from nor safe to leave on screen: the REST save paths
      // fall back to the store doc and would write branch content into main's
      // current file. Reload main's persisted document, then release the
      // foreign-store guard - otherwise nothing ever clears it for a main room
      // with no peer, no journal, and no local state, and every edit is
      // dropped.
      switchedLineage.current = false;
      void (async () => {
        try {
          const file = await oc.getDesignFile(designId);
          if (cancelled || doc !== activeDoc) return;
          useEditor.getState().loadDoc(file);
          doc.adoptStore();
        } catch {
          // Offline: leave the guard up rather than seeding main's room from
          // branch state. Room sync or IndexedDB can still unblock it.
        }
      })();
    }
    return () => {
      cancelled = true;
      client.close();
      doc.dispose();
      if (activeClient === client) activeClient = null;
      if (activeDoc === doc) activeDoc = null;
    };
  }, [designId, branch]);

  // Feed local SELECTION changes as presence (the Canvas feeds the cursor, and
  // viewport changes flow through the follow-mode effect below).
  useEffect(() => {
    if (!designId) return;
    const unsub = useEditor.subscribe((s, prev) => {
      if (s.selection === prev.selection) return;
      activeClient?.sendPresence({
        selection: s.selection,
        viewport: s.viewport,
        following: usePresence.getState().following,
      });
    });
    return unsub;
  }, [designId]);

  // Follow mode (AC-5): mirror the followed peer's viewport; broadcast our own
  // viewport so others can follow us; break follow when WE move the viewport.
  useEffect(() => {
    if (!designId) return;

    // When the followed peer's viewport changes, copy it into our viewport and
    // remember the value so the editor-store subscription below does not treat
    // that programmatic change as a user-initiated pan that breaks follow.
    const unsubPresence = usePresence.subscribe((s, prev) => {
      const id = s.following;
      if (!id) return;
      const vp = s.peers[id]?.state.viewport;
      if (!vp) return;
      // On starting to follow, snap to the peer's current viewport immediately;
      // afterwards, mirror only when their viewport actually changes.
      if (s.following !== prev.following) {
        applyMirror(vp);
        return;
      }
      const prevVp = prev.peers[id]?.state.viewport;
      if (vp !== prevVp) applyMirror(vp);
    });

    // When OUR viewport changes and it was not a mirror we just applied, the
    // user panned/zoomed -> stop following. Also re-broadcast our viewport.
    const unsubEditor = useEditor.subscribe((s, prev) => {
      if (s.viewport === prev.viewport) return;
      if (mirroring.current) {
        mirroring.current = false; // consume the mirror; not a user move
      } else if (usePresence.getState().following) {
        usePresence.getState().setFollowing(null); // user moved -> break follow
      }
      activeClient?.sendPresence({
        selection: s.selection,
        viewport: s.viewport,
        following: usePresence.getState().following,
      });
    });

    function applyMirror(vp: { zoom: number; panX: number; panY: number }) {
      // Flag the mirror BEFORE setViewport so the synchronous subscription above
      // recognizes it even when setViewport clamps the zoom to a different value.
      mirroring.current = true;
      useEditor.getState().setViewport(vp);
    }

    return () => {
      unsubPresence();
      unsubEditor();
    };
  }, [designId]);

  // Esc breaks follow mode (AC-5) and a forced spotlight (FR-14). Capture phase so
  // it works regardless of focus and before other Esc handlers clear state.
  useEffect(() => {
    if (!designId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && usePresence.getState().following) {
        usePresence.getState().setFollowing(null); // also clears any active presenter
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [designId]);

  // Summon (FR-14): when a facilitator's one-shot "bring everyone here" arrives,
  // snap our viewport to the carried target exactly once (per `at`). This is a
  // genuine override, so it intentionally does NOT suppress the follow-break
  // logic: snapping while voluntarily following a peer ends that follow.
  useEffect(() => {
    if (!designId) return;
    let lastAt = 0;
    return usePresence.subscribe((s) => {
      const sm = s.summon;
      if (!sm || sm.at === lastAt) return;
      lastAt = sm.at;
      useEditor.getState().setViewport(sm.viewport);
    });
  }, [designId]);
}
