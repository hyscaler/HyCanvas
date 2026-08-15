package realtime

import (
	"context"
	"encoding/base64"
	"sync/atomic"
	"testing"
)

func TestRateBucket(t *testing.T) {
	var b rateBucket
	// First call seeds the bucket to `burst`; consume the whole burst.
	for i := 0; i < 5; i++ {
		if !b.allow(1000, 10, 5) {
			t.Fatalf("token %d within burst should be allowed", i)
		}
	}
	// Bucket empty at the same instant: deny.
	if b.allow(1000, 10, 5) {
		t.Fatal("an empty bucket should deny")
	}
	// 500ms later at 10/s refills 5 tokens: allow again.
	if !b.allow(1500, 10, 5) {
		t.Fatal("bucket should refill over elapsed time")
	}
	// Refill is capped at burst: a long gap does not grant more than `burst`.
	for i := 0; i < 5; i++ {
		if !b.allow(100000, 10, 5) {
			t.Fatalf("refill token %d up to burst should be allowed", i)
		}
	}
	if b.allow(100000, 10, 5) {
		t.Fatal("refill must be capped at burst")
	}
}

// TestHandleSyncWireValidation: a malformed / oversized / unknown-type sync frame
// is dropped (never relayed to the peer), while a well-formed one relays.
func TestHandleSyncWireValidation(t *testing.T) {
	ctx := context.Background()
	newPair := func() (*Hub, *conn, *conn) {
		h := NewHub(nil)
		a := h.Join(PeerIdentity{ClientID: "a", UserID: "ua", Role: RoleEditor}, "d1", 1000)
		b := h.Join(PeerIdentity{ClientID: "b", UserID: "ub", Role: RoleEditor}, "d1", 1000)
		return h, a, b
	}

	// Not valid base64.
	h, a, _ := newPair()
	h.HandleSync(ctx, a, "!!!not base64!!!")
	if drains(_peerOf(h, "b").send, "sync") {
		t.Fatal("a non-base64 frame must not relay")
	}

	// Empty payload.
	h, a, _ = newPair()
	h.HandleSync(ctx, a, base64.StdEncoding.EncodeToString([]byte{}))
	if drains(_peerOf(h, "b").send, "sync") {
		t.Fatal("an empty payload must not relay")
	}

	// Unknown y-protocols message type (first byte 9).
	h, a, _ = newPair()
	h.HandleSync(ctx, a, base64.StdEncoding.EncodeToString([]byte{9, 1, 2}))
	if drains(_peerOf(h, "b").send, "sync") {
		t.Fatal("an unknown message-type frame must not relay")
	}

	// Oversized payload (just over the cap).
	h, a, _ = newPair()
	big := make([]byte, maxUpdateBytes+1)
	big[0] = 2
	h.HandleSync(ctx, a, base64.StdEncoding.EncodeToString(big))
	if drains(_peerOf(h, "b").send, "sync") {
		t.Fatal("an oversized frame must not relay")
	}

	// Valid update (type 2): relays to the peer.
	h, a, _ = newPair()
	ok := base64.StdEncoding.EncodeToString([]byte{2, 7, 7})
	h.HandleSync(ctx, a, ok)
	if !drains(_peerOf(h, "b").send, "sync") {
		t.Fatal("a valid sync frame should relay to the peer")
	}
}

// _peerOf returns the live conn for a client id in design d1 (test helper).
func _peerOf(h *Hub, clientID string) *conn {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.rooms["d1"].conns[clientID]
}

// countingLog counts AppendUpdate calls (the journaling side effect of every
// type-2 sync frame HandleSync actually processes). Unbounded, unlike the peer
// send buffer, so it is a reliable signal of how many sync frames survived.
type countingLog struct{ n int64 }

func (c *countingLog) AppendUpdate(_ context.Context, _, _ string, _ []byte, _ string) error {
	atomic.AddInt64(&c.n, 1)
	return nil
}

// TestRateLimitExemptsSync: the per-connection flood guard must NOT drop sync
// frames (an unrecoverable once-only CRDT delta). Regression test for the
// verified bug where a fast drag past the burst dropped UPDATE frames before
// relay, diverging peers. Proven via the journal: every processed type-2 frame
// journals, so journal count == frames that survived the dispatch rate gate.
func TestRateLimitExemptsSync(t *testing.T) {
	log := &countingLog{}
	h := NewHub(log)
	a := h.Join(PeerIdentity{ClientID: "a", UserID: "ua", Role: RoleEditor}, "d1", 1000)
	_ = h.Join(PeerIdentity{ClientID: "b", UserID: "ub", Role: RoleEditor}, "d1", 1000)

	// First exhaust the token bucket entirely with recoverable (presence) frames,
	// so the limiter WOULD drop any further rate-limited frame.
	for i := 0; i < int(maxFrameBurst)+50; i++ {
		h.dispatch(context.Background(), a, []byte(`{"t":"presence","state":{"cursor":{"x":1,"y":1}}}`))
	}
	if a.rate.allow(1000, maxFramesPerSec, maxFrameBurst) {
		t.Fatal("precondition: the bucket should be exhausted after the presence flood")
	}

	// Now pump many sync UPDATE frames at the same instant: ALL must be processed
	// (journaled), proving sync is exempt from the rate limit.
	update := base64.StdEncoding.EncodeToString([]byte{2, 1, 1})
	const n = 500 // well past maxFrameBurst (240)
	for i := 0; i < n; i++ {
		h.dispatch(context.Background(), a, []byte(`{"t":"sync","m":"`+update+`"}`))
	}
	if got := atomic.LoadInt64(&log.n); got != int64(n) {
		t.Fatalf("sync must be exempt from the rate limit: journaled %d of %d", got, n)
	}
}
