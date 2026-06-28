// Realtime presence store. Holds the connection state and the
// remote-peer roster for the design currently open in the editor. The transport
// (lib/realtime.ts) drives this store; the canvas overlay and the top-bar avatar
// stack read from it. Presence is additive: when disconnected/offline the store
// is simply empty and editing continues unaffected.

import { create } from "zustand";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "offline";

/** The caller's resolved per-design access, mirrored here so the
 *  canvas keyboard path (a global listener with no component props) can gate
 *  mutations the same way the UI does. "edit" allows document mutation; "comment"
 *  and "view" are read-only for the document. Defaults to "edit" for the local /
 *  unsaved doc; the editor shell pushes the resolved mode once a design loads and
 *  on every live role change. */
export type EditorAccessMode = "edit" | "comment" | "view";

export interface PeerState {
  cursor?: { x: number; y: number } | null;
  selection?: string[];
  viewport?: { zoom: number; panX: number; panY: number };
  following?: string | null;
  /** A one-shot emoji reaction ping; `at` is a server-synced ms
   *  timestamp so all clients fade the animation together. */
  reaction?: { emoji: string; at: number } | null;
  /** A live cursor-chat message anchored to this peer's cursor,
   *  or null when cleared. */
  chat?: string | null;
  /** An ephemeral laser-pointer position (FR-17); `at` is a server-synced ms
   *  timestamp so all clients fade it together. Never persisted. */
  laser?: { x: number; y: number; at: number } | null;
}

/** A remote participant as broadcast by the server (identity + live state). */
export interface Peer {
  clientId: string;
  userId: string;
  name: string;
  color: string;
  role: "editor" | "viewer";
  state: PeerState;
}

/** Who holds a collaborative lock on a node. Mirrored from the
 *  server's authoritative `{ t: "locks" }` broadcast. Distinct from the schema's
 *  static `locked` flag: this is a transient, per-user claim. */
export interface LockHolder {
  clientId: string;
  userId: string;
  name: string;
  color: string;
}

interface PresenceStore {
  /** WebSocket connection lifecycle, surfaced as a top-bar badge (FR-14). */
  connection: ConnectionState;
  /** This client's own server-assigned identity, once welcomed. */
  self: { clientId: string; userId: string; name: string; color: string; role: "editor" | "viewer" } | null;
  /** Remote peers keyed by clientId (this client is never in here). */
  peers: Record<string, Peer>;
  /** Authoritative collaborative locks keyed by node id, mirrored
   *  from the server. Includes locks held by this client (its own holder). */
  locks: Record<string, LockHolder>;
  /** The participant currently running the session (FR-16), or null. Set by the
   *  server `{t:"facilitator"}` frame; supports mid-session handoff. */
  facilitator: { clientId: string; name: string } | null;
  /** Node ids under a facilitator/protected lock (FR-16), mirrored from the
   *  server `{t:"protected"}` frame. Only the facilitator may move/edit them. */
  protectedNodes: ReadonlySet<string>;
  /** clientId of the peer whose viewport we are mirroring (AC-5), or null. */
  following: string | null;
  /** The facilitator currently driving our viewport via spotlight/take-control
   *  (FR-14), or null. Distinct from voluntary `following`: this was forced by a
   *  facilitator and surfaces a "[name] is presenting" banner. Setting it also
   *  sets `following` so the existing follow-mirror machinery applies. */
  presenter: { clientId: string; name: string } | null;
  /** A one-shot "summon" (bring-everyone-here) signal from a facilitator: the
   *  target viewport to snap to once, with a server-synced `at` so the banner
   *  fades together. Null when none pending. Never persisted. */
  summon: { name: string; viewport: { zoom: number; panX: number; panY: number }; at: number } | null;
  /** The local user's own laser position (FR-17), echoed locally so the sender
   *  sees their own laser (peers never include self). Null when not lasering. */
  selfLaser: { x: number; y: number; at: number } | null;
  /** The caller's resolved per-design access. Read by the canvas
   *  keyboard path to refuse document mutations when not "edit". */
  accessMode: EditorAccessMode;

  setConnection(state: ConnectionState): void;
  /** Set the caller's resolved access mode (editor shell, on load + role flip). */
  setAccessMode(mode: EditorAccessMode): void;
  /** True when the caller may mutate the document (access mode is "edit"). */
  canEdit(): boolean;
  setSelf(self: PresenceStore["self"]): void;
  /** Replace the whole roster (sent to a newcomer on join). */
  setRoster(peers: Peer[]): void;
  /** Insert/update a single peer (join or presence change). */
  upsertPeer(peer: Peer): void;
  /** Remove a peer that left. */
  removePeer(clientId: string): void;
  /** Replace the whole collaborative-lock map (server `{ t: "locks" }`). */
  setLocks(locks: Record<string, LockHolder>): void;
  /** This client's own server-assigned clientId, or null when not connected. */
  selfClientId(): string | null;
  /** The holder of a node's collaborative lock IFF held by ANOTHER client (not
   *  us), else null. The gate the editor uses to block mutating contended nodes. */
  collabLockedByOther(nodeId: string): LockHolder | null;
  /** Set/clear the session facilitator (server `{t:"facilitator"}`). */
  setFacilitator(clientId: string, name: string): void;
  /** Replace the protected-lock node set (server `{t:"protected"}`). */
  setProtectedNodes(ids: string[]): void;
  /** True when a node is under a facilitator/protected lock and this client is NOT
   *  the facilitator, so the editor must refuse to move/edit it (FR-16). */
  protectedByOther(nodeId: string): boolean;
  /** True when this client currently holds the facilitator role. */
  isFacilitator(): boolean;
  /** Toggle follow on a peer (AC-5); clears when the peer is gone. */
  toggleFollow(clientId: string): void;
  setFollowing(clientId: string | null): void;
  /** Enter forced spotlight/take-control of a facilitator (FR-14): mirror their
   *  viewport and show the presenting banner. Reuses follow-mode mirroring. */
  setPresenter(clientId: string, name: string): void;
  /** Set/clear the one-shot summon signal (the snap is applied by useRealtime). */
  setSummon(summon: PresenceStore["summon"]): void;
  /** Set/clear the local laser echo (the overlay renders + age-gates it). */
  setSelfLaser(laser: { x: number; y: number; at: number } | null): void;
  /** Drop all presence (on disconnect / leaving the design). */
  reset(): void;
}

export const usePresence = create<PresenceStore>((set, get) => ({
  connection: "connecting",
  self: null,
  peers: {},
  locks: {},
  facilitator: null,
  protectedNodes: new Set<string>(),
  following: null,
  presenter: null,
  summon: null,
  selfLaser: null,
  accessMode: "edit",

  setConnection: (connection) => set({ connection }),
  setAccessMode: (accessMode) => set({ accessMode }),
  canEdit: () => get().accessMode === "edit",
  setSelf: (self) => set({ self }),
  setLocks: (locks) => set({ locks }),
  selfClientId: () => get().self?.clientId ?? null,
  collabLockedByOther: (nodeId) => {
    const holder = get().locks[nodeId];
    if (!holder) return null;
    return holder.clientId !== get().self?.clientId ? holder : null;
  },
  setFacilitator: (clientId, name) => set({ facilitator: clientId ? { clientId, name } : null }),
  setProtectedNodes: (ids) => set({ protectedNodes: new Set(ids) }),
  isFacilitator: () => {
    const s = get();
    return !!s.facilitator && s.facilitator.clientId === s.self?.clientId;
  },
  protectedByOther: (nodeId) => {
    const s = get();
    if (!s.protectedNodes.has(nodeId)) return false;
    // Protected nodes are editable only by the current facilitator.
    return s.facilitator?.clientId !== s.self?.clientId;
  },
  setRoster: (peers) => {
    const selfId = get().self?.clientId;
    const map: Record<string, Peer> = {};
    for (const p of peers) if (p.clientId !== selfId) map[p.clientId] = p;
    set({ peers: map });
  },
  upsertPeer: (peer) => {
    if (peer.clientId === get().self?.clientId) return; // never track ourselves
    set((s) => {
      // A reaction is a one-shot ping the sender stops broadcasting after one
      // frame, but each presence frame replaces the peer's whole state. Carry
      // the last reaction forward when a later frame omits it so the floating
      // emoji animation isn't cut off by the sender's next cursor move; the
      // overlay age-gates it by `at`, so a stale one simply stops rendering.
      const prev = s.peers[peer.clientId];
      const reaction = peer.state.reaction ?? prev?.state.reaction;
      const merged: Peer = { ...peer, state: { ...peer.state, reaction } };
      return { peers: { ...s.peers, [peer.clientId]: merged } };
    });
  },
  removePeer: (clientId) =>
    set((s) => {
      if (!s.peers[clientId]) return {};
      const next = { ...s.peers };
      delete next[clientId];
      // If we were following or being presented to by this peer, clear it (they left).
      return {
        peers: next,
        following: s.following === clientId ? null : s.following,
        presenter: s.presenter?.clientId === clientId ? null : s.presenter,
      };
    }),
  toggleFollow: (clientId) =>
    set((s) => ({ following: s.following === clientId ? null : clientId, presenter: null })),
  // Setting follow to anything other than the active presenter (incl. null, e.g.
  // the user pans to break free) ends a forced spotlight.
  setFollowing: (clientId) =>
    set((s) => ({
      following: clientId,
      presenter: clientId && s.presenter?.clientId === clientId ? s.presenter : null,
    })),
  setPresenter: (clientId, name) => set({ presenter: { clientId, name }, following: clientId }),
  setSummon: (summon) => set({ summon }),
  setSelfLaser: (laser) => set({ selfLaser: laser }),
  reset: () =>
    set({ peers: {}, locks: {}, facilitator: null, protectedNodes: new Set<string>(), self: null, following: null, presenter: null, summon: null, selfLaser: null }),
}));
