// Realtime transport for collaboration presence. Connects to
// the backend `/realtime` WebSocket for a specific design, authenticates via the
// httpOnly session cookie (sent automatically on same-origin/credentialed WS
// upgrades), reconnects with exponential backoff, throttles outbound presence,
// and feeds the presence store. The JSON envelope matches the backend
// (see backend/src/realtime/presence.ts); later slices add sync/lock frames on
// the same socket, so the message switch is written to tolerate unknown tags.

import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { apiOrigin } from "@/lib/sdk";
import { usePresence, type ConnectionState, type LockHolder, type Peer, type PeerState } from "@/store/presence";
import type { DesignDoc } from "@/lib/ydoc";

// Outbound presence is coalesced to at most one frame per this interval
// (~22/s); awareness is throttled. The latest pending state wins.
const PRESENCE_THROTTLE_MS = 45;
// Reconnect backoff: start small, double up to a cap, with a little jitter.
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 15_000;

type SelfIdentity = NonNullable<ReturnType<typeof usePresence.getState>["self"]>;

/** Server-pushed gateway role (FR-11 / F16 AC-9). */
export type RealtimeRole = "editor" | "viewer";
export type RoleChangeReason = "approval-locked" | "approval-reopened" | "access-changed";

type ServerFrame =
  | { t: "welcome"; self: SelfIdentity; serverTime?: number }
  | { t: "roster"; peers: Peer[] }
  | { t: "presence"; peer: Peer }
  | { t: "join"; peer: Peer }
  | { t: "leave"; clientId: string }
  | { t: "sync"; m: string } // base64 y-protocols sync message (slice B)
  | { t: "locks"; locks: Record<string, LockHolder> } // authoritative collab locks (slice C)
  | { t: "comment"; op: "changed"; designId: string } // comment mutation signal
  | { t: "vote"; op: "changed"; designId: string } // server-authoritative vote signal (FR-19)
  | { t: "moderated"; action: "kick" | "ban" | "unban"; designId: string } // you were removed (FR-32)
  | { t: "notify"; designId: string } // new in-app notification for the caller
  | { t: "role"; role: RealtimeRole; reason?: RoleChangeReason } // live role change
  | {
      // Facilitator spotlight / summon / take-control (FR-14). `from`/`name`
      // identify the driving facilitator; `summon` carries a one-shot target
      // viewport, `start`/`stop` toggle sustained take-control.
      t: "spotlight";
      from: string;
      name: string;
      mode: "summon" | "start" | "stop";
      viewport?: { zoom: number; panX: number; panY: number };
    }
  | { t: "facilitator"; clientId: string; name: string } // session facilitator changed (FR-16)
  | { t: "protected"; nodes: string[] }; // facilitator/protected-lock node set (FR-16)

// Offset (ms) between the server clock and this client's clock, captured from
// the welcome frame's serverTime. serverNow() applies it so all
// clients agree on "now" closely enough to run a synchronized countdown timer.
let serverClockOffsetMs = 0;

/** The server-synced current time in ms. Falls back to the local clock until a
 *  welcome frame with serverTime arrives (offset stays 0). */
export function serverNow(): number {
  return Date.now() + serverClockOffsetMs;
}

// Listeners notified when a `{ t: "comment" }` signal arrives.
// The comments panel subscribes so threads/pins refetch live; clients without a
// socket still work via REST. Module-level so it survives client reconnects.
const commentListeners = new Set<(designId: string) => void>();

/** Subscribe to live comment-changed signals; returns an unsubscribe. */
export function onCommentChanged(fn: (designId: string) => void): () => void {
  commentListeners.add(fn);
  return () => commentListeners.delete(fn);
}

// Listeners notified when a `{ t: "vote" }` signal arrives (FR-19): a
// server-authoritative vote was cast or a session changed, so the board refetches
// the tally over REST. Module-level so it survives client reconnects.
const voteListeners = new Set<(designId: string) => void>();

/** Subscribe to live vote-changed signals; returns an unsubscribe. */
export function onVoteChanged(fn: (designId: string) => void): () => void {
  voteListeners.add(fn);
  return () => voteListeners.delete(fn);
}

// Listeners notified when the server pushes a `{ t: "moderated" }` frame (FR-32):
// a facilitator kicked or banned this client. The transport stops reconnecting
// (a ban would otherwise loop); the editor shell surfaces a message.
const moderatedListeners = new Set<(action: "kick" | "ban" | "unban") => void>();

/** Subscribe to being kicked/banned from the current board; returns an unsubscribe. */
export function onModerated(fn: (action: "kick" | "ban" | "unban") => void): () => void {
  moderatedListeners.add(fn);
  return () => moderatedListeners.delete(fn);
}

// Listeners notified when the server pushes a `{ t: "role" }` frame (FR-11 /
// F16 AC-9): the editor shell subscribes so editing affordances disable
// (approval-locked) or re-enable (reopened) instantly with NO reconnect.
const roleListeners = new Set<(role: RealtimeRole, reason?: RoleChangeReason) => void>();

/** Subscribe to live gateway-role changes; returns an unsubscribe. */
export function onRoleChanged(
  fn: (role: RealtimeRole, reason?: RoleChangeReason) => void,
): () => void {
  roleListeners.add(fn);
  return () => roleListeners.delete(fn);
}

// Listeners notified when the server pushes a `{ t: "notify" }` frame (FR-13):
// a new in-app notification was created for the caller on this
// design, so an open client refetches its unread count without polling. The
// frame carries no content; the client re-reads over REST (which re-checks
// ownership). Module-level so it survives client reconnects.
const notifyListeners = new Set<(designId: string) => void>();

/** Subscribe to live notification signals; returns an unsubscribe. */
export function onNotify(fn: (designId: string) => void): () => void {
  notifyListeners.add(fn);
  return () => notifyListeners.delete(fn);
}

// --- base64 <-> Uint8Array (sync frames travel as JSON strings on the socket) -
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Build the ws(s):// URL for a design from the configured backend origin. */
function realtimeUrl(designId: string): string {
  // apiOrigin is the backend origin without the /api suffix (empty in the
  // same-origin dist build, where we fall back to the page's own origin).
  const origin = apiOrigin || (typeof window !== "undefined" ? window.location.origin : "");
  const wsBase = origin.replace(/^http/, "ws"); // http->ws, https->wss
  return `${wsBase}/realtime?design=${encodeURIComponent(designId)}`;
}

/**
 * A live presence connection to one design. Construct via {@link connectRealtime};
 * call {@link RealtimeClient.sendPresence} on local cursor/selection/viewport
 * changes and {@link RealtimeClient.close} on unmount/route change.
 */
export class RealtimeClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Periodic liveness ping so the server does not sweep our collaborative locks
  // while we are connected but idle (FR-8 heartbeat; 10s, well inside the 30s TTL).
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Outbound presence throttle: hold the latest state and flush on a timer.
  private pending: PeerState | null = null;
  // The latest merged local presence. sendPresence merges partial updates into
  // this (e.g. a reaction ping composed with the current cursor) so a partial
  // send never clobbers fields set by another caller.
  private local: PeerState = {};
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSentAt = 0;

  // Unsubscribe from the bound Y.Doc's outbound updates, if any.
  private unsubDoc: (() => void) | null = null;

  // `doc` is the per-design Y.Doc binding (slice B). When present, the client
  // also carries the Yjs sync protocol on this socket; when null (the unsaved
  // local doc) it is presence-only, exactly like slice A.
  constructor(
    private readonly designId: string,
    private readonly doc: DesignDoc | null = null,
  ) {
    this.setState("connecting");
    // Broadcast local CRDT updates to the room as they happen; on (re)connect the
    // sync handshake reconverges anything sent while the socket was down.
    if (this.doc) {
      this.unsubDoc = this.doc.onUpdate((update) => this.sendUpdate(update));
    }
    this.open();
  }

  private setState(state: ConnectionState) {
    usePresence.getState().setConnection(state);
  }

  private open() {
    if (this.closed || typeof window === "undefined") return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(realtimeUrl(this.designId));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.setState("connected");
      // Re-send the latest known local presence so a reconnect re-announces us.
      if (this.pending) this.flush();
      // Kick off Yjs sync: send sync step 1 (our state vector). The server
      // replies with step 2 (the ops we are missing) and its own step 1; on
      // reconnect this re-converges any edits made while offline (FR-6).
      if (this.doc) this.sendSyncStep1();
      this.startHeartbeat();
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return; // binary reserved for future sync
      this.onFrame(ev.data);
    };

    ws.onclose = () => {
      this.ws = null;
      this.stopHeartbeat();
      if (this.closed) return;
      // Drop ephemeral awareness (cursor chat / reaction) so the reconnect
      // re-announce can't replay a stale chat bubble or reaction; chat is set to
      // null so peers clear it. Durable presence (cursor/selection/viewport)
      // re-announces normally.
      this.local = { ...this.local, chat: null, reaction: undefined, laser: null };
      // A clean roster is rebuilt from the next "roster" frame on reconnect.
      usePresence.getState().reset();
      this.scheduleReconnect();
    };

    // Let onclose drive reconnect; just surface the transient state here.
    ws.onerror = () => {
      if (!this.closed) this.setState("reconnecting");
    };
  }

  // Liveness ping: keeps our collaborative locks from being swept by the server
  // while connected but idle (FR-8). Cleared on close/disconnect.
  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ t: "heartbeat" }));
      }
    }, 10_000);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.closed) return;
    this.setState(this.attempt === 0 ? "reconnecting" : "offline");
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt);
    const delay = base / 2 + Math.random() * (base / 2); // jitter
    this.attempt++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private onFrame(raw: string) {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(raw) as ServerFrame;
    } catch {
      return;
    }
    const store = usePresence.getState();
    switch (frame.t) {
      case "welcome":
        store.setSelf(frame.self);
        // Capture the server-clock offset for the synchronized whiteboard timer.
        if (typeof frame.serverTime === "number") {
          serverClockOffsetMs = frame.serverTime - Date.now();
        }
        break;
      case "roster":
        store.setRoster(frame.peers);
        break;
      case "join":
      case "presence":
        store.upsertPeer(frame.peer);
        break;
      case "leave":
        store.removePeer(frame.clientId);
        break;
      case "sync":
        this.onSyncMessage(fromBase64(frame.m));
        break;
      case "locks":
        store.setLocks(frame.locks);
        break;
      case "comment":
        for (const fn of commentListeners) fn(frame.designId);
        break;
      case "vote":
        for (const fn of voteListeners) fn(frame.designId);
        break;
      case "moderated":
        // A facilitator removed us. Stop reconnecting (a ban refuses rejoin and
        // would loop) and let the shell surface it. close() sets closed=true.
        for (const fn of moderatedListeners) fn(frame.action);
        this.close();
        break;
      case "facilitator":
        store.setFacilitator(frame.clientId, frame.name);
        break;
      case "protected":
        store.setProtectedNodes(frame.nodes);
        break;
      case "notify":
        // A new notification landed for us; let the bell refetch its count.
        for (const fn of notifyListeners) fn(frame.designId);
        break;
      case "role":
        // The server re-resolved our per-design role (e.g. approval lock flipped).
        // Notify the editor shell so it updates the access mode + editing gates.
        for (const fn of roleListeners) fn(frame.role, frame.reason);
        // On an UPGRADE to editor, reconverge: while we were a viewer the server
        // never sent us its sync step 1 (it skips that for viewers, sync.ts ~105),
        // so bidirectional sync was never established and our local edits would
        // not flow until the next reconnect. Re-issuing step 1 makes the server
        // reply with any ops we are missing AND its own step 1, so our edits start
        // syncing immediately with no reconnect. Harmless if already converged.
        if (frame.role === "editor" && this.doc) this.sendSyncStep1();
        break;
      case "spotlight": {
        // A facilitator is driving viewports (FR-14). The server already excludes
        // the sender, but guard defensively against acting on our own frame.
        if (frame.from === store.selfClientId()) break;
        if (frame.mode === "start") {
          store.setPresenter(frame.from, frame.name);
        } else if (frame.mode === "stop") {
          if (store.presenter?.clientId === frame.from) store.setFollowing(null);
        } else if (frame.mode === "summon" && frame.viewport) {
          // One-shot snap; `at` is stamped on receipt with the server clock so the
          // banner fades together. useRealtime applies the viewport.
          store.setSummon({ name: frame.name, viewport: frame.viewport, at: serverNow() });
        }
        break;
      }
      default:
        // Unknown tag; ignore.
        break;
    }
  }

  // --- Yjs sync over the socket (slice B) ----------------------------------

  /** Send our state vector (sync step 1) so the peer/server can reply with the
   *  ops we are missing. */
  private sendSyncStep1(): void {
    if (!this.doc) return;
    const enc = encoding.createEncoder();
    syncProtocol.writeSyncStep1(enc, this.doc.ydoc);
    this.sendSync(encoding.toUint8Array(enc));
  }

  /** Wrap one CRDT update as a sync "update" message and broadcast it. */
  private sendUpdate(update: Uint8Array): void {
    const enc = encoding.createEncoder();
    syncProtocol.writeUpdate(enc, update);
    this.sendSync(encoding.toUint8Array(enc));
  }

  /**
   * Read an inbound y-protocols sync message. `readSyncMessage` applies steps 1
   * and 2 and updates the doc (writing any reply, e.g. our step 2 in response to
   * a step 1, into `replyEnc`). Updates are applied with our DesignDoc so they
   * carry the REMOTE origin and never echo back out.
   */
  private onSyncMessage(message: Uint8Array): void {
    if (!this.doc) return;
    const dec = decoding.createDecoder(message);
    const replyEnc = encoding.createEncoder();
    // Use the DesignDoc's apply path (REMOTE origin) for step 2 / update reads
    // by routing through a transaction origin: y-protocols applies directly to
    // the doc, so we tag the whole read with the remote origin via transact.
    this.doc.ydoc.transact(() => {
      syncProtocol.readSyncMessage(dec, replyEnc, this.doc!.ydoc, "remote");
    }, "remote");
    if (encoding.length(replyEnc) > 0) this.sendSync(encoding.toUint8Array(replyEnc));
  }

  /** Send an encoded sync payload as a base64 `{ t: "sync" }` frame. */
  private sendSync(bytes: Uint8Array): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return; // resync on reconnect
    this.ws.send(JSON.stringify({ t: "sync", m: toBase64(bytes) }));
  }

  /**
   * Queue the local presence state for broadcast. Calls are throttled: the most
   * recent state is sent at most once per {@link PRESENCE_THROTTLE_MS}.
   */
  sendPresence(state: PeerState) {
    // Merge into the cached local state so partial updates compose (a reaction
    // or chat ping keeps the latest cursor/selection rather than dropping it).
    this.local = { ...this.local, ...state };
    this.pending = this.local;
    if (this.flushTimer) return; // a flush is already scheduled
    const since = Date.now() - this.lastSentAt;
    const wait = Math.max(0, PRESENCE_THROTTLE_MS - since);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, wait);
  }

  private flush() {
    if (this.pending == null) return;
    if (this.ws?.readyState !== WebSocket.OPEN) return; // resend on reconnect
    this.ws.send(JSON.stringify({ t: "presence", state: this.pending }));
    this.lastSentAt = Date.now();
    this.pending = null;
    // A reaction is a one-shot ping: stop re-broadcasting it on the next cursor
    // frame so peers animate it exactly once.
    if (this.local.reaction) this.local = { ...this.local, reaction: undefined };
  }

  /** Request collaborative locks on `ids`. The server is
   *  authoritative: it grants only ids not held by another client and replies
   *  with the new `{ t: "locks" }` map, so we never optimistically mutate state. */
  sendLock(ids: string[]) {
    if (!ids.length || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ t: "lock", ids }));
  }

  /** Release collaborative locks on `ids` (only those we hold are dropped). */
  sendUnlock(ids: string[]) {
    if (!ids.length || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ t: "unlock", ids }));
  }

  /** Broadcast a facilitator spotlight signal (FR-14): `summon` snaps peers to
   *  `viewport` once; `start`/`stop` toggle sustained take-control. The server
   *  drops this unless we are an editor (the facilitator proxy), so a viewer
   *  calling it is a harmless no-op. */
  sendSpotlight(
    mode: "summon" | "start" | "stop",
    viewport?: { zoom: number; panX: number; panY: number },
  ) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const f: Record<string, unknown> = { t: "spotlight", mode };
    if (viewport) f.viewport = { zoom: viewport.zoom, panX: viewport.panX, panY: viewport.panY };
    this.ws.send(JSON.stringify(f));
  }

  /** Moderate a participant (FR-32): kick (force-disconnect), ban (kick + refuse
   *  rejoin), or unban. Dropped server-side unless we are an editor, so a viewer
   *  calling it is a harmless no-op. `userId` targets all of that user's tabs. */
  sendModerate(action: "kick" | "ban" | "unban", userId: string) {
    if (!userId || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ t: "moderate", action, userId }));
  }

  /** Claim, release, or hand off the session facilitator role (FR-16). Dropped
   *  server-side unless we are an editor; handoff targets a peer's clientId. */
  sendFacilitator(action: "claim" | "release" | "handoff", target?: string) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ t: "facilitator", action, target: target ?? "" }));
  }

  /** Protect/unprotect node ids with a facilitator lock (FR-16). Gated to the
   *  facilitator (or any editor when none is set) server-side. */
  sendProtect(action: "protect" | "unprotect", nodes: string[]) {
    if (!nodes.length || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ t: "protect", action, nodes }));
  }

  /** Tear down the connection and stop reconnecting (call on unmount). */
  close() {
    this.closed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.reconnectTimer = null;
    this.flushTimer = null;
    this.pending = null;
    if (this.unsubDoc) { this.unsubDoc(); this.unsubDoc = null; }
    try {
      this.ws?.close();
    } catch {
      /* already closing */
    }
    this.ws = null;
    usePresence.getState().reset();
    usePresence.getState().setConnection("offline");
  }
}

/** Open a realtime connection for a design and return its client. Pass the
 *  per-design {@link DesignDoc} to also carry Yjs document sync on the socket
 *  (slice B); omit it for a presence-only connection (slice A behavior). */
export function connectRealtime(designId: string, doc: DesignDoc | null = null): RealtimeClient {
  return new RealtimeClient(designId, doc);
}
