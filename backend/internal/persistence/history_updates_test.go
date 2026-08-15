package persistence

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/storage"
)

// TestUpdateLogCheckpointCompaction_DB: AppendUpdate journals deltas; an
// AppendCheckpoint inserts a full-state row and atomically drops every older row,
// leaving the checkpoint + any tail (FR-11 log compaction). DATABASE_URL-gated.
func TestUpdateLogCheckpointCompaction_DB(t *testing.T) {
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
	owner, ws, _, err := acct.Signup(ctx, "ulc-owner+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	svc := NewService(tx).WithStorage(store)
	rec, err := svc.Create(ctx, ws.ID, "Log", nil, &owner.ID)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Three incremental frames (type-2 sync update bytes).
	for i := 0; i < 3; i++ {
		if err := svc.AppendUpdate(ctx, rec.ID, "", []byte{2, byte(i), 1}, owner.ID); err != nil {
			t.Fatalf("AppendUpdate %d: %v", i, err)
		}
	}
	if page, err := svc.ListUpdates(ctx, rec.ID, ws.ID, 0, 0); err != nil || len(page.Items) != 3 {
		t.Fatalf("want 3 update rows, got %d (err=%v)", len(page.Items), err)
	}

	// Checkpoint compacts: pre-checkpoint rows deleted, the checkpoint remains.
	if err := svc.AppendCheckpoint(ctx, rec.ID, "", []byte{2, 9, 9}, owner.ID); err != nil {
		t.Fatalf("AppendCheckpoint: %v", err)
	}
	page, err := svc.ListUpdates(ctx, rec.ID, ws.ID, 0, 0)
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("after checkpoint want 1 row, got %d (err=%v)", len(page.Items), err)
	}
	if !page.Items[0].IsCheckpoint {
		t.Fatalf("the surviving row must be the checkpoint: %+v", page.Items[0])
	}
	checkpointSeq := page.Items[0].Seq

	// A subsequent delta is a tail on top of the checkpoint, in order.
	if err := svc.AppendUpdate(ctx, rec.ID, "", []byte{2, 7, 7}, owner.ID); err != nil {
		t.Fatalf("tail AppendUpdate: %v", err)
	}
	page, err = svc.ListUpdates(ctx, rec.ID, ws.ID, 0, 0)
	if err != nil || len(page.Items) != 2 {
		t.Fatalf("after tail want 2 rows, got %d (err=%v)", len(page.Items), err)
	}
	if !page.Items[0].IsCheckpoint || page.Items[0].Seq != checkpointSeq {
		t.Fatalf("checkpoint must remain first: %+v", page.Items[0])
	}
	if page.Items[1].IsCheckpoint || page.Items[1].Seq <= checkpointSeq {
		t.Fatalf("tail delta must follow the checkpoint with a higher seq: %+v", page.Items[1])
	}
}
