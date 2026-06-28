package realtime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"
)

// memBus models Redis pub/sub in-process so the hub's cross-instance fan-out can
// be tested without a Redis server: a frame published by one coordinator is
// delivered ASYNCHRONOUSLY to every OTHER coordinator on the bus (origin dedup,
// like RedisCoordinator skipping its own instanceID). Async delivery mirrors
// Redis and avoids a cross-hub lock-ordering deadlock, since Publish is called
// while the originating hub holds its mutex.
type memBus struct {
	mu      sync.Mutex
	seq     int
	members []*memCoord
}

type memCoord struct {
	bus     *memBus
	id      string
	deliver func(string, string, []byte)
}

func (b *memBus) newCoord() *memCoord {
	b.mu.Lock()
	b.seq++
	c := &memCoord{bus: b, id: "inst-" + strconv.Itoa(b.seq)}
	b.members = append(b.members, c)
	b.mu.Unlock()
	return c
}

func (c *memCoord) InstanceID() string { return c.id }

// fanout delivers to peers matching target ("" = all), with origin dedup.
func (c *memCoord) fanout(designID, target, except string, payload []byte) {
	c.bus.mu.Lock()
	var fns []func(string, string, []byte)
	for _, m := range c.bus.members {
		if m != c && m.deliver != nil && (target == "" || m.id == target) {
			fns = append(fns, m.deliver)
		}
	}
	c.bus.mu.Unlock()
	for _, fn := range fns {
		go fn(designID, except, payload)
	}
}

func (c *memCoord) Publish(designID, except string, payload []byte) {
	c.fanout(designID, "", except, payload)
}

func (c *memCoord) PublishTo(designID, target, except string, payload []byte) {
	c.fanout(designID, target, except, payload)
}

func (c *memCoord) Start(_ context.Context, deliver func(string, string, []byte)) {
	c.bus.mu.Lock()
	c.deliver = deliver
	c.bus.mu.Unlock()
}

func (c *memCoord) Close() error { return nil }

// awaitFrame waits up to 2s for a frame of type want on ch, discarding others.
func awaitFrame(t *testing.T, ch chan []byte, want string) map[string]any {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case b := <-ch:
			var m map[string]any
			if json.Unmarshal(b, &m) == nil && m["t"] == want {
				return m
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %q frame", want)
			return nil
		}
	}
}

// noFrame reports whether NO frame of type want arrives on ch within `within`.
func noFrame(ch chan []byte, want string, within time.Duration) bool {
	deadline := time.After(within)
	for {
		select {
		case b := <-ch:
			var m map[string]any
			if json.Unmarshal(b, &m) == nil && m["t"] == want {
				return false
			}
		case <-deadline:
			return true
		}
	}
}

// TestCrossInstanceFanOut: two hubs share a bus (two gateway instances). A client
// on each joins the same design. Relay + awareness frames (join, sync, presence)
// cross between instances; LOCKS stay instance-local; a publisher never receives
// an echo of its own frame.
func TestCrossInstanceFanOut(t *testing.T) {
	bus := &memBus{}
	ctx := context.Background()
	hubA := NewHub(nil).WithCoordinator(bus.newCoord())
	hubA.StartCoordinator(ctx)
	hubB := NewHub(nil).WithCoordinator(bus.newCoord())
	hubB.StartCoordinator(ctx)

	a := hubA.Join(PeerIdentity{ClientID: "a", UserID: "ua", Name: "A", Role: RoleEditor}, "d1", 1000)
	b := hubB.Join(PeerIdentity{ClientID: "b", UserID: "ub", Name: "B", Role: RoleEditor}, "d1", 1000)

	// A (instance A) sees B (instance B) join.
	join := awaitFrame(t, a.send, "join")
	if peer := join["peer"].(map[string]any); peer["clientId"] != "b" {
		t.Fatalf("A should see B join across instances: %v", peer)
	}

	// B's editor sync update reaches A across instances (document convergence).
	update := base64.StdEncoding.EncodeToString([]byte{2, 7, 7}) // type-2 (update)
	hubB.HandleSync(ctx, b, update)
	sync := awaitFrame(t, a.send, "sync")
	if sync["m"] != update {
		t.Fatalf("A should receive B's sync across instances: %v", sync["m"])
	}

	// B presence reaches A across instances.
	hubB.HandlePresence(b, map[string]any{"cursor": map[string]any{"x": 5.0, "y": 6.0}})
	pres := awaitFrame(t, a.send, "presence")
	if peer := pres["peer"].(map[string]any); peer["clientId"] != "b" {
		t.Fatalf("A should receive B presence across instances: %v", peer)
	}

	// LOCKS are instance-authoritative and NOT fanned out: B's lock must not reach
	// A, though B's own instance records it.
	hubB.HandleLock(b, []string{"node-z"})
	if !noFrame(a.send, "locks", 250*time.Millisecond) {
		t.Fatal("locks must stay instance-local (not fanned out across instances)")
	}
	if _, held := hubB.rooms["d1"].locks.snapshot()["node-z"]; !held {
		t.Fatal("B's instance should hold the lock locally")
	}

	// No echo: A's own sync must not come back to A, but must reach B.
	updateA := base64.StdEncoding.EncodeToString([]byte{2, 1, 1})
	hubA.HandleSync(ctx, a, updateA)
	syncB := awaitFrame(t, b.send, "sync")
	if syncB["m"] != updateA {
		t.Fatalf("B should receive A's sync: %v", syncB["m"])
	}
	if !noFrame(a.send, "sync", 250*time.Millisecond) {
		t.Fatal("A must not receive an echo of its own published sync")
	}
}

// TestCrossInstanceLeave: a disconnect on one instance reaches peers on another.
func TestCrossInstanceLeave(t *testing.T) {
	bus := &memBus{}
	ctx := context.Background()
	hubA := NewHub(nil).WithCoordinator(bus.newCoord())
	hubA.StartCoordinator(ctx)
	hubB := NewHub(nil).WithCoordinator(bus.newCoord())
	hubB.StartCoordinator(ctx)

	a := hubA.Join(PeerIdentity{ClientID: "a", UserID: "ua", Role: RoleEditor}, "d1", 1000)
	b := hubB.Join(PeerIdentity{ClientID: "b", UserID: "ub", Role: RoleEditor}, "d1", 1000)
	awaitFrame(t, a.send, "join") // A saw B join

	hubB.Leave(b)
	leave := awaitFrame(t, a.send, "leave")
	if leave["clientId"] != "b" {
		t.Fatalf("A should see B leave across instances: %v", leave)
	}
}

// TestCrossInstanceRoleRefresh: an approval lock engaging on instance A live-
// downgrades an editor connected to instance B (F16 AC-9 across instances).
// RefreshRoles on A re-resolves A's own connections AND signals peers; B re-
// resolves its local connection and pushes it a `role` frame, no reconnect.
func TestCrossInstanceRoleRefresh(t *testing.T) {
	bus := &memBus{}
	ctx := context.Background()
	// Resolver simulates the lock: every editor now resolves to viewer.
	resolver := func(context.Context, string, string) (string, error) { return string(RoleViewer), nil }
	hubA := NewHub(nil).WithCoordinator(bus.newCoord()).WithRoleResolver(resolver)
	hubA.StartCoordinator(ctx)
	hubB := NewHub(nil).WithCoordinator(bus.newCoord()).WithRoleResolver(resolver)
	hubB.StartCoordinator(ctx)

	// An editor connected to instance B; instance A has no local connections.
	b := hubB.Join(PeerIdentity{ClientID: "b", UserID: "ub", Role: RoleEditor}, "d1", 1000)

	// The lock engages and is handled by instance A.
	hubA.RefreshRoles(ctx, "d1", "approval-locked")

	role := awaitFrame(t, b.send, "role")
	if role["role"] != string(RoleViewer) {
		t.Fatalf("B's editor should be live-downgraded to viewer across instances: %v", role)
	}
	if role["reason"] != "approval-locked" {
		t.Fatalf("downgrade reason should cross instances: %v", role)
	}
}

// TestCrossInstanceRosterCatchup: a client already connected to instance B is
// visible to a newcomer on instance A, WITHOUT B emitting any new frame, via the
// roster-request the newcomer's Join publishes (cross-instance initial roster).
func TestCrossInstanceRosterCatchup(t *testing.T) {
	bus := &memBus{}
	ctx := context.Background()
	hubA := NewHub(nil).WithCoordinator(bus.newCoord())
	hubA.StartCoordinator(ctx)
	hubB := NewHub(nil).WithCoordinator(bus.newCoord())
	hubB.StartCoordinator(ctx)

	// B's (idle) client is in the room BEFORE A's client joins.
	_ = hubB.Join(PeerIdentity{ClientID: "b", UserID: "ub", Name: "B", Role: RoleEditor}, "d1", 1000)
	a := hubA.Join(PeerIdentity{ClientID: "a", UserID: "ua", Name: "A", Role: RoleEditor}, "d1", 1000)

	// A's newcomer learns about the idle peer B via catchup (B never re-emits).
	join := awaitFrame(t, a.send, "join")
	if peer := join["peer"].(map[string]any); peer["clientId"] != "b" {
		t.Fatalf("A's newcomer should catch up idle peer B across instances: %v", peer)
	}
}

// fakeLockStore is a shared in-memory LockStore standing in for Redis CAS, so the
// cross-instance lock authority can be tested without a Redis server. Acquire is a
// compare-by-clientId SET-if-absent; Release/ReleaseAll are compare-by-clientId
// deletes. TTL is ignored (the authority + visibility paths don't depend on it).
type fakeLockStore struct {
	mu        sync.Mutex
	m         map[string]map[string]LockHolder // designID -> nodeID -> holder
	refreshes map[string]int                   // clientID -> Refresh call count (test observability)
}

func newFakeLockStore() *fakeLockStore {
	return &fakeLockStore{m: map[string]map[string]LockHolder{}, refreshes: map[string]int{}}
}

func (f *fakeLockStore) design(designID string) map[string]LockHolder {
	d := f.m[designID]
	if d == nil {
		d = map[string]LockHolder{}
		f.m[designID] = d
	}
	return d
}

func (f *fakeLockStore) Acquire(_ context.Context, designID string, nodeIDs []string, holder LockHolder, _ time.Duration) ([]string, LockMap, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	d := f.design(designID)
	var granted []string
	denied := LockMap{}
	for _, n := range nodeIDs {
		if cur, ok := d[n]; ok && cur.ClientID != holder.ClientID {
			denied[n] = cur
			continue
		}
		d[n] = holder
		granted = append(granted, n)
	}
	return granted, denied, nil
}

func (f *fakeLockStore) Release(_ context.Context, designID, clientID string, nodeIDs []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	d := f.design(designID)
	for _, n := range nodeIDs {
		if cur, ok := d[n]; ok && cur.ClientID == clientID {
			delete(d, n)
		}
	}
	return nil
}

func (f *fakeLockStore) ReleaseAll(_ context.Context, designID, clientID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for n, cur := range f.design(designID) {
		if cur.ClientID == clientID {
			delete(f.m[designID], n)
		}
	}
	return nil
}

func (f *fakeLockStore) Refresh(_ context.Context, _ string, clientID string, _ time.Duration) error {
	f.mu.Lock()
	f.refreshes[clientID]++
	f.mu.Unlock()
	return nil
}

func (f *fakeLockStore) refreshCount(clientID string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.refreshes[clientID]
}

func (f *fakeLockStore) Snapshot(_ context.Context, designID string) (LockMap, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := LockMap{}
	for n, h := range f.design(designID) {
		out[n] = h
	}
	return out, nil
}

func (f *fakeLockStore) holderOf(designID, nodeID string) (LockHolder, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	h, ok := f.design(designID)[nodeID]
	return h, ok
}

func (f *fakeLockStore) Close() error { return nil }

// awaitLocks waits for a "locks" frame on ch whose map satisfies pred.
func awaitLocks(t *testing.T, ch chan []byte, pred func(map[string]any) bool) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case b := <-ch:
			var m map[string]any
			if json.Unmarshal(b, &m) == nil && m["t"] == "locks" {
				if lm, ok := m["locks"].(map[string]any); ok && pred(lm) {
					return
				}
			}
		case <-deadline:
			t.Fatal("timed out waiting for the expected locks frame")
			return
		}
	}
}

// TestCrossInstanceLockAuthority: a lock taken on instance B is authoritative and
// visible on instance A; A cannot grab the same node; releasing on B frees it for A.
func TestCrossInstanceLockAuthority(t *testing.T) {
	bus := &memBus{}
	store := newFakeLockStore()
	ctx := context.Background()
	hubA := NewHub(nil).WithCoordinator(bus.newCoord()).WithLockStore(store)
	hubA.StartCoordinator(ctx)
	hubB := NewHub(nil).WithCoordinator(bus.newCoord()).WithLockStore(store)
	hubB.StartCoordinator(ctx)

	a := hubA.Join(PeerIdentity{ClientID: "a", UserID: "ua", Name: "A", Role: RoleEditor}, "d1", 1000)
	b := hubB.Join(PeerIdentity{ClientID: "b", UserID: "ub", Name: "B", Role: RoleEditor}, "d1", 1000)
	awaitFrame(t, a.send, "join") // A sees B

	// B's client locks node-x; A's client sees it held by B (cross-instance visibility).
	hubB.HandleLock(b, []string{"node-x"})
	awaitLocks(t, a.send, func(lm map[string]any) bool {
		h, ok := lm["node-x"].(map[string]any)
		return ok && h["clientId"] == "b"
	})

	// A's client tries to grab the SAME node: the authority denies it; B stays holder.
	hubA.HandleLock(a, []string{"node-x"})
	if h, ok := store.holderOf("d1", "node-x"); !ok || h.ClientID != "b" {
		t.Fatalf("authority must keep B as holder of node-x, got %+v (ok=%v)", h, ok)
	}
	// A's OWN view must still show B (not promote A) after the denied attempt - this
	// exercises A's deny path, not just the store's incumbent, so a regression in A's
	// acquire/role gate would be caught. Reconcile is async; poll briefly.
	deadline := time.Now().Add(time.Second)
	for {
		hubA.mu.Lock()
		hh, ok := hubA.rooms["d1"].locks.snapshot()["node-x"]
		hubA.mu.Unlock()
		if ok && hh.ClientID == "b" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("A's cache must still show B holding node-x after A's denied attempt, got %+v (ok=%v)", hh, ok)
		}
		time.Sleep(10 * time.Millisecond)
	}

	// B releases; A sees node-x free across instances.
	hubB.HandleUnlock(b, []string{"node-x"})
	awaitLocks(t, a.send, func(lm map[string]any) bool {
		_, still := lm["node-x"]
		return !still
	})
}

// TestLockStoreSweepReleasesStaleHolder: the store-aware sweep frees a stale local
// holder's locks from the authority and propagates the release to a peer instance.
func TestLockStoreSweepReleasesStaleHolder(t *testing.T) {
	bus := &memBus{}
	store := newFakeLockStore()
	ctx := context.Background()
	hubA := NewHub(nil).WithCoordinator(bus.newCoord()).WithLockStore(store)
	hubA.StartCoordinator(ctx)
	hubB := NewHub(nil).WithCoordinator(bus.newCoord()).WithLockStore(store)
	hubB.StartCoordinator(ctx)

	now := time.Now().UnixMilli()
	a := hubA.Join(PeerIdentity{ClientID: "a", UserID: "ua", Name: "A", Role: RoleEditor}, "d1", now)
	b := hubB.Join(PeerIdentity{ClientID: "b", UserID: "ub", Name: "B", Role: RoleEditor}, "d1", now)
	awaitFrame(t, a.send, "join")

	hubB.HandleLock(b, []string{"node-y"})
	awaitLocks(t, a.send, func(lm map[string]any) bool { _, ok := lm["node-y"]; return ok })

	// ALIVE branch: B is fresh (lastSeen == now). The sweep must REFRESH B's TTL and
	// keep the lock, never free it.
	hubB.sweepStaleLocksStore(now, lockHeartbeatTTL.Milliseconds(), true)
	if _, ok := store.holderOf("d1", "node-y"); !ok {
		t.Fatal("sweep must not free a live holder's lock")
	}
	if store.refreshCount("b") == 0 {
		t.Fatal("sweep must refresh a live holder's store TTL")
	}

	// STALE branch: drive B's last-seen explicitly past the TTL, then sweep frees it.
	b.lastSeenMs.Store(now - lockHeartbeatTTL.Milliseconds() - 1)
	hubB.sweepStaleLocksStore(now, lockHeartbeatTTL.Milliseconds(), false)
	if _, ok := store.holderOf("d1", "node-y"); ok {
		t.Fatal("sweep should have freed the stale holder's lock in the authority")
	}
	awaitLocks(t, a.send, func(lm map[string]any) bool { _, still := lm["node-y"]; return !still })
}

// TestRedisLockStore_Integration exercises the REAL RedisLockStore (SET NX, the
// compare-and-delete Lua, the index set, snapshot self-heal) against a live
// server. Skipped unless REDIS_URL is set, so CI without Redis stays green.
func TestRedisLockStore_Integration(t *testing.T) {
	url := os.Getenv("REDIS_URL")
	if url == "" {
		t.Skip("REDIS_URL not set; skipping redis lock-store integration test")
	}
	ctx := context.Background()
	s, err := NewRedisLockStore(ctx, url)
	if err != nil {
		t.Fatalf("lock store: %v", err)
	}
	defer s.Close()

	design := "lktest-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	ca := LockHolder{ClientID: "ca", UserID: "ua", Name: "A"}
	cb := LockHolder{ClientID: "cb", UserID: "ub", Name: "B"}
	ttl := 30 * time.Second
	defer func() { _ = s.ReleaseAll(ctx, design, "ca"); _ = s.ReleaseAll(ctx, design, "cb") }()

	// A grabs n1,n2.
	g, d, err := s.Acquire(ctx, design, []string{"n1", "n2"}, ca, ttl)
	if err != nil || len(g) != 2 || len(d) != 0 {
		t.Fatalf("A acquire n1,n2: granted=%v denied=%v err=%v", g, d, err)
	}
	// B grabs n2 (denied, held by A) + n3 (granted).
	g2, d2, err := s.Acquire(ctx, design, []string{"n2", "n3"}, cb, ttl)
	if err != nil || len(g2) != 1 || g2[0] != "n3" {
		t.Fatalf("B acquire: granted=%v err=%v (want [n3])", g2, err)
	}
	if h, ok := d2["n2"]; !ok || h.ClientID != "ca" {
		t.Fatalf("B should be denied n2 with holder A, got %+v", d2)
	}
	// Snapshot: n1->A, n2->A, n3->B.
	snap, err := s.Snapshot(ctx, design)
	if err != nil || snap["n1"].ClientID != "ca" || snap["n2"].ClientID != "ca" || snap["n3"].ClientID != "cb" {
		t.Fatalf("snapshot mismatch: %+v err=%v", snap, err)
	}
	// Re-lock by self is idempotent (granted, not denied).
	g3, d3, _ := s.Acquire(ctx, design, []string{"n1"}, ca, ttl)
	if len(g3) != 1 || len(d3) != 0 {
		t.Fatalf("A re-lock own n1: granted=%v denied=%v (want granted)", g3, d3)
	}
	// Release does not free another's lock: B cannot release A's n1.
	_ = s.Release(ctx, design, "cb", []string{"n1"})
	if h, ok := s.holderViaSnapshot(ctx, design, "n1"); !ok || h.ClientID != "ca" {
		t.Fatal("B must not be able to release A's lock (compare-and-delete)")
	}
	// A releases all; only B's n3 remains.
	if err := s.ReleaseAll(ctx, design, "ca"); err != nil {
		t.Fatalf("release-all A: %v", err)
	}
	snap2, _ := s.Snapshot(ctx, design)
	if len(snap2) != 1 || snap2["n3"].ClientID != "cb" {
		t.Fatalf("after A release-all want only n3->B, got %+v", snap2)
	}
}

// TestRedisLockStore_Expiry covers the crash-safety path: a holder's key auto-
// expires (TTL), Snapshot self-heals the index, and another client can then grab
// it. Skipped unless REDIS_URL is set.
func TestRedisLockStore_Expiry(t *testing.T) {
	url := os.Getenv("REDIS_URL")
	if url == "" {
		t.Skip("REDIS_URL not set; skipping redis expiry test")
	}
	ctx := context.Background()
	s, err := NewRedisLockStore(ctx, url)
	if err != nil {
		t.Fatalf("lock store: %v", err)
	}
	defer s.Close()
	design := "lkexp-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	ca := LockHolder{ClientID: "ca", UserID: "ua", Name: "A"}
	cb := LockHolder{ClientID: "cb", UserID: "ub", Name: "B"}
	defer func() { _ = s.ReleaseAll(ctx, design, "ca"); _ = s.ReleaseAll(ctx, design, "cb") }()

	if g, _, err := s.Acquire(ctx, design, []string{"n1"}, ca, 60*time.Millisecond); err != nil || len(g) != 1 {
		t.Fatalf("A acquire short-TTL: granted=%v err=%v", g, err)
	}
	time.Sleep(180 * time.Millisecond) // let the key TTL-expire (as if A's instance crashed)

	// Snapshot self-heals the stale index entry; the node reads as free.
	snap, err := s.Snapshot(ctx, design)
	if err != nil || len(snap) != 0 {
		t.Fatalf("expired lock should self-heal to empty snapshot, got %+v err=%v", snap, err)
	}
	// B can now acquire the expired node.
	if g, d, err := s.Acquire(ctx, design, []string{"n1"}, cb, 30*time.Second); err != nil || len(g) != 1 || len(d) != 0 {
		t.Fatalf("B should acquire the expired node: granted=%v denied=%v err=%v", g, d, err)
	}
}

// holderViaSnapshot is a test helper to read one node's holder from the live store.
func (s *RedisLockStore) holderViaSnapshot(ctx context.Context, designID, nodeID string) (LockHolder, bool) {
	snap, err := s.Snapshot(ctx, designID)
	if err != nil {
		return LockHolder{}, false
	}
	h, ok := snap[nodeID]
	return h, ok
}

// TestCrossInstanceLockReleasedOnLeave: a NORMAL disconnect (Leave, the dominant
// path) must free the holder's locks in the shared authority and propagate to a
// peer instance - not leave a ghost holder lingering until TTL.
func TestCrossInstanceLockReleasedOnLeave(t *testing.T) {
	bus := &memBus{}
	store := newFakeLockStore()
	ctx := context.Background()
	hubA := NewHub(nil).WithCoordinator(bus.newCoord()).WithLockStore(store)
	hubA.StartCoordinator(ctx)
	hubB := NewHub(nil).WithCoordinator(bus.newCoord()).WithLockStore(store)
	hubB.StartCoordinator(ctx)

	a := hubA.Join(PeerIdentity{ClientID: "a", UserID: "ua", Name: "A", Role: RoleEditor}, "d1", 1000)
	b := hubB.Join(PeerIdentity{ClientID: "b", UserID: "ub", Name: "B", Role: RoleEditor}, "d1", 1000)
	awaitFrame(t, a.send, "join")

	hubB.HandleLock(b, []string{"node-q"})
	awaitLocks(t, a.send, func(lm map[string]any) bool { _, ok := lm["node-q"]; return ok })

	// B disconnects normally. Its lock must clear in the authority and reach A.
	hubB.Leave(b)
	deadline := time.Now().Add(time.Second)
	for {
		if _, ok := store.holderOf("d1", "node-q"); !ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Leave must release the holder's lock from the cross-instance authority")
		}
		time.Sleep(10 * time.Millisecond)
	}
	awaitLocks(t, a.send, func(lm map[string]any) bool { _, still := lm["node-q"]; return !still })
}

// TestLocalCoordinatorDefault: with no coordinator installed the hub is a plain
// single-instance relay (the default localCoordinator is a no-op). A local peer
// still receives a join, proving the default path is intact.
func TestLocalCoordinatorDefault(t *testing.T) {
	hub := NewHub(nil)
	hub.StartCoordinator(context.Background()) // local: no-op, no goroutines
	a := hub.Join(PeerIdentity{ClientID: "a", UserID: "ua", Role: RoleEditor}, "d1", 1000)
	_ = hub.Join(PeerIdentity{ClientID: "b", UserID: "ub", Role: RoleEditor}, "d1", 1000)
	if !drains(a.send, "join") {
		t.Fatal("local peer should see a join with the default coordinator")
	}
}

func TestRedisCoordinatorBadURL(t *testing.T) {
	if _, err := NewRedisCoordinator(context.Background(), "not-a-redis-url"); err == nil {
		t.Fatal("expected an error for an invalid redis URL")
	}
}

func TestRedisCoordinatorUnreachable(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	// A valid URL pointing at a closed port: the ping must fail (fail loud).
	if _, err := NewRedisCoordinator(ctx, "redis://127.0.0.1:6390"); err == nil {
		t.Fatal("expected an error pinging an unreachable redis")
	}
}

// TestRedisFanout_Integration exercises the real RedisCoordinator against a live
// server. Skipped unless REDIS_URL is set (so CI without Redis stays green).
func TestRedisFanout_Integration(t *testing.T) {
	url := os.Getenv("REDIS_URL")
	if url == "" {
		t.Skip("REDIS_URL not set; skipping redis integration test")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	coordA, err := NewRedisCoordinator(ctx, url)
	if err != nil {
		t.Fatalf("coordA: %v", err)
	}
	defer coordA.Close()
	coordB, err := NewRedisCoordinator(ctx, url)
	if err != nil {
		t.Fatalf("coordB: %v", err)
	}
	defer coordB.Close()

	hubA := NewHub(nil).WithCoordinator(coordA)
	hubA.StartCoordinator(ctx)
	hubB := NewHub(nil).WithCoordinator(coordB)
	hubB.StartCoordinator(ctx)
	time.Sleep(200 * time.Millisecond) // let subscriptions establish

	a := hubA.Join(PeerIdentity{ClientID: "a", UserID: "ua", Role: RoleEditor}, "dz", 1000)
	b := hubB.Join(PeerIdentity{ClientID: "b", UserID: "ub", Role: RoleEditor}, "dz", 1000)
	_ = b

	update := base64.StdEncoding.EncodeToString([]byte{2, 4, 2})
	hubB.HandleSync(ctx, b, update)
	sync := awaitFrame(t, a.send, "sync")
	if sync["m"] != update {
		t.Fatalf("A should receive B's sync over real redis: %v", sync["m"])
	}
}
