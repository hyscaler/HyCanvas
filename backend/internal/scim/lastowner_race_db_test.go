package scim

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Two concurrent syncs each removing one of a workspace's two owners must not
// both succeed. Under READ COMMITTED, the second sees the first's delete only
// after it commits, so the guard has to lock the owner rows before counting.
// This test needs committed rows (two connections), so it cleans up after itself.
func TestLastOwnerGuardHoldsUnderConcurrency_DB(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping DB integration test")
	}
	if i := strings.Index(dsn, "?schema="); i >= 0 {
		dsn = dsn[:i]
	}
	ctx := context.Background()
	connect := func() *pgx.Conn {
		c, err := pgx.Connect(ctx, dsn)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = c.Close(ctx) })
		return c
	}
	setup, c1, c2 := connect(), connect(), connect()

	n := uuid.NewString()[:8]
	a, b, ws := uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO "users" (id, email, name, "updated_at") VALUES ($1, $2, 'A', now()), ($3, $4, 'B', now())`, []any{a, "race-a-" + n + "@example.com", b, "race-b-" + n + "@example.com"}},
		{`INSERT INTO "workspaces" (id, kind, name, slug, "owner_id", "updated_at") VALUES ($1, 'TEAM', 'Race', $2, $3, now())`, []any{ws, "race-" + n, a}},
		{`INSERT INTO "workspace_members" (id, "workspace_id", "user_id", role, status, "updated_at") VALUES ($1, $3, $4, 'OWNER', 'ACTIVE', now()), ($2, $3, $5, 'OWNER', 'ACTIVE', now())`, []any{uuid.NewString(), uuid.NewString(), ws, a, b}},
	} {
		if _, err := setup.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = setup.Exec(ctx, `DELETE FROM "workspaces" WHERE id = $1`, ws)
		_, _ = setup.Exec(ctx, `DELETE FROM "users" WHERE id = ANY($1::uuid[])`, []string{a, b})
	})

	srv := &Server{log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	tx1, err := c1.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx1.Rollback(ctx) }()
	tx2, err := c2.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx2.Rollback(ctx) }()

	// Sync 1 decides A is not the last owner and removes A, uncommitted.
	if last, err := srv.isLastOwner(&op{ctx: ctx, tx: tx1}, ws, a, "OWNER", "ACTIVE"); err != nil || last {
		t.Fatalf("sync 1: last=%v err=%v, want false (B is another owner)", last, err)
	}
	if _, err := tx1.Exec(ctx, `DELETE FROM "workspace_members" WHERE "workspace_id" = $1 AND "user_id" = $2`, ws, a); err != nil {
		t.Fatal(err)
	}

	// Sync 2 asks the same about B while sync 1 is in flight.
	type answer struct {
		last bool
		err  error
	}
	got := make(chan answer, 1)
	go func() {
		last, err := srv.isLastOwner(&op{ctx: ctx, tx: tx2}, ws, b, "OWNER", "ACTIVE")
		got <- answer{last, err}
	}()
	select {
	case r := <-got:
		t.Fatalf("sync 2 answered (last=%v, err=%v) before sync 1 committed: the owner rows are not locked", r.last, r.err)
	case <-time.After(300 * time.Millisecond):
	}
	if err := tx1.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case r := <-got:
		if r.err != nil || !r.last {
			t.Fatalf("sync 2 after sync 1 committed: last=%v err=%v, want true (B is now the only owner)", r.last, r.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("sync 2 never answered")
	}
}
