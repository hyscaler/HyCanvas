package whiteboard

import (
	"context"
	"errors"
	"testing"

	"hycanvas/backend/internal/authz"
	"hycanvas/backend/internal/sharing"
)

// fakeRepo is an in-memory VoteRepo so the budget/toggle/reveal logic is testable
// without Postgres.
type fakeRepo struct {
	sessions map[string]SessionRow
	votes    []CastRow // parallel to voteSess for the single test session
	voteSess []string
	seq      int
}

func newFakeRepo() *fakeRepo { return &fakeRepo{sessions: map[string]SessionRow{}} }

func (f *fakeRepo) CreateSession(_ context.Context, s SessionRow) (SessionRow, error) {
	f.seq++
	s.ID = "sess" + string(rune('0'+f.seq))
	f.sessions[s.ID] = s
	return s, nil
}
func (f *fakeRepo) GetSession(_ context.Context, designID, sessionID string) (SessionRow, error) {
	s, ok := f.sessions[sessionID]
	if !ok || s.DesignID != designID {
		return SessionRow{}, ErrNotFound
	}
	return s, nil
}
func (f *fakeRepo) SetSessionState(_ context.Context, designID, sessionID string, open, revealed bool) (SessionRow, error) {
	s, ok := f.sessions[sessionID]
	if !ok || s.DesignID != designID {
		return SessionRow{}, ErrNotFound
	}
	s.Open, s.Revealed = open, revealed
	f.sessions[sessionID] = s
	return s, nil
}
func (f *fakeRepo) HasVote(_ context.Context, sessionID, nodeID, userID string) (bool, error) {
	for i, v := range f.votes {
		if f.voteSess[i] == sessionID && v.NodeID == nodeID && v.UserID == userID {
			return true, nil
		}
	}
	return false, nil
}
func (f *fakeRepo) CountUserVotes(_ context.Context, sessionID, userID string) (int, error) {
	n := 0
	for i, v := range f.votes {
		if f.voteSess[i] == sessionID && v.UserID == userID {
			n++
		}
	}
	return n, nil
}
func (f *fakeRepo) InsertVote(ctx context.Context, sessionID, _ string, nodeID, userID string, budget int) (bool, error) {
	// Model the DB's atomic guard: reject a duplicate (session,node,user) and a
	// cast that would push the per-user count past the budget.
	if has, _ := f.HasVote(ctx, sessionID, nodeID, userID); has {
		return false, nil
	}
	if n, _ := f.CountUserVotes(ctx, sessionID, userID); n >= budget {
		return false, nil
	}
	f.votes = append(f.votes, CastRow{NodeID: nodeID, UserID: userID})
	f.voteSess = append(f.voteSess, sessionID)
	return true, nil
}
func (f *fakeRepo) DeleteVote(_ context.Context, sessionID, nodeID, userID string) error {
	for i, v := range f.votes {
		if f.voteSess[i] == sessionID && v.NodeID == nodeID && v.UserID == userID {
			f.votes = append(f.votes[:i], f.votes[i+1:]...)
			f.voteSess = append(f.voteSess[:i], f.voteSess[i+1:]...)
			return nil
		}
	}
	return nil
}
func (f *fakeRepo) Votes(_ context.Context, sessionID string) ([]CastRow, error) {
	var out []CastRow
	for i, v := range f.votes {
		if f.voteSess[i] == sessionID {
			out = append(out, v)
		}
	}
	return out, nil
}

// fakeAccess grants a fixed capability set per user.
type fakeAccess struct{ caps map[string][]authz.Capability }

func (a fakeAccess) GetAccess(_ context.Context, _ string, userID string) (sharing.DesignAccessView, error) {
	c, ok := a.caps[userID]
	if !ok {
		return sharing.DesignAccessView{}, errors.New("no access")
	}
	return sharing.DesignAccessView{Capabilities: c}, nil
}

func newSvc(repo VoteRepo, caps map[string][]authz.Capability) *Service {
	return NewService(repo, fakeAccess{caps: caps}, nil)
}

func TestVotingBudgetAndToggle(t *testing.T) {
	repo := newFakeRepo()
	svc := newSvc(repo, map[string][]authz.Capability{
		"facil":   {authz.CapView, authz.CapComment, authz.CapEdit},
		"voter":   {authz.CapView, authz.CapComment},
		"watcher": {authz.CapView},
	})
	ctx := context.Background()

	// A viewer cannot open a session (needs edit).
	if _, err := svc.OpenSession(ctx, "d1", "watcher", 2, false); !errors.Is(err, ErrForbidden) {
		t.Fatalf("viewer open should be forbidden, got %v", err)
	}
	// The facilitator opens a 2-vote round.
	sess, err := svc.OpenSession(ctx, "d1", "facil", 2, false)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if sess.BudgetPerUser != 2 || !sess.Open {
		t.Fatalf("unexpected session: %+v", sess)
	}

	// Voter spends both votes.
	if _, err := svc.CastVote(ctx, "d1", sess.ID, "n1", "voter"); err != nil {
		t.Fatalf("cast n1: %v", err)
	}
	tv, err := svc.CastVote(ctx, "d1", sess.ID, "n2", "voter")
	if err != nil {
		t.Fatalf("cast n2: %v", err)
	}
	if tv.RemainingBudget != 0 || tv.Counts["n1"] != 1 || tv.Counts["n2"] != 1 {
		t.Fatalf("after 2 votes: %+v", tv)
	}
	// A third distinct vote is over budget -> 409.
	if _, err := svc.CastVote(ctx, "d1", sess.ID, "n3", "voter"); !errors.Is(err, ErrConflict) {
		t.Fatalf("over-budget vote should conflict, got %v", err)
	}
	// Toggling n1 off frees a vote.
	tv, err = svc.CastVote(ctx, "d1", sess.ID, "n1", "voter")
	if err != nil {
		t.Fatalf("toggle n1: %v", err)
	}
	if tv.RemainingBudget != 1 || tv.Counts["n1"] != 0 {
		t.Fatalf("after toggle off: %+v", tv)
	}
	// Now n3 fits.
	if _, err := svc.CastVote(ctx, "d1", sess.ID, "n3", "voter"); err != nil {
		t.Fatalf("cast n3 after freeing: %v", err)
	}

	// Closing the session blocks further votes (409).
	if _, err := svc.SetSessionState(ctx, "d1", sess.ID, "facil", false, false); err != nil {
		t.Fatalf("close: %v", err)
	}
	if _, err := svc.CastVote(ctx, "d1", sess.ID, "n4", "voter"); !errors.Is(err, ErrConflict) {
		t.Fatalf("vote on closed session should conflict, got %v", err)
	}
}

func TestVotingAnonymityAndReveal(t *testing.T) {
	repo := newFakeRepo()
	svc := newSvc(repo, map[string][]authz.Capability{
		"facil": {authz.CapView, authz.CapComment, authz.CapEdit},
		"a":     {authz.CapView, authz.CapComment},
	})
	ctx := context.Background()

	// Non-anonymous session: voters are hidden until revealed.
	sess, _ := svc.OpenSession(ctx, "d1", "facil", 3, false)
	svc.CastVote(ctx, "d1", sess.ID, "n1", "a")
	tv, _ := svc.Tally(ctx, "d1", sess.ID, "facil")
	if tv.Voters != nil {
		t.Fatalf("voters must stay hidden before reveal: %+v", tv.Voters)
	}
	// Reveal exposes voter identities.
	svc.SetSessionState(ctx, "d1", sess.ID, "facil", true, true) // open + revealed
	tv, _ = svc.Tally(ctx, "d1", sess.ID, "facil")
	if tv.Voters == nil || len(tv.Voters["n1"]) != 1 || tv.Voters["n1"][0] != "a" {
		t.Fatalf("reveal should expose voters: %+v", tv.Voters)
	}

	// Anonymous session: reveal does NOT expose identities (enforced server-side).
	anon, _ := svc.OpenSession(ctx, "d1", "facil", 3, true)
	svc.CastVote(ctx, "d1", anon.ID, "m1", "a")
	svc.SetSessionState(ctx, "d1", anon.ID, "facil", false, true) // closed + revealed
	tv, _ = svc.Tally(ctx, "d1", anon.ID, "facil")
	if tv.Voters != nil {
		t.Fatalf("anonymous session must never expose voters: %+v", tv.Voters)
	}
	if tv.Counts["m1"] != 1 {
		t.Fatalf("anonymous tally counts should still be visible: %+v", tv.Counts)
	}
}
