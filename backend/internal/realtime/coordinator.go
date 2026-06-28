package realtime

import "context"

// Coordinator fans room frames out to peer gateway instances so the hub scales
// horizontally (FR-9 / roadmap doc 16, section 8: "fans out awareness via Redis
// pub/sub so the gateway scales horizontally"). The default implementation
// (localCoordinator) is a no-op: a single instance already reaches every
// connected client through its in-memory broadcast, so nothing needs to cross a
// process boundary. The Redis implementation (RedisCoordinator) publishes
// locally-originated frames to a shared channel and delivers peers' frames back
// into local rooms, so a client on instance A and a client on instance B
// converge.
//
// Only RELAY and AWARENESS frames are fanned out: sync (the Yjs CRDT bytes,
// which carry document convergence), presence, join, leave, and the
// comment-changed signal. Two non-frame CONTROL signals also cross instances:
// a role-refresh trigger (sentinel `except` ctrlRefreshRoles) so a live permission
// downgrade re-resolves editors on every instance (F16 AC-9), and a lock-changed
// trigger (ctrlLocksChanged) so every instance reconciles its lock cache from the
// shared store (FR-8).
//
// Collaborative LOCKS are now cross-instance-authoritative via a Redis CAS
// LockStore (lockstore.go): acquisition is atomic across instances (no double-
// grant) and a crashed instance's locks auto-expire (TTL). Lock changes fan out
// the ctrlLocksChanged signal and each instance reconciles from the store, so a
// client sees locks held on any instance. Without a store (no REDIS_URL) the lock
// table is in-memory per-hub (single instance / self-host), as before.
//
// Initial roster catchup IS handled: on Join, an instance publishes a roster-
// request control signal (sentinel `except` ctrlRosterRequest) carrying its own
// InstanceID; every peer with local members for the design re-announces them as
// `join` frames addressed back to the requester via PublishTo, so a newcomer sees
// peers on other instances immediately rather than only as they next emit a frame.
// Routing the reply (rather than broadcasting it) keeps a join O(N*M), not
// O(N^2*M), and avoids redundant re-announces to clients that already hold the
// peers. The frames reuse the normal join path and are idempotent on clients.
//
// A crashed instance's locks are no longer a gap: with the Redis lock store each
// node key carries a TTL, so a dead instance's locks auto-expire, and every
// instance's store-aware sweep reconciles its cache from the store, surfacing the
// release. (Awareness presence/cursors for a crashed instance still clear only
// when its socket-close or the next frame is observed, but that is ephemeral and
// not data loss.)
type Coordinator interface {
	// Publish hands a locally-originated room frame to ALL peer instances. It MUST
	// be non-blocking and safe to call while the hub mutex is held: the local impl
	// is a no-op, and the Redis impl enqueues to a buffered channel drained by a
	// background goroutine. `except` is the clientId the originating instance
	// already excluded from its local broadcast (the sender); a peer instance has
	// no such connection, so it broadcasts the frame to all of its local members.
	Publish(designID, except string, payload []byte)

	// PublishTo is Publish addressed to a SINGLE peer instance (by InstanceID), so
	// a reply (e.g. roster catchup re-announce) reaches only the requester instead
	// of fanning out to every instance and every client. Same non-blocking / lock-
	// safe contract as Publish. A target of "" degrades to a broadcast (Publish).
	PublishTo(designID, targetInstanceID, except string, payload []byte)

	// InstanceID is this gateway instance's stable id, carried on a request so a
	// peer can address its reply back with PublishTo. "" for the local no-op impl
	// (single instance: there is no cross-instance addressing).
	InstanceID() string

	// Start begins delivering peer frames by invoking deliver(designID, except,
	// payload) for each frame published by ANOTHER instance (never the caller's
	// own). The hub passes deliverRemote, which broadcasts the frame into its
	// local room without re-publishing or re-journaling it. Returns immediately;
	// background goroutines run until ctx is done. No-op for the local impl.
	Start(ctx context.Context, deliver func(designID, except string, payload []byte))

	// Close releases resources (e.g. Redis connections). No-op for the local impl.
	Close() error
}

// localCoordinator is the single-instance default: fan-out is unnecessary because
// the hub's in-memory broadcast already reaches every connected client.
type localCoordinator struct{}

func (localCoordinator) Publish(string, string, []byte)                      {}
func (localCoordinator) PublishTo(string, string, string, []byte)            {}
func (localCoordinator) InstanceID() string                                  { return "" }
func (localCoordinator) Start(context.Context, func(string, string, []byte)) {}
func (localCoordinator) Close() error                                        { return nil }
