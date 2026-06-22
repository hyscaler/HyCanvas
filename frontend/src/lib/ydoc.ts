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
import { IndexeddbPersistence } from "y-indexeddb";
import { reconcile, fromDoc, LOCAL_ORIGIN } from "@hc/realtime";
import type { DesignFile } from "@hc/schema";
import { useEditor } from "@/store/editor";

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

  constructor(readonly designId: string) {
    this.lastRev = useEditor.getState().rev;

    // Y -> Local: any update not originating from our own reconcile (remote
    // peer or the initial sync) rebuilds the store doc under the guard.
    this.ydoc.on("update", (_update: Uint8Array, origin: unknown) => {
      if (origin !== LOCAL_ORIGIN) this.applyToStore();
    });

    // Fan out LOCAL edits (our reconcile, tagged LOCAL_ORIGIN) to the transport
    // so they reach peers. Remote-origin (inbound sync) and IndexedDB-load
    // updates are NOT re-sent: the former already came from the network, and the
    // latter is just restoring already-synced local state, so rebroadcasting
    // would be redundant churn.
    this.ydoc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== LOCAL_ORIGIN) return;
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
    this.unsubStore();
    this.updateHandlers.clear();
    // Close the IndexedDB connection (keeps the persisted data for next open).
    this.idb?.destroy();
    this.ydoc.destroy();
  }
}
