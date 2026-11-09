package realtime

import (
	"context"
	"errors"
	"github.com/coder/websocket"
	"net/http"
	"net/http/httptest"
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

func (c *countingCoord) Publish(string, string, []byte)                      { c.published.Add(1) }
func (c *countingCoord) PublishTo(string, string, string, []byte)            { c.published.Add(1) }
func (c *countingCoord) InstanceID() string                                  { return "spy" }
func (c *countingCoord) Start(context.Context, func(string, string, []byte)) {}
func (c *countingCoord) Close() error                                        { return nil }

// A handshake authenticated before deactivation must be rechecked after joining.
// A new session on a reactivated account must work without a 30-second cooldown.
func TestSessionRecheckedAfterJoin(t *testing.T) {
	h := NewHub(nil)
	var active atomic.Bool
	active.Store(false)
	checked := make(chan bool, 2)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer ws.CloseNow()
		h.Serve(r.Context(), ws, PeerIdentity{ClientID: r.URL.Query().Get("cid"), UserID: "u", Role: RoleEditor}, "design-1", func() error {
			h.mu.Lock()
			registered := len(h.rooms["design-1"].conns) > 0
			h.mu.Unlock()
			checked <- registered
			if !active.Load() {
				return errors.New("session revoked")
			}
			return nil
		})
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	h.DisconnectUser("u")
	stale := dial(t, ctx, srv.URL, "stale", "u", "editor")
	defer stale.CloseNow()
	if !<-checked {
		t.Fatal("validation happened before registration")
	}
	if _, _, err := stale.Read(ctx); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatal("stale session admitted", err)
	}
	active.Store(true)
	fresh := dial(t, ctx, srv.URL, "fresh", "u", "editor")
	defer fresh.CloseNow()
	if !<-checked {
		t.Fatal("validation happened before registration")
	}
	readUntil(t, ctx, fresh, "welcome")
}
