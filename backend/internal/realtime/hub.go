package realtime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// lockHeartbeatTTL: a lock holder that has sent no frame or heartbeat within
	// this window is treated as stale and its collaborative locks are released
	// (FR-8: "Locks release on ... a heartbeat timeout"), so a stalled or zombie
	// socket never holds a node indefinitely. The connection itself is left
	// intact; if it revives it simply re-acquires locks.
	lockHeartbeatTTL  = 30 * time.Second
	lockSweepInterval = 10 * time.Second
	// lockStoreTimeout bounds a single cross-instance LockStore (Redis) call so a
	// slow/unreachable store can never wedge a handler goroutine indefinitely.
	lockStoreTimeout = 5 * time.Second

	// Wire hardening (FR-13 defense in depth: the relay cannot inspect the opaque
	// CRDT, so it bounds abuse at the transport instead).
	//
	// maxWSReadBytes caps a single inbound WebSocket frame. Generous enough for a
	// large initial Yjs sync (base64 of full document state) yet a hard ceiling
	// against a memory-exhaustion frame. NOTE: coder/websocket defaults to a 32KiB
	// read limit, which a real design's initial sync exceeds, so this is also the
	// fix that lets large docs sync at all.
	maxWSReadBytes = 32 << 20 // 32 MiB
	// maxUpdateBytes caps the DECODED y-protocols payload of a sync frame.
	maxUpdateBytes = 20 << 20 // 20 MiB
	// Per-connection inbound rate limit (token bucket): a single socket cannot
	// flood the relay with RECOVERABLE frames (presence/lock/unlock). Generous vs.
	// real use (throttled cursors ~22/s + occasional locks stay well under this);
	// a dropped presence is superseded by the next, a dropped lock map is
	// re-assertable. SYNC frames are NOT subject to this limit (an unrecoverable
	// once-only CRDT delta; bounded per-frame by maxUpdateBytes instead), and
	// heartbeats are exempt so liveness is never starved. See dispatch().
	maxFramesPerSec = 120.0
	maxFrameBurst   = 240.0

	// maxConnsPerUser bounds how many simultaneous sockets one user may hold in a
	// single design room. A new connection past the cap evicts that user's oldest
	// socket (so a fresh tab/reconnect always wins) rather than rejecting, which
	// keeps a misbehaving or runaway client from exhausting memory while never
	// breaking a legitimate reconnect. Generous vs. real use (a few tabs).
	maxConnsPerUser = 8
)

// UpdateLog persists editor document updates to the durable journal
// (DesignUpdateLog). Optional; nil = updates are relayed but not journaled
// (snapshots remain the durability mechanism).
type UpdateLog interface {
	AppendUpdate(ctx context.Context, designID string, update []byte, authorID string) error
}

// conn is one live WebSocket connection in a room.
type conn struct {
	clientID string
	userID   string
	designID string
	send     chan []byte
	// cancel tears down this connection's read/write pumps (set by Serve). The hub
	// calls it to force-disconnect a moderated (kicked/banned) participant (FR-32).
	cancel context.CancelFunc
	// lastSeenMs is the unix-millis timestamp of the last inbound frame from this
	// connection (any frame, or an explicit heartbeat). The lock sweeper releases
	// the locks of a connection that has gone quiet past lockHeartbeatTTL. Atomic:
	// written by the connection's read pump, read by the sweeper.
	lastSeenMs atomic.Int64
	// rate is the per-connection inbound flood guard (token bucket).
	rate rateBucket
}

// rateBucket is a token bucket bounding inbound frames per connection. Tokens
// refill lazily from elapsed wall time on each check; it has its own mutex so the
// reader pump can call it without the hub lock.
type rateBucket struct {
	mu     sync.Mutex
	tokens float64
	lastMs int64
}

// allow consumes one token, refilling from elapsed time first. Returns false when
// the bucket is empty (the frame should be dropped). nowMs is injected so the
// behavior is deterministic in tests.
func (b *rateBucket) allow(nowMs int64, ratePerSec, burst float64) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.lastMs == 0 {
		b.lastMs = nowMs
		b.tokens = burst
	}
	if nowMs > b.lastMs {
		b.tokens += float64(nowMs-b.lastMs) / 1000.0 * ratePerSec
		if b.tokens > burst {
			b.tokens = burst
		}
		b.lastMs = nowMs
	}
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// liveRoom is a room's presence registry + lock table + live connections.
type liveRoom struct {
	room  *Room
	locks *lockTable
	conns map[string]*conn
	// facilitator is the clientID currently running the session (FR-16), or "".
	// Server-authoritative + handed off via {t:"facilitator"}; cleared if the
	// facilitator leaves. Per-instance (single-instance / self-host default).
	facilitator string
	// protected is the set of node ids under a facilitator/protected lock (FR-16):
	// only the facilitator may toggle them, and clients block moving/editing them
	// for non-facilitators (cooperative on the edit side, like collaborative locks).
	protected map[string]bool
	// reconcileMu serializes a lock-store reconcile (Snapshot then apply) for this
	// design, so a stale snapshot read can never be applied after a fresher one
	// (which would resurrect a freed lock). Held OFF h.mu, only in
	// reconcileLocksLocal; ordering is always reconcileMu -> h.mu, never the reverse.
	reconcileMu sync.Mutex
}

// Hub is the relay: design rooms with their live connections. Local connections
// are held in memory; a Coordinator (default: no-op) fans relay/awareness frames
// out to peer gateway instances so the hub scales horizontally.
type Hub struct {
	mu        sync.Mutex
	rooms     map[string]*liveRoom
	updateLog UpdateLog
	coord     Coordinator
	// roleResolver re-resolves a user's gateway role (editor/viewer) for a design,
	// used by RefreshRoles to live-downgrade editors when an approval lock engages.
	// Nil = role refresh is a no-op (roles only re-resolve on (re)connect).
	roleResolver func(ctx context.Context, designID, userID string) (string, error)
	// lockStore is the cross-instance lock authority (FR-8). Nil = locks are
	// in-memory per-hub (single instance / self-host, the default). When set,
	// acquire/release go through it (so two instances cannot grant the same node)
	// and the per-room lockTable becomes a cache reconciled from it.
	lockStore LockStore
	// bans maps designID -> set of banned userIDs (FR-32 moderation). A banned user
	// is force-disconnected and refused on rejoin. In-memory per-hub (single
	// instance / self-host); cross-instance ban fan-out is deferred like locks were.
	bans map[string]map[string]bool
}

// NewHub builds a relay. updateLog may be nil. The coordinator defaults to the
// single-instance no-op; use WithCoordinator to enable cross-instance fan-out.
func NewHub(updateLog UpdateLog) *Hub {
	return &Hub{rooms: map[string]*liveRoom{}, updateLog: updateLog, coord: localCoordinator{}, bans: map[string]map[string]bool{}}
}

// WithRoleResolver installs the per-user role resolver (backed by the sharing
// service) so RefreshRoles can push live editor/viewer changes. Returns the hub.
func (h *Hub) WithRoleResolver(fn func(ctx context.Context, designID, userID string) (string, error)) *Hub {
	h.roleResolver = fn
	return h
}

// WithCoordinator installs a cross-instance fan-out coordinator (e.g. Redis) for
// horizontal scaling. Nil is ignored (keeps the local no-op). Returns the hub for
// chaining. Call StartCoordinator after wiring to begin delivering peer frames.
func (h *Hub) WithCoordinator(c Coordinator) *Hub {
	if c != nil {
		h.coord = c
	}
	return h
}

// WithLockStore installs the cross-instance lock authority (e.g. Redis CAS), so
// collaborative locks are authoritative and visible across gateway instances
// (FR-8). Nil is ignored (keeps in-memory per-hub locks). Returns the hub.
func (h *Hub) WithLockStore(s LockStore) *Hub {
	if s != nil {
		h.lockStore = s
	}
	return h
}

// StartCoordinator begins delivering frames published by peer instances into the
// local rooms (no-op for the default local coordinator). Call once from the
// server alongside StartSweeper. Pass a context that is cancelled on shutdown so
// the fan-out pumps tear down deterministically.
func (h *Hub) StartCoordinator(ctx context.Context) {
	h.coord.Start(ctx, h.deliverRemote)
}

// CloseCoordinator releases the fan-out coordinator's resources (e.g. the Redis
// connection pool). No-op for the local default. Call during shutdown after the
// coordinator context is cancelled.
func (h *Hub) CloseCoordinator() error { return h.coord.Close() }

// CloseLockStore releases the cross-instance lock store's resources (its own
// Redis connection pool). No-op when no store is configured. Call on shutdown.
func (h *Hub) CloseLockStore() error {
	if h.lockStore != nil {
		return h.lockStore.Close()
	}
	return nil
}

// ctrlRefreshRoles is a sentinel `except` value marking a cross-instance CONTROL
// signal rather than a client frame: the receiving instance must re-resolve its
// own connections' roles (a live permission downgrade originated on a peer), not
// broadcast the payload. A real clientId is a non-empty UUID, so it can never
// collide with this NUL-prefixed value.
const ctrlRefreshRoles = "\x00ctrl:refresh-roles"

// ctrlRosterRequest is a sentinel `except` marking a cross-instance roster-catchup
// request: a client just joined on a peer instance, so every instance with local
// members for the design re-announces them (cross-instance initial roster, FR-7).
const ctrlRosterRequest = "\x00ctrl:roster-request"

// ctrlLocksChanged is a sentinel `except` marking a cross-instance lock-change
// signal: a lock was acquired/released against the shared LockStore on a peer, so
// every instance reconciles its lock-map cache from the store and rebroadcasts to
// its clients (FR-8 cross-instance lock visibility). Peers do NOT re-publish, so
// there is no fan-out loop.
const ctrlLocksChanged = "\x00ctrl:locks-changed"

// deliverRemote handles a message that ORIGINATED on a peer instance. A control
// signal (sentinel `except`) triggers a local action; any other message is a
// client frame broadcast into this instance's local room. It never re-publishes
// (no fan-out loop) and never re-journals (the originating instance owns
// durability). A frame for a design with no local connections is dropped.
func (h *Hub) deliverRemote(designID, except string, payload []byte) {
	// Cross-instance role refresh: re-resolve THIS instance's connections and push
	// role frames to them. Run off the delivery goroutine (the resolver hits the
	// DB); the local path takes no coordinator action, so there is no fan-out loop.
	if except == ctrlRefreshRoles {
		var reason string
		_ = json.Unmarshal(payload, &reason)
		go h.refreshRolesLocal(context.Background(), designID, reason)
		return
	}
	// Cross-instance roster catchup: a peer instance's client just joined, so
	// re-announce this instance's local members ADDRESSED BACK to that requester
	// (FR-7). The requester's InstanceID rides in the payload. The reply is a
	// targeted publish (never re-published by the requester), so no loop.
	if except == ctrlRosterRequest {
		var requester string
		_ = json.Unmarshal(payload, &requester)
		h.republishLocalRosterTo(designID, requester)
		return
	}
	// Cross-instance lock change: reconcile this instance's lock cache from the
	// shared store and rebroadcast to its clients. Off the delivery goroutine (Redis
	// I/O); peers do not re-publish, so no loop.
	if except == ctrlLocksChanged {
		go h.reconcileLocksLocal(designID)
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if lr, ok := h.rooms[designID]; ok {
		h.broadcastLocked(lr, payload, except)
	}
}

// republishLocalRosterTo re-announces every local member of a design as a `join`
// frame addressed to the requesting instance, so a client that just joined there
// learns about peers connected HERE without waiting for them to emit a frame
// (cross-instance initial roster catchup, FR-7). The frames flow through the
// normal deliverRemote path and are idempotent on clients (peers keyed by
// clientId). Origin dedup means this instance never receives its own re-announce,
// so there is no fan-out loop. No-op when there is no local room.
//
// The lock is held ACROSS the publish loop (publishes are non-blocking and
// lock-safe): this serializes the re-announce against a concurrent Leave on this
// instance, so a member that disconnects mid-re-announce cannot be re-announced
// after its leave frame, which would otherwise resurrect it as a ghost peer.
func (h *Hub) republishLocalRosterTo(designID, requester string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	lr, ok := h.rooms[designID]
	if !ok {
		return
	}
	for _, p := range lr.room.roster() {
		// except "" so the requester broadcasts to all its clients (the re-announced
		// peer lives here, not there, so nothing to exclude). A "" requester (an
		// older peer with no InstanceID) degrades to a broadcast, preserving catchup.
		h.coord.PublishTo(designID, requester, "", frame(map[string]any{"t": "join", "peer": p}))
	}
}

// fanOut broadcasts a locally-originated frame to the local room AND publishes it
// to peer instances (relay/awareness frames only; locks stay instance-local, see
// Coordinator). Caller holds h.mu; Publish is non-blocking.
func (h *Hub) fanOut(lr *liveRoom, designID string, payload []byte, exceptClientID string) {
	h.broadcastLocked(lr, payload, exceptClientID)
	h.coord.Publish(designID, exceptClientID, payload)
}

func (h *Hub) roomFor(designID string) *liveRoom {
	lr, ok := h.rooms[designID]
	if !ok {
		lr = &liveRoom{room: newRoom(designID), locks: newLockTable(), conns: map[string]*conn{}, protected: map[string]bool{}}
		h.rooms[designID] = lr
	}
	return lr
}

// Join registers a connection with no force-disconnect handle (test/helper entry
// point). Production connections go through Serve -> joinConn so a kick can tear
// them down.
func (h *Hub) Join(id PeerIdentity, designID string, serverTimeMs int64) *conn {
	return h.joinConn(id, designID, serverTimeMs, nil)
}

// joinConn registers a connection: adds it to the room, sends welcome/roster/
// locks to it, and broadcasts the join to the rest. Returns the connection
// handle, or nil if the user is banned (FR-32) - checked under h.mu so a ban
// racing this join (which also writes under h.mu) is serialized, closing the
// TOCTOU window. `cancel` tears the connection's pumps down and is stored on the
// conn BEFORE it is observable to a kick, so a concurrent ban always
// force-disconnects it.
func (h *Hub) joinConn(id PeerIdentity, designID string, serverTimeMs int64, cancel context.CancelFunc) *conn {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.bans[designID][id.UserID] {
		return nil // banned: refuse the join under the same lock the ban write holds
	}
	if id.Color == "" {
		id.Color = colorForUser(id.UserID) // stable per-user palette color
	}
	lr := h.roomFor(designID)
	// Per-user connection cap: if this user is already at the cap in this room,
	// evict their oldest socket (smallest lastSeenMs) so a fresh tab/reconnect
	// always succeeds while memory stays bounded.
	h.evictOverCapLocked(lr, id.UserID)
	c := &conn{clientID: id.ClientID, userID: id.UserID, designID: designID, send: make(chan []byte, 64), cancel: cancel}
	c.lastSeenMs.Store(serverTimeMs)
	lr.conns[id.ClientID] = c
	lr.room.join(id)

	c.send <- frame(map[string]any{"t": "welcome", "self": id, "serverTime": serverTimeMs})
	c.send <- frame(map[string]any{"t": "roster", "peers": lr.room.roster()})
	c.send <- frame(map[string]any{"t": "locks", "locks": lr.locks.snapshot()})
	// Catch the newcomer up on the live facilitator + protected-lock state (FR-16).
	c.send <- facilitatorFrame(lr)
	c.send <- frame(map[string]any{"t": "protected", "nodes": protectedList(lr)})
	joined := augmentPresence(id, PresenceState{})
	h.fanOut(lr, designID, frame(map[string]any{"t": "join", "peer": joined}), id.ClientID)
	// Ask peer instances to re-announce their local members so this newcomer sees
	// peers connected to OTHER gateway instances immediately, instead of only as
	// they next emit a frame (cross-instance roster catchup, FR-7). Our InstanceID
	// rides along so peers address the reply back to us (PublishTo), not broadcast.
	// The local roster was already sent above; this fills in remote peers. No-op
	// under the single-instance local coordinator.
	reqID, _ := json.Marshal(h.coord.InstanceID())
	h.coord.Publish(designID, ctrlRosterRequest, reqID)
	// With a cross-instance lock store, the cached lock map sent above may be stale
	// or empty (a freshly-started instance). Reconcile it from the authority and
	// rebroadcast, so the joiner sees locks held on OTHER instances. Async: Redis
	// I/O must not run under h.mu (held here via defer).
	if h.lockStore != nil {
		go h.reconcileLocksLocal(designID)
	}
	return c
}

// removeConnLocked tears down one connection: drop it from the room + lock table,
// fan out the leave (and a fresh lock map if its locks were released), and close
// its outbound channel. Idempotent (a no-op if already gone). Caller holds h.mu
// and is responsible for deleting an emptied room. Shared by Leave and the
// per-user connection-cap eviction.
func (h *Hub) removeConnLocked(lr *liveRoom, c *conn) {
	if _, present := lr.conns[c.clientID]; !present {
		return
	}
	delete(lr.conns, c.clientID)
	lr.room.leave(c.clientID)
	locksChanged := lr.locks.releaseAll(c.clientID)
	h.fanOut(lr, c.designID, frame(map[string]any{"t": "leave", "clientId": c.clientID}), "")
	// If the facilitator left, vacate the role so the session isn't stuck (FR-16).
	if lr.facilitator == c.clientID && len(lr.conns) > 0 {
		lr.facilitator = ""
		h.fanOut(lr, c.designID, facilitatorFrame(lr), "")
	}
	if locksChanged {
		// Local cache cleared immediately; broadcast to local clients.
		h.broadcastLocked(lr, frame(map[string]any{"t": "locks", "locks": lr.locks.snapshot()}), "")
	}
	h.releaseStoreLocksAsync(c.designID, c.clientID)
	close(c.send)
}

// releaseStoreLocksAsync frees a departed connection's locks in the cross-instance
// authority and tells peers, off the hub lock (network I/O). No-op without a store.
// Both teardown paths (Leave on a normal disconnect, removeConnLocked on eviction)
// MUST call this, or a leaver's locks linger in Redis as a ghost holder until TTL.
func (h *Hub) releaseStoreLocksAsync(designID, clientID string) {
	if h.lockStore == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), lockStoreTimeout)
		defer cancel()
		if err := h.lockStore.ReleaseAll(ctx, designID, clientID); err != nil {
			slog.Warn("realtime: lock release-all failed", "err", err)
		}
		// Update our own clients if the room still exists here, and ALWAYS tell peers:
		// on a last-client leave our room is already torn down, so a local reconcile
		// would observe no change and the change-gated fan-out would skip the publish,
		// leaving peers unaware that the authority freed the lock. Leaves are
		// infrequent, so an unconditional publish here is not a storm risk; the peer
		// reconcile still only broadcasts to its clients on an actual change.
		h.reconcileLocksLocal(designID)
		h.coord.Publish(designID, ctrlLocksChanged, nil)
	}()
}

// evictOverCapLocked removes a user's oldest socket(s) in this room until they
// are below maxConnsPerUser, so the about-to-be-added connection stays within
// the cap. Caller holds h.mu.
func (h *Hub) evictOverCapLocked(lr *liveRoom, userID string) {
	for {
		var oldest *conn
		count := 0
		for _, c := range lr.conns {
			if c.userID != userID {
				continue
			}
			count++
			if oldest == nil || c.lastSeenMs.Load() < oldest.lastSeenMs.Load() {
				oldest = c
			}
		}
		if count < maxConnsPerUser || oldest == nil {
			return
		}
		h.removeConnLocked(lr, oldest)
	}
}

// Leave removes a connection, releases its locks, and broadcasts leave + locks.
func (h *Hub) Leave(c *conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	lr, ok := h.rooms[c.designID]
	if !ok {
		return
	}
	if _, present := lr.conns[c.clientID]; !present {
		return
	}
	delete(lr.conns, c.clientID)
	lr.room.leave(c.clientID)
	locksChanged := lr.locks.releaseAll(c.clientID)
	h.fanOut(lr, c.designID, frame(map[string]any{"t": "leave", "clientId": c.clientID}), "")
	// If the facilitator left, vacate the role so the session isn't stuck (FR-16).
	if lr.facilitator == c.clientID && len(lr.conns) > 0 {
		lr.facilitator = ""
		h.fanOut(lr, c.designID, facilitatorFrame(lr), "")
	}
	if locksChanged {
		// Local cache cleared immediately; broadcast to local clients.
		h.broadcastLocked(lr, frame(map[string]any{"t": "locks", "locks": lr.locks.snapshot()}), "")
	}
	// Free this client's locks in the cross-instance authority too, or they linger
	// as a ghost holder until TTL and block live editors (the dominant disconnect
	// path runs here, not removeConnLocked).
	h.releaseStoreLocksAsync(c.designID, c.clientID)
	close(c.send)
	if len(lr.conns) == 0 {
		delete(h.rooms, c.designID)
	}
}

// HandlePresence merges a presence update and broadcasts it to the room.
func (h *Hub) HandlePresence(c *conn, raw map[string]any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	lr, ok := h.rooms[c.designID]
	if !ok {
		return
	}
	peer := lr.room.updatePresence(c.clientID, raw)
	if peer == nil {
		return
	}
	h.fanOut(lr, c.designID, frame(map[string]any{"t": "presence", "peer": peer}), c.clientID)
}

// HandleSpotlight relays a facilitator's spotlight/summon/take-control signal to
// the rest of the room (FR-14). Authority is server-side: only an editor (the
// facilitator proxy until a dedicated facilitator role lands) may drive other
// participants' viewports, so a viewer's frame is dropped exactly like a viewer
// sync frame. The sender's own clientId and display name are stamped on the
// fanned-out frame so recipients can show "[name] is presenting" and (for the
// one-shot summon) snap to the carried viewport. The frame is broadcast to all
// peers except the sender; the facilitator's continuous viewport then flows via
// normal presence and recipients mirror it through follow mode.
func (h *Hub) HandleSpotlight(c *conn, mode string, viewport map[string]any) {
	switch mode {
	case "summon", "start", "stop":
	default:
		return // unknown mode
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	lr, ok := h.rooms[c.designID]
	if !ok {
		return
	}
	id, present := lr.room.identity(c.clientID)
	if !present || id.Role != RoleEditor {
		return // only a facilitator (editor) may drive others' viewports
	}
	payload := map[string]any{"t": "spotlight", "from": c.clientID, "name": id.Name, "mode": mode}
	if vp := sanitizeViewport(viewport); vp != nil {
		payload["viewport"] = vp
	}
	h.fanOut(lr, c.designID, frame(payload), c.clientID)
}

// facilitatorFrame builds the broadcast describing the room's current facilitator
// (clientId "" + name "" when none). Caller holds h.mu.
func facilitatorFrame(lr *liveRoom) []byte {
	name := ""
	if lr.facilitator != "" {
		if id, ok := lr.room.identity(lr.facilitator); ok {
			name = id.Name
		}
	}
	return frame(map[string]any{"t": "facilitator", "clientId": lr.facilitator, "name": name})
}

// protectedList is the sorted node ids under a protected lock. Caller holds h.mu.
func protectedList(lr *liveRoom) []string {
	out := make([]string, 0, len(lr.protected))
	for id := range lr.protected {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// HandleFacilitator claims, releases, or hands off the facilitator role (FR-16).
// Editor-gated. Claim succeeds only when the role is free or already ours;
// release/handoff require being the current facilitator; handoff's target must be
// present. The new state is broadcast to the whole room.
func (h *Hub) HandleFacilitator(c *conn, action, targetClientID string) {
	switch action {
	case "claim", "release", "handoff":
	default:
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	lr, ok := h.rooms[c.designID]
	if !ok {
		return
	}
	id, present := lr.room.identity(c.clientID)
	if !present || id.Role != RoleEditor {
		return // only an editor may run the session
	}
	switch action {
	case "claim":
		if lr.facilitator != "" && lr.facilitator != c.clientID {
			return // someone else is facilitating; they must hand off
		}
		lr.facilitator = c.clientID
	case "release":
		if lr.facilitator != c.clientID {
			return
		}
		lr.facilitator = ""
	case "handoff":
		if lr.facilitator != c.clientID {
			return // only the current facilitator may hand off
		}
		if _, ok := lr.conns[targetClientID]; !ok {
			return // target must be a present participant
		}
		// The target must be an editor: handing the role (and its protected-lock
		// authority) to a viewer would wedge protected nodes for everyone.
		if tid, ok := lr.room.identity(targetClientID); !ok || tid.Role != RoleEditor {
			return
		}
		lr.facilitator = targetClientID
	}
	h.fanOut(lr, c.designID, facilitatorFrame(lr), "")
}

// HandleProtect toggles a protected/facilitator lock on node ids (FR-16). When a
// facilitator is set, only they may protect/unprotect; otherwise any editor may.
// The updated set is broadcast; clients show a lock badge and block moving/editing
// protected nodes for non-facilitators (cooperative, like collaborative locks).
func (h *Hub) HandleProtect(c *conn, action string, nodeIDs []string) {
	switch action {
	case "protect", "unprotect":
	default:
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	lr, ok := h.rooms[c.designID]
	if !ok {
		return
	}
	id, present := lr.room.identity(c.clientID)
	if !present || id.Role != RoleEditor {
		return
	}
	if lr.facilitator != "" && lr.facilitator != c.clientID {
		return // a facilitator owns protected locks while one is set
	}
	changed := false
	for _, n := range nodeIDs {
		if n == "" {
			continue
		}
		if action == "protect" && !lr.protected[n] {
			lr.protected[n] = true
			changed = true
		} else if action == "unprotect" && lr.protected[n] {
			delete(lr.protected, n)
			changed = true
		}
	}
	if changed {
		h.fanOut(lr, c.designID, frame(map[string]any{"t": "protected", "nodes": protectedList(lr)}), "")
	}
}

// IsBanned reports whether a user has been moderated out of a design's room
// (FR-32). Checked at the join boundary so a banned user cannot reconnect.
func (h *Hub) IsBanned(designID, userID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.bans[designID][userID]
}

// HandleModerate lets an editor (the facilitator proxy) kick or ban a participant
// from a board room (FR-32). kick force-disconnects the target's connections; ban
// additionally refuses the target on rejoin until unban. Gated server-side to
// editors like spotlight (a viewer's frame is dropped); a user cannot moderate
// themselves. The target is a userId, so all of their tabs are affected.
func (h *Hub) HandleModerate(c *conn, action, targetUserID string) {
	switch action {
	case "kick", "ban", "unban":
	default:
		return
	}
	if targetUserID == "" || targetUserID == c.userID {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	lr, ok := h.rooms[c.designID]
	if !ok {
		return
	}
	id, present := lr.room.identity(c.clientID)
	if !present || id.Role != RoleEditor {
		return // only an editor/facilitator may moderate
	}
	switch action {
	case "unban":
		if set := h.bans[c.designID]; set != nil {
			delete(set, targetUserID)
			if len(set) == 0 {
				delete(h.bans, c.designID) // reclaim the emptied submap
			}
		}
		return
	case "ban":
		set := h.bans[c.designID]
		if set == nil {
			set = map[string]bool{}
			h.bans[c.designID] = set
		}
		set[targetUserID] = true
		fallthrough
	case "kick":
		// Notify + force-disconnect every connection the target holds in this room.
		// cancel() only signals the target's pump context; the actual Leave runs in
		// the target's own goroutine, so calling it under h.mu cannot deadlock.
		notice := frame(map[string]any{"t": "moderated", "action": action, "designId": c.designID})
		for _, tc := range lr.conns {
			if tc.userID != targetUserID {
				continue
			}
			select {
			case tc.send <- notice:
			default:
			}
			if tc.cancel != nil {
				tc.cancel()
			}
		}
	}
}

// HandleSync relays a y-protocols sync frame. A viewer's frame is dropped
// (read-only enforcement); an editor's update frame is journaled (best-effort)
// and broadcast to the rest of the room.
func (h *Hub) HandleSync(ctx context.Context, c *conn, m string) {
	// Wire validation (defense in depth) BEFORE relaying: the payload must be
	// well-formed base64, within the size cap, and a real y-protocols sync message
	// (0=step1, 1=step2, 2=update). A malformed/oversized/unknown frame is dropped
	// (not relayed to peers, not journaled), so garbage never crosses the room.
	raw, err := base64.StdEncoding.DecodeString(m)
	if err != nil || len(raw) == 0 || len(raw) > maxUpdateBytes {
		return
	}
	switch raw[0] {
	case 0, 1, 2: // y-protocols sync: step1 / step2 / update
	default:
		return
	}

	h.mu.Lock()
	lr, ok := h.rooms[c.designID]
	if !ok {
		h.mu.Unlock()
		return
	}
	id, present := lr.room.identity(c.clientID)
	if !present || id.Role != RoleEditor {
		h.mu.Unlock()
		return // viewers cannot mutate the document
	}
	h.fanOut(lr, c.designID, frame(map[string]any{"t": "sync", "m": m}), c.clientID)
	h.mu.Unlock()

	// Journal y-protocols UPDATE messages (type 2); sync step1/step2 handshakes
	// carry no durable mutation. Best-effort, outside the lock.
	if h.updateLog != nil && raw[0] == 2 {
		_ = h.updateLog.AppendUpdate(ctx, c.designID, raw, id.UserID)
	}
}

// HandleLock / HandleUnlock mutate the room's lock table and broadcast the
// authoritative map only when it changes. With a cross-instance LockStore the
// acquire/release goes through it (so two instances can't grant the same node)
// and the result is reconciled into the local cache + fanned out to peers.
func (h *Hub) HandleLock(c *conn, ids []string) {
	if h.lockStore == nil {
		h.mu.Lock()
		defer h.mu.Unlock()
		lr, ok := h.rooms[c.designID]
		if !ok {
			return
		}
		id, present := lr.room.identity(c.clientID)
		if !present {
			return
		}
		if lr.locks.lock(id, ids) {
			h.broadcastLocked(lr, frame(map[string]any{"t": "locks", "locks": lr.locks.snapshot()}), "")
		}
		return
	}
	// Store path: resolve identity under the lock, then hit the store OUTSIDE it
	// (network I/O must never run under h.mu).
	h.mu.Lock()
	lr, ok := h.rooms[c.designID]
	var id PeerIdentity
	var present bool
	if ok {
		id, present = lr.room.identity(c.clientID)
	}
	h.mu.Unlock()
	if !ok || !present || id.Role != RoleEditor {
		return // viewers (and gone connections) cannot lock
	}
	ctx, cancel := context.WithTimeout(context.Background(), lockStoreTimeout)
	defer cancel()
	if _, _, err := h.lockStore.Acquire(ctx, c.designID, ids, holderOf(id), lockHeartbeatTTL); err != nil {
		slog.Warn("realtime: lock acquire failed", "err", err)
		return
	}
	h.reconcileLocksAndFanOut(c.designID)
}

func (h *Hub) HandleUnlock(c *conn, ids []string) {
	if h.lockStore == nil {
		h.mu.Lock()
		defer h.mu.Unlock()
		lr, ok := h.rooms[c.designID]
		if !ok {
			return
		}
		if lr.locks.unlock(c.clientID, ids) {
			h.broadcastLocked(lr, frame(map[string]any{"t": "locks", "locks": lr.locks.snapshot()}), "")
		}
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), lockStoreTimeout)
	defer cancel()
	if err := h.lockStore.Release(ctx, c.designID, c.clientID, ids); err != nil {
		slog.Warn("realtime: lock release failed", "err", err)
		return
	}
	h.reconcileLocksAndFanOut(c.designID)
}

// reconcileLocksLocal refreshes a room's lock-map cache from the shared store
// (the authority) and rebroadcasts to local clients only if the map changed.
// Returns whether the map changed. No-op (false) without a store or a local room.
// Does Redis I/O, so never call under h.mu. The per-room reconcileMu serializes
// the Snapshot+apply so a stale read can't overwrite a fresher one.
func (h *Hub) reconcileLocksLocal(designID string) bool {
	if h.lockStore == nil {
		return false
	}
	h.mu.Lock()
	lr, ok := h.rooms[designID]
	h.mu.Unlock()
	if !ok {
		return false
	}
	lr.reconcileMu.Lock()
	defer lr.reconcileMu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), lockStoreTimeout)
	defer cancel()
	snap, err := h.lockStore.Snapshot(ctx, designID)
	if err != nil {
		return false
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	cur, ok := h.rooms[designID]
	if !ok || cur != lr { // room torn down or replaced while we read the store
		return false
	}
	if lr.locks.replace(snap) {
		h.broadcastLocked(lr, frame(map[string]any{"t": "locks", "locks": lr.locks.snapshot()}), "")
		return true
	}
	return false
}

// reconcileLocksAndFanOut reconciles the local cache from the store, and signals
// peer instances to do the same ONLY when the map actually changed - so an
// idempotent re-lock / no-op release does not amplify into a cross-instance
// Snapshot storm. The fan-out publish is non-blocking.
func (h *Hub) reconcileLocksAndFanOut(designID string) {
	if h.reconcileLocksLocal(designID) {
		h.coord.Publish(designID, ctrlLocksChanged, nil)
	}
}

// touch records liveness for a connection. Any inbound frame (an edit, presence,
// lock, or an explicit heartbeat) keeps the connection's collaborative locks
// alive against the heartbeat-timeout sweep (FR-8).
func (h *Hub) touch(c *conn) { c.lastSeenMs.Store(time.Now().UnixMilli()) }

// sweepStaleLocks releases the collaborative locks of any holder whose last
// inbound frame predates nowMs-ttlMs and broadcasts the updated lock map, so a
// stalled or zombie socket never holds a node indefinitely (FR-8). The
// connection is left intact (a revived client simply re-acquires). Returns the
// number of rooms whose lock map changed (for tests/metrics).
func (h *Hub) sweepStaleLocks(nowMs, ttlMs int64) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	changed := 0
	for _, lr := range h.rooms {
		roomChanged := false
		for cid, c := range lr.conns {
			if nowMs-c.lastSeenMs.Load() > ttlMs {
				if lr.locks.releaseAll(cid) {
					roomChanged = true
				}
			}
		}
		if roomChanged {
			h.broadcastLocked(lr, frame(map[string]any{"t": "locks", "locks": lr.locks.snapshot()}), "")
			changed++
		}
	}
	return changed
}

// storeFullReconcileEveryNSweeps: a crashed peer instance's locks expire silently
// in Redis (no event), so every instance must occasionally reconcile a quiet room
// from the store to surface that. Doing it every tick is a per-room Snapshot storm
// proportional to room count; doing it every Nth tick (here ~60s at a 10s sweep)
// catches expiry within bounded latency at a fraction of the Redis traffic.
const storeFullReconcileEveryNSweeps = 6

// sweepStaleLocksStore is the cross-instance-store variant of the sweep: stale
// local holders are released from the shared authority (so peers see it) and live
// local holders have their store TTL refreshed (so an active holder never loses a
// lock to expiry). On a `fullReconcile` tick it also reconciles quiet rooms from
// the store, to catch locks whose holding instance crashed and let them TTL-expire.
// Redis I/O runs OUTSIDE h.mu, so it gathers work under the lock first.
func (h *Hub) sweepStaleLocksStore(nowMs, ttlMs int64, fullReconcile bool) {
	type roomWork struct {
		designID     string
		stale, alive []string
	}
	var work []roomWork
	h.mu.Lock()
	for designID, lr := range h.rooms {
		var stale, alive []string
		for cid, c := range lr.conns {
			if nowMs-c.lastSeenMs.Load() > ttlMs {
				stale = append(stale, cid)
			} else {
				alive = append(alive, cid)
			}
		}
		work = append(work, roomWork{designID, stale, alive})
	}
	h.mu.Unlock()

	for _, w := range work {
		ctx, cancel := context.WithTimeout(context.Background(), lockStoreTimeout)
		for _, cid := range w.stale {
			if err := h.lockStore.ReleaseAll(ctx, w.designID, cid); err != nil {
				slog.Warn("realtime: sweep release-all failed", "err", err)
			}
		}
		for _, cid := range w.alive {
			_ = h.lockStore.Refresh(ctx, w.designID, cid, lockHeartbeatTTL)
		}
		// Freeing a stale local holder always reconciles + fans out promptly. A quiet
		// room is reconciled only on the coarse fullReconcile tick (crashed-peer
		// expiry catch), not every tick - reconcileLocksAndFanOut/Local only
		// broadcast/publish on an actual change anyway.
		if len(w.stale) > 0 {
			h.reconcileLocksAndFanOut(w.designID)
		} else if fullReconcile {
			h.reconcileLocksLocal(w.designID)
		}
		cancel()
	}
}

// StartSweeper runs the heartbeat-timeout lock sweep on a ticker until ctx is
// done. Call once from the server; tests drive the sweep methods directly.
func (h *Hub) StartSweeper(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(lockSweepInterval)
		defer ticker.Stop()
		var tick int
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if h.lockStore != nil {
					tick++
					h.sweepStaleLocksStore(time.Now().UnixMilli(), lockHeartbeatTTL.Milliseconds(), tick%storeFullReconcileEveryNSweeps == 0)
				} else {
					h.sweepStaleLocks(time.Now().UnixMilli(), lockHeartbeatTTL.Milliseconds())
				}
			}
		}
	}()
}

// RefreshRoles re-resolves the gateway role of every connection in a design room
// and pushes a `role` frame to any whose role changed, so an editor is downgraded
// to viewer LIVE when an approval lock engages (and restored on unlock) instead of
// only on reconnect (F16 AC-9). Implements approvals.RoleRefresher. It refreshes
// THIS instance's connections AND signals peer instances (via the coordinator) to
// refresh theirs, so the live downgrade reaches editors on any gateway instance.
func (h *Hub) RefreshRoles(ctx context.Context, designID, reason string) {
	if h.roleResolver == nil {
		return
	}
	h.refreshRolesLocal(ctx, designID, reason)
	// Signal peers to re-resolve their own connections (cross-instance live
	// downgrade). The reason rides as a JSON-string payload; the sentinel `except`
	// routes it to refreshRolesLocal on each peer, never to clients, and peers do
	// not re-publish, so there is no fan-out loop. No-op under the local default.
	reasonJSON, _ := json.Marshal(reason)
	h.coord.Publish(designID, ctrlRefreshRoles, reasonJSON)
}

// refreshRolesLocal re-resolves and pushes role changes for THIS instance's
// connections only (no cross-instance publish). The role resolver runs OUTSIDE
// the hub lock (it hits the DB); only the snapshot + apply steps hold it.
func (h *Hub) refreshRolesLocal(ctx context.Context, designID, reason string) {
	if h.roleResolver == nil {
		return
	}
	type entry struct{ clientID, userID string }
	h.mu.Lock()
	lr, ok := h.rooms[designID]
	if !ok {
		h.mu.Unlock()
		return
	}
	entries := make([]entry, 0, len(lr.conns))
	for cid, c := range lr.conns {
		entries = append(entries, entry{cid, c.userID})
	}
	h.mu.Unlock()

	for _, e := range entries {
		role, err := h.roleResolver(ctx, designID, e.userID)
		if err != nil || (role != string(RoleEditor) && role != string(RoleViewer)) {
			continue
		}
		h.mu.Lock()
		lr, ok := h.rooms[designID]
		if !ok {
			h.mu.Unlock()
			return
		}
		if c, present := lr.conns[e.clientID]; present && lr.room.setRole(e.clientID, Role(role)) {
			select {
			case c.send <- frame(map[string]any{"t": "role", "role": role, "reason": reason}):
			default:
			}
		}
		h.mu.Unlock()
	}
}

// NotifyCommentChanged broadcasts a comment-mutation signal to a design room
// (satisfies comments.Realtime). Clients refetch over REST.
func (h *Hub) NotifyCommentChanged(ctx context.Context, designID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	lr, ok := h.rooms[designID]
	if !ok {
		return
	}
	h.fanOut(lr, designID, frame(map[string]any{"t": "comment", "op": "changed", "designId": designID}), "")
}

// NotifyVoteChanged broadcasts a vote-mutation signal to a design room
// (satisfies whiteboard.Realtime). Clients refetch the tally over REST, so the
// relay never has to understand the vote payload (F30 FR-19).
func (h *Hub) NotifyVoteChanged(ctx context.Context, designID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	lr, ok := h.rooms[designID]
	if !ok {
		return
	}
	h.fanOut(lr, designID, frame(map[string]any{"t": "vote", "op": "changed", "designId": designID}), "")
}

// broadcastLocked sends a payload to every connection in the room except
// `exceptClientID` (use "" to send to all). Caller holds h.mu. Non-blocking: a
// full send buffer drops the frame for that slow client.
func (h *Hub) broadcastLocked(lr *liveRoom, payload []byte, exceptClientID string) {
	for cid, c := range lr.conns {
		if cid == exceptClientID {
			continue
		}
		select {
		case c.send <- payload:
		default:
		}
	}
}

func frame(v map[string]any) []byte {
	b, _ := json.Marshal(v)
	return b
}
