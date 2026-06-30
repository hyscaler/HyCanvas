package persistence

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Integration test against the shared Postgres, in a rolled-back transaction.
// Seeds a workspace + design and verifies the design read paths.
func TestDesignReads_DB(t *testing.T) {
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

	// Seed an owner user + workspace + a design.
	userID := uuid.NewString()
	if _, err := tx.Exec(ctx,
		`INSERT INTO "users" (id, email, name, "updated_at") VALUES ($1,$2,'Owner', now())`,
		userID, "p-test+"+uuid.NewString()+"@example.com"); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	wsID := uuid.NewString()
	if _, err := tx.Exec(ctx,
		`INSERT INTO "workspaces" (id, kind, name, slug, "owner_id", "updated_at") VALUES ($1,'PERSONAL','W',$2,$3, now())`,
		wsID, "w-"+uuid.NewString()[:8], userID); err != nil {
		t.Fatalf("seed workspace: %v", err)
	}
	designID := uuid.NewString()
	if _, err := tx.Exec(ctx,
		`INSERT INTO "designs" (id, "workspace_id", title, "doc_kind", "updated_at") VALUES ($1,$2,'My Design','whiteboard', now())`,
		designID, wsID); err != nil {
		t.Fatalf("seed design: %v", err)
	}

	svc := NewService(tx)

	ws, err := svc.GetWorkspaceID(ctx, designID)
	if err != nil || ws != wsID {
		t.Fatalf("GetWorkspaceID: ws=%s err=%v", ws, err)
	}

	rec, err := svc.GetRecord(ctx, designID)
	if err != nil {
		t.Fatalf("GetRecord: %v", err)
	}
	if rec.ID != designID || rec.WorkspaceID != wsID || rec.Title != "My Design" {
		t.Fatalf("record mismatch: %+v", rec)
	}
	if rec.DocKind == nil || *rec.DocKind != "whiteboard" {
		t.Fatalf("docKind mismatch: %+v", rec.DocKind)
	}
	if rec.DeletedAt != nil {
		t.Fatalf("expected non-deleted design")
	}

	list, err := svc.ListByWorkspace(ctx, wsID, 50)
	if err != nil {
		t.Fatalf("ListByWorkspace: %v", err)
	}
	if len(list) != 1 || list[0].ID != designID {
		t.Fatalf("list mismatch: %+v", list)
	}

	// Unknown design -> ErrNoRows.
	if _, err := svc.GetWorkspaceID(ctx, uuid.NewString()); err == nil {
		t.Fatal("expected error for unknown design")
	}
}

func stripSchema(dsn string) string {
	for _, sep := range []string{"?schema=", "&schema="} {
		if i := strings.Index(dsn, sep); i >= 0 {
			return dsn[:i]
		}
	}
	return dsn
}
