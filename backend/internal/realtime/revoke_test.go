package realtime

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

// TestRefreshRolesDisconnectsRevokedUser: when a design's access changes and a
// connected user no longer has any access, the refresh tells that connection it
// was revoked and tears it down, while a user who still has access stays.
func TestRefreshRolesDisconnectsRevokedUser(t *testing.T) {
	ctx := context.Background()
	resolver := func(_ context.Context, _, userID string) (string, error) {
		if userID == "gone" {
			return "", ErrAccessRevoked
		}
		return string(RoleViewer), nil
	}
	h := NewHub(nil).WithRoleResolver(resolver)
	gone := h.Join(PeerIdentity{ClientID: "g", UserID: "gone", Role: RoleViewer}, "d1", 1000)
	kept := h.Join(PeerIdentity{ClientID: "k", UserID: "kept", Role: RoleViewer}, "d1", 1000)
	var cancelled atomic.Bool
	gone.cancel = func() { cancelled.Store(true) }
	kept.cancel = func() { t.Error("a user who still has access must not be disconnected") }

	h.RefreshRoles(ctx, "d1", "access-changed")

	if f := awaitFrame(t, gone.send, "revoked"); f["designId"] != "d1" {
		t.Fatalf("revoked frame should name the design: %v", f)
	}
	if !cancelled.Load() {
		t.Fatal("a revoked connection must be torn down")
	}
	if drains(kept.send, "revoked") {
		t.Fatal("a user who still has access must not be told they were revoked")
	}
}

// TestRefreshRolesKeepsConnectionOnTransientError: a resolver failure that is not
// a revocation (for example the database is briefly unreachable) must not
// disconnect anyone.
func TestRefreshRolesKeepsConnectionOnTransientError(t *testing.T) {
	ctx := context.Background()
	resolver := func(context.Context, string, string) (string, error) { return "", errors.New("db unavailable") }
	h := NewHub(nil).WithRoleResolver(resolver)
	c := h.Join(PeerIdentity{ClientID: "c", UserID: "u", Role: RoleEditor}, "d1", 1000)
	c.cancel = func() { t.Error("a transient resolver error must not disconnect") }

	h.RefreshRoles(ctx, "d1", "access-changed")

	if !noFrame(c.send, "revoked", 200*time.Millisecond) {
		t.Fatal("a transient resolver error must not revoke")
	}
}

// TestCrossInstanceRefreshUser: removing a member is handled on instance A, but
// the member is connected to two designs on instance B. RefreshUser on A signals
// B, which re-resolves and disconnects both of the member's connections.
func TestCrossInstanceRefreshUser(t *testing.T) {
	bus := &memBus{}
	ctx := context.Background()
	resolver := func(_ context.Context, _, userID string) (string, error) {
		if userID == "removed" {
			return "", ErrAccessRevoked
		}
		return string(RoleEditor), nil
	}
	hubA := NewHub(nil).WithCoordinator(bus.newCoord()).WithRoleResolver(resolver)
	hubA.StartCoordinator(ctx)
	hubB := NewHub(nil).WithCoordinator(bus.newCoord()).WithRoleResolver(resolver)
	hubB.StartCoordinator(ctx)

	r1 := hubB.Join(PeerIdentity{ClientID: "r1", UserID: "removed", Role: RoleEditor}, "d1", 1000)
	r2 := hubB.Join(PeerIdentity{ClientID: "r2", UserID: "removed", Role: RoleEditor}, "d2", 1000)
	other := hubB.Join(PeerIdentity{ClientID: "o", UserID: "other", Role: RoleEditor}, "d1", 1000)

	hubA.RefreshUser(ctx, "removed", "access-changed")

	awaitFrame(t, r1.send, "revoked")
	awaitFrame(t, r2.send, "revoked")
	if !noFrame(other.send, "revoked", 200*time.Millisecond) {
		t.Fatal("another user's connection must be left alone")
	}
}
