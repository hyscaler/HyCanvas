// Per-design Yjs document + editor-store binding (FR-1, FR-2).
// This owns the live Y.Doc for one design and the two-way bridge to the Zustand
// editor store:
//
//   Local -> Y: when the store's `doc` changes due to a LOCAL edit (a `rev`
//     bump that we did not cause by applying a remote update), reconcile the
//     plain-JS doc into the Y.Doc with minimal ops (@hc/realtime). Undo/redo
//     mutate `store.doc` and bump `rev`, so they reconcile automatically.
//
//   Y -> Local: observe the Y.Doc for updates whose origin is NOT our local
//     reconcile (i.e. remote peers / the initial sync), rebuild
//     `store.doc = fromDoc(ydoc)` and bump `rev` so the canvas re-renders. This
//     is done inside an `applyingRemote` guard so the resulting store change is
//     not echoed back to Y, and it is NOT pushed onto the local undo stack.
//
// The server's room Y.Doc is authoritative while connected: it is seeded from
// the latest persisted snapshot, so the client must NOT independently reconcile
// the REST-loaded file into the Y.Doc. Doing so would produce a second, divergent
// set of CRDT items that merge into duplicate pages/nodes once sync step 2 lands.
// The client keeps the REST load only for immediate first render; Yjs sync then
// rebuilds `store.doc` from the synced server state. Local seeding is reserved
// for a genuinely server-less doc (none currently constructs one).
//
// The transport (lib/realtime.ts) carries the Yjs sync protocol on the same
// `/realtime` socket as presence; this module is transport-agnostic and just
// exposes the Y.Doc + a "local update" subscription for the transport to encode.

import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import { IndexeddbPersistence } from "y-indexeddb";
import { reconcile, fromDoc, LOCAL_ORIGIN } from "@hc/realtime";
import { DESIGN_ROOT_KEY, type DesignFile } from "@hc/schema";
import { useEditor, type CollabUndo } from "@/store/editor";

// base64 of a Uint8Array (browser btoa over a binary string). Chunked so a multi-
// MB full-state checkpoint doesn't do per-byte string growth on the main thread.
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000; // 32k args max for String.fromCharCode.apply
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

// Origin tag stamped on updates we apply from the network, so our own store
// subscription can tell a remote-driven store change apart from a genuine local
// edit and avoid an echo loop.
const REMOTE_ORIGIN = "remote";

/**
 * The live collaborative document for one design: a Y.Doc bound to the editor
 * store. Construct via {@link bindDesignDoc}; dispose on unmount/route change.
 */
export class DesignDoc {
  readonly ydoc = new Y.Doc();
  private applyingRemote = false;
  private lastRev: number;
  private unsubStore: () => void;
  private readonly updateHandlers = new Set<(update: Uint8Array) => void>();
  private disposed = false;
  // Offline-first local persistence: the Y.Doc is mirrored to
  // IndexedDB, so edits made offline survive a reload and merge with the server
  // room on reconnect (Yjs CRDT, no data loss). Null in non-browser/SSR.
  private idb: IndexeddbPersistence | null = null;
  // F16 per-user collaborative undo: a Yjs UndoManager scoped to THIS client's
  // edits (LOCAL_ORIGIN). Undo reverts only our own changes and merges cleanly
  // with concurrent peer edits; registered into the editor store as the active
  // collab-undo handle while this doc is bound.
  private readonly undoMgr: Y.UndoManager;
  private readonly undoHandle: CollabUndo;
  // Pre-edit snapshot of the store doc, kept until the Y.Doc gains state. If
  // the session's FIRST local edit lands before the room sync (or IndexedDB
  // load) does, the seed reconcile would otherwise swallow that edit: the
  // whole document enters the Y.Doc as one transaction and the seed clear()
  // wipes it from the undo stack, making the first action non-undoable. With
  // the baseline we seed the PRE-EDIT document first and let the edit
  // reconcile as its own tracked diff. Cloned because edits mutate the store
  // doc in place; nulled once any state lands (one-shot).
  private seedBaseline: DesignFile | null;

  constructor(readonly designId: string) {
    this.lastRev = useEditor.getState().rev;
    this.seedBaseline = structuredClone(useEditor.getState().doc);

    // Track only LOCAL_ORIGIN transactions (this client's reconciled edits).
    // Remote-peer updates (REMOTE_ORIGIN) and the manager's own undo/redo apply
    // under other origins, so they are not tracked and undo never reverts a
    // teammate's change. Default capture window groups a synchronous batch
    // (e.g. one runAsTurn) into a single undo step.
    this.undoMgr = new Y.UndoManager(this.ydoc.getMap(DESIGN_ROOT_KEY), {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
    });
    this.undoHandle = {
      undo: () => this.undoMgr.undo(),
      redo: () => this.undoMgr.redo(),
      canUndo: () => this.undoMgr.canUndo(),
      canRedo: () => this.undoMgr.canRedo(),
      stopCapturing: () => this.undoMgr.stopCapturing(),
    };
    useEditor.getState().setCollabUndo(this.undoHandle);

    // Y -> Local: any update not originating from our own reconcile (remote
    // peer, the initial sync, or an undo/redo applied by the UndoManager)
    // rebuilds the store doc under the guard.
    this.ydoc.on("update", (_update: Uint8Array, origin: unknown) => {
      if (origin !== LOCAL_ORIGIN) this.applyToStore();
    });

    // Fan out LOCAL edits (our reconcile, tagged LOCAL_ORIGIN) to the transport
    // so they reach peers. Remote-origin (inbound sync) and IndexedDB-load
    // updates are NOT re-sent: the former already came from the network, and the
    // latter is just restoring already-synced local state, so rebroadcasting
    // would be redundant churn.
    this.ydoc.on("update", (update: Uint8Array, origin: unknown) => {
      // Fan out our own edits (LOCAL_ORIGIN) AND undo/redo (applied by the
      // UndoManager under its own origin), so peers converge on undone/redone
      // state. Remote-origin and IndexedDB-load updates are not re-sent.
      if (origin !== LOCAL_ORIGIN && origin !== this.undoMgr) return;
      for (const h of this.updateHandlers) h(update);
    });

    // Local -> Y: reconcile on every local rev bump that we did not cause.
    this.unsubStore = useEditor.subscribe((s, prev) => {
      if (this.applyingRemote) return; // remote apply: do not echo back
      if (s.rev === this.lastRev) return;
      // Exit-preview (prev.preview -> null) swaps the store back to its stashed
      // pre-preview doc and bumps `rev`. That stash predates any peer edits made
      // during the preview, so pushing it into the Y.Doc would CLOBBER them. Skip
      // the reconcile for that rev; the shell follows with resyncFromLiveDoc(),
      // which rebuilds the store from the authoritative live Y.Doc (preserving
      // peer edits).
      if (prev.preview !== null && s.preview === null) {
        this.lastRev = s.rev;
        return;
      }
      // History preview swaps `doc` to a past version read-only:
      // never push that into the shared Y.Doc (it must not reach peers or
      // overwrite live state). Track the rev so the post-exit doc still syncs.
      if (s.preview) {
        this.lastRev = s.rev;
        return;
      }
      this.lastRev = s.rev;
      // A reconcile into an EMPTY Y.Doc is a full-document seed (no room sync
      // or IndexedDB state yet), never an undoable step: undoing it would
      // revert the entire document to nothing. But when the rev bump is an
      // EDIT made before any sync landed (the doc OBJECT is unchanged - edits
      // mutate it in place, while loadDoc installs a new object), seed the
      // pre-edit baseline first and clear, then reconcile the current doc so
      // the edit itself diffs in as a normal tracked step and the session's
      // first action stays undoable.
      if (this.ydoc.getMap(DESIGN_ROOT_KEY).size === 0) {
        const isEdit = s.doc === prev.doc && this.seedBaseline != null;
        if (isEdit) {
          reconcile(this.seedBaseline as DesignFile, this.ydoc);
          this.undoMgr.clear();
          reconcile(s.doc, this.ydoc);
        } else {
          reconcile(s.doc, this.ydoc);
          this.undoMgr.clear();
        }
        this.seedBaseline = null;
        return;
      }
      this.seedBaseline = null;
      reconcile(s.doc, this.ydoc);
    });

    // Bind IndexedDB persistence (browser only). It auto-loads any stored state
    // into the Y.Doc (origin = the persistence instance, so the Y->Local handler
    // rebuilds the store from it) and auto-persists every change.
    if (typeof indexedDB !== "undefined") {
      try {
        this.idb = new IndexeddbPersistence(`oc-design-${designId}`, this.ydoc);
      } catch {
        this.idb = null; // private-mode / blocked storage: degrade to online-only
      }
    }
  }

  /** Project the current Y.Doc state to a plain DesignFile (for manual save). */
  snapshot(): DesignFile {
    return fromDoc(this.ydoc);
  }

  /** True once the Y.Doc has received any state (initial sync or a local seed),
   *  so callers can tell an empty brand-new room apart from a synced one. */
  get hasState(): boolean {
    return this.ydoc.getMap("design").size > 0;
  }

  /** Apply an inbound CRDT update (from a peer or initial sync) to the Y.Doc. */
  applyUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.ydoc, update, REMOTE_ORIGIN);
  }

  /** Encode the whole Y.Doc state as a single update (for sync step replies). */
  encodeState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.ydoc);
  }

  /** A base64 y-protocols UPDATE frame carrying the full Y.Doc state, in the exact
   *  format the realtime hub journals (so the history scrubber folds it like any
   *  other frame). Uploaded as a compaction checkpoint (FR-11): folding it as the
   *  base reconstructs the doc, then the tail deltas apply on the same CRDT
   *  identity space. Returns null when the full state exceeds `maxBytes` (the
   *  server would reject it), so the caller skips the upload instead of looping on
   *  a doomed request. */
  checkpointFrame(maxBytes = Infinity): string | null {
    const state = this.encodeState();
    if (state.byteLength > maxBytes) return null;
    const enc = encoding.createEncoder();
    syncProtocol.writeUpdate(enc, state);
    return bytesToBase64(encoding.toUint8Array(enc));
  }

  /** Subscribe to outbound updates (local edits) so the transport can broadcast
   *  them. Returns an unsubscribe. */
  onUpdate(handler: (update: Uint8Array) => void): () => void {
    this.updateHandlers.add(handler);
    return () => this.updateHandlers.delete(handler);
  }

  /**
   * Seed the Y.Doc from a design file when there is genuinely no server-backed
   * shared state (a purely local/unsaved doc). When realtime is connected the
   * server room is authoritative and seeds from persistence, so this MUST NOT be
   * called on the connected path - a second client-side reconcile of the same
   * REST file produces divergent CRDT items that merge into duplicates. Idempotent
   * (a no-op once the doc has state) for defensiveness.
   */
  seedIfEmpty(file: DesignFile): void {
    if (this.hasState) return;
    reconcile(file, this.ydoc); // LOCAL_ORIGIN: also fans out so peers can sync
    this.undoMgr.clear(); // the seed is the baseline, not an undoable edit
  }

  /**
   * Replace the live shared document with `file` (AC-7, restore). Unlike
   * {@link seedIfEmpty}, this runs even when the doc already has state: it
   * reconciles `file` into the Y.Doc with minimal ops under the LOCAL origin, so
   * the change fans out to peers and they converge on the restored state. The
   * store is updated via the normal Y -> Local observer (no extra undo entry).
   * Used after `oc.restoreVersion` so the restored snapshot becomes the shared
   * doc instead of only the local store.
   */
  replaceDoc(file: DesignFile): void {
    reconcile(file, this.ydoc); // LOCAL_ORIGIN: minimal ops, broadcast to peers
    this.undoMgr.clear(); // a restore is a fresh baseline (forward-only, not undoable)
  }

  /** Rebuild the editor store doc from the Y.Doc under the remote guard, without
   *  touching the undo stack. */
  private applyToStore(): void {
    if (this.disposed) return;
    // Never clobber the immediately-rendered REST file with an empty Y.Doc: an
    // empty IndexedDB load (first open) or a not-yet-synced room has no design
    // state, and fromDoc() of that is a blank file.
    if (this.ydoc.getMap("design").size === 0) return;
    // While the user previews a past version the store's `doc` is
    // the historical file; do not clobber it with live peer edits. The edits
    // still land in the Y.Doc, and exiting preview rebuilds the store from it.
    if (useEditor.getState().preview) return;
    this.applyingRemote = true;
    this.seedBaseline = null; // synced state arrived; the pre-edit baseline is stale
    try {
      const file = fromDoc(this.ydoc);
      // Mirror loadDoc's repaint, but preserve selection/viewport/undo: this is
      // an incremental remote merge, not a document switch.
      useEditor.setState((s) => ({ doc: file, rev: s.rev + 1 }));
      this.lastRev = useEditor.getState().rev; // do not treat this as a local edit
    } finally {
      this.applyingRemote = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    // Unregister our collab-undo handle only if it is still the active one (a
    // newer doc may have replaced it during a route change), then tear down the
    // manager so the store falls back to the local stack.
    if (useEditor.getState().collabUndo === this.undoHandle) {
      useEditor.getState().setCollabUndo(null);
    }
    this.undoMgr.destroy();
    this.unsubStore();
    this.updateHandlers.clear();
    // Close the IndexedDB connection (keeps the persisted data for next open).
    this.idb?.destroy();
    this.ydoc.destroy();
  }
}
