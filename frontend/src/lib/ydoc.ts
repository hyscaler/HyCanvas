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
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { IndexeddbPersistence } from "y-indexeddb";
import { reconcile, fromDoc, fromDocWithPageReuse, LOCAL_ORIGIN } from "@hc/realtime";
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

/** Which lineage's document the editor store currently holds: the design it
 *  belongs to and the branch within it (null = main). Updated whenever a bound
 *  doc projects its state into the store, and read by the constructor to decide
 *  whether the store is a safe seed for a newly bound room. Null until a doc
 *  projects: a freshly opened design has its main-lineage file in the store
 *  (loaded over REST), which is exactly what a main doc may seed from. */
let storeLineage: { designId: string; branch: string | null } | null = null;

/** True when the store holds a document from a lineage OTHER than (designId,
 *  branch). Opening a different design is not foreign for a main doc: the store
 *  then holds that design's REST-loaded main file. Switching branches within a
 *  design always is, in both directions, because the switch only rebinds the
 *  room and the store keeps the lineage just left until the new one syncs. */
function storeIsForeign(designId: string, branch: string | null): boolean {
  if (storeLineage && storeLineage.designId === designId) return storeLineage.branch !== branch;
  return branch !== null;
}

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
  /** True when the editor store holds a DIFFERENT lineage's document than this
   *  doc binds (set at construction, cleared once this lineage's own state
   *  reaches the store, whether by sync or by {@link adoptStore}). While true
   *  the store is never used as a room seed. */
  private foreignStore: boolean;
  // Page-granular incremental projection (FR-2/FR-7 at scale). Non-local
  // transactions accumulate the ids of pages they touched; applyToStore then
  // re-projects ONLY those pages and reuses the store's existing objects for
  // the rest, so a peer's one-shape edit costs one page, not the whole deck.
  // `metaDirty` forces the full path for root-level/meta changes; reuse is
  // valid only while the store doc is the object we last projected (local
  // edits mutate it in place and are already reconciled INTO Y, so they never
  // invalidate; a loadDoc swap does).
  private dirtyPages = new Set<string>();
  private metaDirty = false;
  private lastStoreDoc: DesignFile | null = null;

  /** branch: the in-CRDT branch this doc binds (doc 16 FR-10), or null for the
   *  main lineage. A branch doc gets its own IndexedDB namespace. A doc bound
   *  right after a lineage switch (in either direction) never seeds from the
   *  store, which still holds the lineage just left; it seeds from the
   *  lineage's folded journal via {@link applyJournalFrames} or from room
   *  sync/IndexedDB. */
  constructor(readonly designId: string, readonly branch: string | null = null) {
    this.lastRev = useEditor.getState().rev;
    // Whose state is in the store right now? Seeding a room from the store is
    // only safe when the store holds THIS lineage's document. It does not after
    // a lineage switch in either direction: switching only rebinds the room, so
    // the store still holds the lineage we just left until that room's state
    // arrives.
    this.foreignStore = storeIsForeign(designId, branch);
    // A doc must never treat another lineage's document as its pre-edit
    // baseline; its baseline is the lineage's own folded state.
    this.seedBaseline = this.foreignStore ? null : structuredClone(useEditor.getState().doc);

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

    // Track which PAGES each non-local transaction touched, so the store
    // rebuild below can re-project just those. Deep events carry a path from
    // the observed root; a page subtree event's path starts ["pages", <index>].
    // Index resolves to the page id at event time. Anything shallower or
    // outside pages (meta, assets, a page insert/delete on the array itself)
    // marks the projection meta-dirty and falls back to the full path.
    this.ydoc.getMap(DESIGN_ROOT_KEY).observeDeep((events) => {
      for (const ev of events) {
        if (ev.transaction.origin === LOCAL_ORIGIN) continue; // store already has it
        const path = ev.path;
        if (path.length >= 2 && path[0] === "pages" && typeof path[1] === "number") {
          const pages = this.ydoc.getMap(DESIGN_ROOT_KEY).get("pages");
          const pg = pages instanceof Y.Array ? pages.get(path[1] as number) : null;
          const id = pg instanceof Y.Map ? pg.get("id") : null;
          if (typeof id === "string") this.dirtyPages.add(id);
          else this.metaDirty = true;
        } else {
          this.metaDirty = true;
        }
      }
    });

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
        // Never absorb ANOTHER lineage's document while empty. At switch time
        // the store still holds the lineage we left, so seeding here would
        // graft branch content onto main (broadcast to every peer as duplicate
        // pages) or main content onto a branch. The real base arrives via
        // applyJournalFrames / room sync; edits raced before that are dropped
        // in favor of the authoritative lineage.
        if (this.foreignStore) return;
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
        // A branch doc persists under its own namespace: its CRDT state is a
        // different lineage and must never merge into main's offline store.
        const idbName = branch ? `oc-design-${designId}::${branch}` : `oc-design-${designId}`;
        this.idb = new IndexeddbPersistence(idbName, this.ydoc);
      } catch {
        this.idb = null; // private-mode / blocked storage: degrade to online-only
      }
    }
  }

  /**
   * Apply journaled y-protocols frames (base64, oldest first) to this doc -
   * the branch seed path (doc 16 FR-10). The frames are the branch's
   * lineage exactly as the server pages it out; readSyncMessage applies each
   * like inbound live sync (REMOTE_ORIGIN, so the store rebuilds, nothing is
   * re-broadcast, and nothing lands on the undo stack). Idempotent against
   * room sync and IndexedDB state: CRDT merge of already-known frames is a
   * no-op, so seeding and live sync can race freely.
   */
  applyJournalFrames(framesB64: string[]): void {
    if (this.disposed || !framesB64.length) return;
    this.ydoc.transact(() => {
      for (const b64 of framesB64) {
        if (!b64) continue;
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const dec = decoding.createDecoder(bytes);
        const enc = encoding.createEncoder(); // reply sink, unused for updates
        syncProtocol.readSyncMessage(dec, enc, this.ydoc, REMOTE_ORIGIN);
      }
    }, REMOTE_ORIGIN);
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
    // A branch doc's only legitimate seed is its folded lineage
    // (applyJournalFrames); a design-file seed would graft foreign state.
    if (this.branch) return;
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

  /** Declare that the editor store now holds THIS lineage's authoritative
   *  document (the binder just loaded it), releasing the foreign-store guard.
   *  Without this a doc bound after a lineage switch would refuse to seed
   *  forever when no peer, journal, or IndexedDB state exists to unblock it,
   *  and every edit would be dropped on the floor. */
  adoptStore(): void {
    if (this.disposed) return;
    this.foreignStore = false;
    storeLineage = { designId: this.designId, branch: this.branch };
    this.seedBaseline = structuredClone(useEditor.getState().doc);
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
    // This lineage's authoritative state is about to become the store's doc.
    this.foreignStore = false;
    storeLineage = { designId: this.designId, branch: this.branch };
    try {
      const store = useEditor.getState();
      // Page-granular fast path (FR-2/FR-7): when the store doc is the object
      // we last projected (local edits mutate it in place and were reconciled
      // INTO Y, so it is still in sync) and nothing outside page subtrees
      // changed, re-project only the pages this batch of transactions touched
      // and reuse every other page object untouched. A 50-page deck then pays
      // for one page on a peer's edit, not fifty.
      let file: DesignFile;
      const prevPages = (store.doc as { pages?: { id?: unknown }[] }).pages;
      const canReuse = !this.metaDirty && this.lastStoreDoc !== null && store.doc === this.lastStoreDoc && Array.isArray(prevPages);
      if (canReuse) {
        const reusable = new Map<string, unknown>();
        for (const p of prevPages) {
          if (p && typeof p.id === "string" && !this.dirtyPages.has(p.id)) reusable.set(p.id, p);
        }
        file = fromDocWithPageReuse(this.ydoc, reusable);
      } else {
        file = fromDoc(this.ydoc);
      }
      this.dirtyPages.clear();
      this.metaDirty = false;
      this.lastStoreDoc = file;
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
