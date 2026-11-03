package realtime

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

// cancelSpy gives a joined connection a cancel func the test can observe (Serve
// normally sets it to tear down the connection's pumps).
func cancelSpy(c *conn) *atomic.Bool {
	var called atomic.Bool
	c.cancel = func() { called.Store(true) }
	return &called
}

// A deactivated person's open editor tabs must close on every gateway instance,
// not just the one that handled the deactivation, and nobody else's may.
func TestDisconnectUserAcrossInstances(t *testing.T) {
	bus := &memBus{}
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	hubA := NewHub(nil).WithCoordinator(bus.newCoord())
	hubA.StartCoordinator(ctx)
	hubB := NewHub(nil).WithCoordinator(bus.newCoord())
	hubB.StartCoordinator(ctx)

	// The person has tabs on two designs on instance A and one on instance B;
	// someone else shares a room with them.
	gone1 := cancelSpy(hubA.Join(PeerIdentity{ClientID: "u1", UserID: "u", Role: RoleEditor}, "d1", 1000))
	gone2 := cancelSpy(hubA.Join(PeerIdentity{ClientID: "u2", UserID: "u", Role: RoleEditor}, "d2", 1000))
	gone3 := cancelSpy(hubB.Join(PeerIdentity{ClientID: "u3", UserID: "u", Role: RoleEditor}, "d1", 1000))
	other := hubA.Join(PeerIdentity{ClientID: "o1", UserID: "other", Role: RoleEditor}, "d1", 1000)
	stays := cancelSpy(other)

	hubA.DisconnectUser("u")

	if !gone1.Load() || !gone2.Load() {
		t.Fatal("the person's connections on the deactivating instance were not closed")
	}
	deadline := time.Now().Add(2 * time.Second)
	for !gone3.Load() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if !gone3.Load() {
		t.Fatal("the person's connection on a peer instance was not closed")
	}
	if stays.Load() {
		t.Fatal("another person's connection was closed")
	}
}

// The peer side handles the control signal locally and must not re-publish it,
// or two instances would bounce it between them forever.
func TestDisconnectUserSignalIsNotRepublished(t *testing.T) {
	spy := &countingCoord{}
	h := NewHub(nil).WithCoordinator(spy)
	gone := cancelSpy(h.Join(PeerIdentity{ClientID: "u1", UserID: "u", Role: RoleEditor}, "d1", 1000))
	before := spy.published.Load()

	h.deliverRemote("", ctrlDisconnectUser, []byte(`"u"`))

	if !gone.Load() {
		t.Fatal("a peer's disconnect signal did not close the local connection")
	}
	if spy.published.Load() != before {
		t.Fatal("a peer's disconnect signal was re-published")
	}
}

type countingCoord struct{ published atomic.Int64 }

func (c *countingCoord) Publish(string, string, []byte)         { c.published.Add(1) }
func (c *countingCoord) PublishTo(string, string, string, []byte) { c.published.Add(1) }
func (c *countingCoord) InstanceID() string                      { return "spy" }
func (c *countingCoord) Start(context.Context, func(string, string, []byte)) {}
func (c *countingCoord) Close() error                            { return nil }
