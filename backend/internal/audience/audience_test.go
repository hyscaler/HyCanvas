package audience

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/persistence"
	"hycanvas/backend/internal/storage"
)

type recordingNotifier struct{ events []map[string]any }

func (n *recordingNotifier) BroadcastEvent(_ string, payload map[string]any) {
	n.events = append(n.events, payload)
}

// TestAudienceLifecycle_DB: the full live-audience loop (doc 28) - ask,
// upvote (idempotent per voter key), moderate, poll create/vote/re-vote/close,
// personalized state reads, design scoping, and clear. DATABASE_URL-gated.
func TestAudienceLifecycle_DB(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping DB integration test")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, strings.SplitN(dsn, "?", 2)[0])
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer conn.Close(ctx)
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	store, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatalf("storage: %v", err)
	}
	acct := accounts.NewService(tx, "test-jwt-secret")
	owner, ws, _, err := acct.Signup(ctx, "aud-owner+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	psvc := persistence.NewService(tx).WithStorage(store)
	recA, err := psvc.Create(ctx, ws.ID, "Deck A", nil, &owner.ID)
	if err != nil {
		t.Fatalf("create A: %v", err)
	}
	recB, err := psvc.Create(ctx, ws.ID, "Deck B", nil, &owner.ID)
	if err != nil {
		t.Fatalf("create B: %v", err)
	}

	notify := &recordingNotifier{}
	svc := NewService(tx, notify)

	// Questions: ask + idempotent upvote per voter key.
	q1, err := svc.AskQuestion(ctx, recA.ID, "Ada", "How does pricing work?")
	if err != nil {
		t.Fatalf("ask: %v", err)
	}
	if _, err := svc.AskQuestion(ctx, recA.ID, "", strings.Repeat("x", 600)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("oversized question: err = %v, want ErrInvalid", err)
	}
	for _, key := range []string{"v1", "v1", "v2"} { // v1 twice: one vote
		if err := svc.VoteQuestion(ctx, recA.ID, q1.ID, key); err != nil {
			t.Fatalf("vote(%s): %v", key, err)
		}
	}
	// Cross-design scoping: voting via design B on A's question is a no-op.
	if err := svc.VoteQuestion(ctx, recB.ID, q1.ID, "v3"); err != nil {
		t.Fatalf("cross-design vote: %v", err)
	}
	st, err := svc.GetState(ctx, recA.ID, "v1", false)
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	if len(st.Questions) != 1 || st.Questions[0].Votes != 2 || !st.Questions[0].Voted {
		t.Fatalf("question state = %+v, want 2 votes and voted=true for v1", st.Questions)
	}

	// Moderation: dismissed questions hide from the audience, stay for presenter.
	dismissed := true
	if err := svc.ModerateQuestion(ctx, recA.ID, q1.ID, nil, &dismissed); err != nil {
		t.Fatalf("moderate: %v", err)
	}
	st, _ = svc.GetState(ctx, recA.ID, "v1", false)
	if len(st.Questions) != 0 {
		t.Fatal("dismissed question leaked to the audience view")
	}
	pst, _ := svc.GetState(ctx, recA.ID, "", true)
	if len(pst.Questions) != 1 || !pst.Questions[0].Dismissed {
		t.Fatalf("presenter view should keep the dismissed question: %+v", pst.Questions)
	}

	// Polls: create, vote, change vote, close, and closed-vote refusal.
	poll, err := svc.CreatePoll(ctx, recA.ID, "Ship it?", []string{"Yes", "No", " "})
	if err != nil {
		t.Fatalf("poll: %v", err)
	}
	if len(poll.Options) != 2 {
		t.Fatalf("blank options must drop: %v", poll.Options)
	}
	if _, err := svc.CreatePoll(ctx, recA.ID, "Bad", []string{"only-one"}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("1-option poll: err = %v, want ErrInvalid", err)
	}
	if err := svc.VotePoll(ctx, recA.ID, poll.ID, "v1", 0); err != nil {
		t.Fatalf("poll vote: %v", err)
	}
	if err := svc.VotePoll(ctx, recA.ID, poll.ID, "v1", 1); err != nil {
		t.Fatalf("poll re-vote: %v", err)
	}
	if err := svc.VotePoll(ctx, recA.ID, poll.ID, "v2", 1); err != nil {
		t.Fatalf("poll vote v2: %v", err)
	}
	if err := svc.VotePoll(ctx, recA.ID, poll.ID, "v1", 5); !errors.Is(err, ErrInvalid) {
		t.Fatalf("out-of-range option: err = %v, want ErrInvalid", err)
	}
	st, _ = svc.GetState(ctx, recA.ID, "v1", false)
	if len(st.Polls) != 1 || st.Polls[0].Counts[0] != 0 || st.Polls[0].Counts[1] != 2 || st.Polls[0].MyVote != 1 {
		t.Fatalf("poll state = %+v, want counts [0 2] and myVote 1", st.Polls)
	}
	if err := svc.SetPollOpen(ctx, recA.ID, poll.ID, false); err != nil {
		t.Fatalf("close poll: %v", err)
	}
	if err := svc.VotePoll(ctx, recA.ID, poll.ID, "v9", 0); !errors.Is(err, ErrInvalid) {
		t.Fatalf("vote on closed poll: err = %v, want ErrInvalid", err)
	}

	// Anonymous-abuse caps: an oversized voter key is refused (it would be
	// stored per vote), and the slide index is bounded before it reaches an INT
	// column (which would surface as a 500 rather than a clean rejection).
	if err := svc.VoteQuestion(ctx, recA.ID, q1.ID, strings.Repeat("k", 500)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("oversized voter key: err = %v, want ErrInvalid", err)
	}
	if err := svc.VotePoll(ctx, recA.ID, poll.ID, strings.Repeat("k", 500), 0); !errors.Is(err, ErrInvalid) {
		t.Fatalf("oversized poll voter key: err = %v, want ErrInvalid", err)
	}
	if err := svc.SetLivePosition(ctx, recA.ID, 1<<40); !errors.Is(err, ErrInvalid) {
		t.Fatalf("absurd slide index: err = %v, want ErrInvalid", err)
	}

	// Reactions: allowlisted only, notify-only (never stored).
	if err := svc.React(recA.ID, "👏"); err != nil {
		t.Fatalf("react: %v", err)
	}
	if err := svc.React(recA.ID, "<script>"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("bad reaction: err = %v, want ErrInvalid", err)
	}

	// Clear wipes the board (questions AND polls, one statement).
	if err := svc.Clear(ctx, recA.ID); err != nil {
		t.Fatalf("clear: %v", err)
	}
	pst, _ = svc.GetState(ctx, recA.ID, "", true)
	if len(pst.Questions) != 0 || len(pst.Polls) != 0 {
		t.Fatalf("clear left rows: %+v", pst)
	}

	// Slide-follow: set, read back through state, clear with -1.
	if err := svc.SetLivePosition(ctx, recA.ID, 4); err != nil {
		t.Fatalf("SetLivePosition: %v", err)
	}
	st, _ = svc.GetState(ctx, recA.ID, "v1", false)
	if st.Live == nil || st.Live.Slide != 4 {
		t.Fatalf("live state = %+v, want slide 4", st.Live)
	}
	if err := svc.SetLivePosition(ctx, recA.ID, 2); err != nil {
		t.Fatalf("SetLivePosition update: %v", err)
	}
	st, _ = svc.GetState(ctx, recA.ID, "v1", false)
	if st.Live == nil || st.Live.Slide != 2 {
		t.Fatalf("live state after update = %+v, want slide 2", st.Live)
	}
	if err := svc.SetLivePosition(ctx, recA.ID, -1); err != nil {
		t.Fatalf("SetLivePosition clear: %v", err)
	}
	st, _ = svc.GetState(ctx, recA.ID, "v1", false)
	if st.Live != nil {
		t.Fatalf("live state should clear on -1: %+v", st.Live)
	}

	// Every mutation notified the presenter.
	if len(notify.events) < 6 {
		t.Fatalf("expected notifier events, got %d", len(notify.events))
	}
}
