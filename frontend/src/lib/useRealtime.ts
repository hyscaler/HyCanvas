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

/** The live collaborative document binding, or null when not connected. */
export function getDesignDoc(): DesignDoc | null {
  return activeDoc;
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
  // Then, if connected, push it into the shared doc so peers see the restore.
  activeDoc?.replaceDoc(file);
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
  if (!doc) return;
  useEditor.getState().loadDoc(doc.snapshot());
}

/**
 * Connect realtime for `designId` (no-op when null, i.e. the unsaved local doc).
 * Returns nothing; reads/writes the editor + presence stores directly.
 */
export function useRealtime(designId: string | null): void {
  // Track the last viewport we set programmatically (following a peer) so a
  // genuine user pan/zoom can be told apart and break follow mode.
  const mirroredViewport = useRef<string | null>(null);

  // Connect / disconnect on design id change. Slice B: stand up the per-design
  // Y.Doc binding (store bridge), then open the socket carrying both presence
  // and Yjs sync. The server room Y.Doc is authoritative and is seeded from the
  // latest persisted snapshot, so the client does NOT independently reconcile the
  // REST-loaded file into the Y.Doc: doing so would create a second, divergent
  // set of CRDT items that merge into duplicate pages/nodes once sync step 2
  // lands. The editor still renders immediately from the REST file already in the
  // store; Yjs sync then rebuilds `store.doc` from the shared server state.
  useEffect(() => {
    if (!designId) return;
    const doc = new DesignDoc(designId);
    activeDoc = doc;
    const client = connectRealtime(designId, doc);
    activeClient = client;
    return () => {
      client.close();
      doc.dispose();
      if (activeClient === client) activeClient = null;
      if (activeDoc === doc) activeDoc = null;
    };
  }, [designId]);

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
      const key = vpKey(s.viewport);
      if (mirroredViewport.current === key) {
        mirroredViewport.current = null; // consume the mirror; not a user move
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
      mirroredViewport.current = vpKey(vp);
      useEditor.getState().setViewport(vp);
    }

    return () => {
      unsubPresence();
      unsubEditor();
    };
  }, [designId]);

  // Esc breaks follow mode (AC-5). Capture phase so it works regardless of focus
  // and before other Esc handlers clear unrelated state.
  useEffect(() => {
    if (!designId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && usePresence.getState().following) {
        usePresence.getState().setFollowing(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [designId]);
}

function vpKey(v: { zoom: number; panX: number; panY: number }): string {
  return `${v.zoom}:${v.panX}:${v.panY}`;
}
