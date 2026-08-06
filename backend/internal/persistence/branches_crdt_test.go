package persistence

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/storage"
)

// TestCrdtBranches_DB: in-CRDT branch lineages (doc 16 FR-10). Covers fork
// validation, lineage-resolved listing (parent prefix + own rows, one seq
// stream), isolation in both directions (branch rows never in main, post-fork
// main rows never in the branch), nesting, and the checkpoint compaction
// fork-guard that must never delete a prefix a branch still folds from.
// DATABASE_URL-gated.
func TestCrdtBranches_DB(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping DB integration test")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, stripSchema(dsn))
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
	owner, ws, _, err := acct.Signup(ctx, "crdtbr-owner+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	svc := NewService(tx).WithStorage(store)
	rec, err := svc.Create(ctx, ws.ID, "Branched", nil, &owner.ID)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	seqs := func(page UpdateLogPage) []int64 {
		out := make([]int64, 0, len(page.Items))
		for _, it := range page.Items {
			out = append(out, it.Seq)
		}
		return out
	}
	wantSeqs := func(got []int64, want ...int64) {
		t.Helper()
		if len(got) != len(want) {
			t.Fatalf("seqs = %v, want %v", got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("seqs = %v, want %v", got, want)
			}
		}
	}

	// Main rows seq 1..3.
	for i := 0; i < 3; i++ {
		if err := svc.AppendUpdate(ctx, rec.ID, "", []byte{2, byte(i), 1}, owner.ID); err != nil {
			t.Fatalf("main AppendUpdate %d: %v", i, err)
		}
	}

	// Fork validation: empty name, fork past the lineage head.
	if _, err := svc.CreateCrdtBranch(ctx, rec.ID, ws.ID, "  ", 2, nil, &owner.ID); !errors.Is(err, ErrInvalidBranch) {
		t.Fatalf("empty name: err = %v, want ErrInvalidBranch", err)
	}
	if _, err := svc.CreateCrdtBranch(ctx, rec.ID, ws.ID, "too-far", 99, nil, &owner.ID); !errors.Is(err, ErrInvalidBranch) {
		t.Fatalf("fork past head: err = %v, want ErrInvalidBranch", err)
	}

	// Branch "b" forks main at seq 2 (before main's row 3).
	b, err := svc.CreateCrdtBranch(ctx, rec.ID, ws.ID, "b", 2, nil, &owner.ID)
	if err != nil {
		t.Fatalf("CreateCrdtBranch b: %v", err)
	}
	// Branch rows land at design-global seqs 4 and 5.
	for i := 0; i < 2; i++ {
		if err := svc.AppendUpdate(ctx, rec.ID, b.ID, []byte{2, 10 + byte(i), 1}, owner.ID); err != nil {
			t.Fatalf("branch AppendUpdate %d: %v", i, err)
		}
	}
	// Main keeps moving: seq 6.
	if err := svc.AppendUpdate(ctx, rec.ID, "", []byte{2, 99, 1}, owner.ID); err != nil {
		t.Fatalf("main tail AppendUpdate: %v", err)
	}

	// Lineages are isolated in both directions.
	mainPage, err := svc.ListUpdates(ctx, rec.ID, ws.ID, 0, 0)
	if err != nil {
		t.Fatalf("ListUpdates main: %v", err)
	}
	wantSeqs(seqs(mainPage), 1, 2, 3, 6)
	bPage, err := svc.ListBranchUpdates(ctx, rec.ID, ws.ID, b.ID, 0, 0)
	if err != nil {
		t.Fatalf("ListBranchUpdates b: %v", err)
	}
	wantSeqs(seqs(bPage), 1, 2, 4, 5) // prefix <= fork, own rows; never main's 3 or 6

	// Nested branch "c" forks b at seq 4 (b's lineage): main<=2, b<=4, own rows.
	c, err := svc.CreateCrdtBranch(ctx, rec.ID, ws.ID, "c", 4, &b.ID, &owner.ID)
	if err != nil {
		t.Fatalf("CreateCrdtBranch c: %v", err)
	}
	if err := svc.AppendUpdate(ctx, rec.ID, c.ID, []byte{2, 42, 1}, owner.ID); err != nil {
		t.Fatalf("nested AppendUpdate: %v", err)
	}
	cPage, err := svc.ListBranchUpdates(ctx, rec.ID, ws.ID, c.ID, 0, 0)
	if err != nil {
		t.Fatalf("ListBranchUpdates c: %v", err)
	}
	wantSeqs(seqs(cPage), 1, 2, 4, 7)

	// MAIN checkpoint (seq 8): compaction must respect branch b's fork at 2 -
	// main rows 1..2 survive (b's base), 3 and 6 compact away.
	if err := svc.AppendCheckpoint(ctx, rec.ID, "", []byte{2, 88, 8}, owner.ID); err != nil {
		t.Fatalf("main AppendCheckpoint: %v", err)
	}
	mainPage, err = svc.ListUpdates(ctx, rec.ID, ws.ID, 0, 0)
	if err != nil {
		t.Fatalf("ListUpdates after checkpoint: %v", err)
	}
	wantSeqs(seqs(mainPage), 1, 2, 8)
	if !mainPage.Items[2].IsCheckpoint {
		t.Fatal("seq 8 must be the checkpoint row")
	}
	// Branch b's lineage is intact after main's compaction.
	bPage, err = svc.ListBranchUpdates(ctx, rec.ID, ws.ID, b.ID, 0, 0)
	if err != nil {
		t.Fatalf("ListBranchUpdates b after main checkpoint: %v", err)
	}
	wantSeqs(seqs(bPage), 1, 2, 4, 5)

	// BRANCH checkpoint on b (seq 9): nested c forked at 4, so b's row 4
	// survives, row 5 compacts away.
	if err := svc.AppendCheckpoint(ctx, rec.ID, b.ID, []byte{2, 77, 7}, owner.ID); err != nil {
		t.Fatalf("branch AppendCheckpoint: %v", err)
	}
	bPage, err = svc.ListBranchUpdates(ctx, rec.ID, ws.ID, b.ID, 0, 0)
	if err != nil {
		t.Fatalf("ListBranchUpdates b after own checkpoint: %v", err)
	}
	wantSeqs(seqs(bPage), 1, 2, 4, 9)
	// Nested c still folds its full lineage.
	cPage, err = svc.ListBranchUpdates(ctx, rec.ID, ws.ID, c.ID, 0, 0)
	if err != nil {
		t.Fatalf("ListBranchUpdates c after b checkpoint: %v", err)
	}
	wantSeqs(seqs(cPage), 1, 2, 4, 7)

	// Once a lineage is compacted, forking below its newest checkpoint is
	// REFUSED: those rows are gone (or, after repeated compaction, survive only
	// as disconnected islands), and folding them would silently produce a
	// branch whose base is not the state the user picked. Main now retains 1, 2
	// and the checkpoint at 8, so a client holding a stale history page cannot
	// fork at 3; forking at the checkpoint or later still works.
	for _, seq := range []int64{1, 2, 3, 7} {
		if _, err := svc.CreateCrdtBranch(ctx, rec.ID, ws.ID, "stale-fork", seq, nil, &owner.ID); !errors.Is(err, ErrInvalidBranch) {
			t.Fatalf("fork at seq %d below the checkpoint: err = %v, want ErrInvalidBranch", seq, err)
		}
	}
	if _, err := svc.CreateCrdtBranch(ctx, rec.ID, ws.ID, "live-fork", 8, nil, &owner.ID); err != nil {
		t.Fatalf("fork at the checkpoint must still work: %v", err)
	}
	// A SECOND compaction moves the floor up: what was legal a moment ago is
	// not, because its rows are now inside a hole. This is the multi-checkpoint
	// case a single retained-prefix window gets wrong.
	if err := svc.AppendCheckpoint(ctx, rec.ID, "", []byte{2, 66, 6}, owner.ID); err != nil {
		t.Fatalf("second main AppendCheckpoint: %v", err)
	}
	var newCp int64
	if err := tx.QueryRow(ctx, `SELECT MAX(seq) FROM "design_update_logs" WHERE "design_id" = $1 AND "branch_id" IS NULL AND "is_checkpoint"`, rec.ID).Scan(&newCp); err != nil {
		t.Fatalf("read newest checkpoint: %v", err)
	}
	if _, err := svc.CreateCrdtBranch(ctx, rec.ID, ws.ID, "hole-fork", 8, nil, &owner.ID); !errors.Is(err, ErrInvalidBranch) {
		t.Fatalf("fork at the now-superseded checkpoint: err = %v, want ErrInvalidBranch", err)
	}
	if _, err := svc.CreateCrdtBranch(ctx, rec.ID, ws.ID, "fresh-fork", newCp, nil, &owner.ID); err != nil {
		t.Fatalf("fork at the newest checkpoint (%d): %v", newCp, err)
	}

	// Listing + lookups.
	branches, err := svc.ListCrdtBranches(ctx, rec.ID, ws.ID)
	if err != nil || len(branches) != 4 { // b, nested c, live-fork, fresh-fork
		t.Fatalf("ListCrdtBranches = %d (%v), want 4", len(branches), err)
	}
	if !svc.BranchBelongsToDesign(ctx, rec.ID, b.ID) {
		t.Fatal("BranchBelongsToDesign(b) = false")
	}
	if svc.BranchBelongsToDesign(ctx, rec.ID, "nope") {
		t.Fatal("BranchBelongsToDesign(nope) = true")
	}

	// The last-leave fold ignores branch rows entirely: with ONLY branch edits
	// past the current snapshot, main's fold has nothing newer to materialize.
	if created, err := svc.SnapshotFoldedUpdateLog(ctx, rec.ID); err != nil {
		t.Fatalf("SnapshotFoldedUpdateLog with branches: %v", err)
	} else if created {
		// Main rows (1,2,8) exist and postdate the backdated... creation snapshot
		// is at frozen now() = same timestamp as rows -> tie skips. Either way it
		// must NOT be an error; created=false is the expected frozen-clock result.
		t.Fatal("fold created a snapshot despite tie-skipping guard")
	}
}
