package realtime

import (
	"sync/atomic"
	"testing"
	"time"
)

// waitFor polls until cond is true or the deadline passes.
func waitFor(t *testing.T, d time.Duration, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return cond()
}

// The last-leave hook fires once after the LAST local connection leaves, and
// only after the grace delay.
func TestLastLeaveHookFiresWhenRoomEmpties(t *testing.T) {
	var fired atomic.Int32
	var gotDesign atomic.Value
	hub := NewHub(nil).WithLastLeaveHook(func(designID string) {
		fired.Add(1)
		gotDesign.Store(designID)
	}, 20*time.Millisecond)

	a := hub.Join(PeerIdentity{ClientID: "a", UserID: "ua", Role: RoleEditor}, "d1", 1000)
	b := hub.Join(PeerIdentity{ClientID: "b", UserID: "ub", Role: RoleEditor}, "d1", 1000)

	hub.Leave(a)
	time.Sleep(40 * time.Millisecond)
	if fired.Load() != 0 {
		t.Fatal("hook must not fire while a connection remains")
	}
	hub.Leave(b)
	if !waitFor(t, time.Second, func() bool { return fired.Load() == 1 }) {
		t.Fatal("hook did not fire after the last leave")
	}
	if got := gotDesign.Load(); got != "d1" {
		t.Fatalf("hook design = %v, want d1", got)
	}
	// No spurious second fire.
	time.Sleep(50 * time.Millisecond)
	if fired.Load() != 1 {
		t.Fatalf("hook fired %d times, want 1", fired.Load())
	}
}

// A rejoin within the grace delay disarms the pending fold.
func TestLastLeaveHookCanceledByRejoin(t *testing.T) {
	var fired atomic.Int32
	hub := NewHub(nil).WithLastLeaveHook(func(string) { fired.Add(1) }, 50*time.Millisecond)

	a := hub.Join(PeerIdentity{ClientID: "a", UserID: "ua", Role: RoleEditor}, "d1", 1000)
	hub.Leave(a)
	// Rejoin before the delay elapses: the fold must not fire.
	_ = hub.Join(PeerIdentity{ClientID: "a2", UserID: "ua", Role: RoleEditor}, "d1", 1000)
	time.Sleep(120 * time.Millisecond)
	if fired.Load() != 0 {
		t.Fatalf("hook fired %d times despite rejoin, want 0", fired.Load())
	}
}

// Without a hook installed, an emptying room must not schedule anything (the
// default self-host path).
func TestLastLeaveNoHookNoop(t *testing.T) {
	hub := NewHub(nil)
	a := hub.Join(PeerIdentity{ClientID: "a", UserID: "ua", Role: RoleEditor}, "d1", 1000)
	hub.Leave(a)
	hub.mu.Lock()
	pending := len(hub.leaveTimers)
	hub.mu.Unlock()
	if pending != 0 {
		t.Fatalf("expected no pending leave timers, got %d", pending)
	}
}
