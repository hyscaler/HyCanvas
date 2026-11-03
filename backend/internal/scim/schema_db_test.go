package scim

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

// testTx opens a transaction against DATABASE_URL that the test rolls back, so
// DB tests never leave rows behind. Skips when no database is configured.
func testTx(t *testing.T) pgx.Tx {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping DB integration test")
	}
	if i := strings.Index(dsn, "?schema="); i >= 0 {
		dsn = dsn[:i]
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	t.Cleanup(func() {
		_ = tx.Rollback(ctx)
		_ = conn.Close(ctx)
	})
	return tx
}

// The SCIM migration is additive: new columns default so existing rows read
// unchanged, and the SCIM tables exist.
func TestSchema_DB(t *testing.T) {
	tx := testTx(t)
	ctx := context.Background()
	for _, c := range []struct{ table, column string }{
		{"users", "deactivated_at"},
		{"workspace_members", "managed_by_scim"},
		{"workspace_members", "suspended_by_deactivation"},
		{"scim_users", "external_id"},
		{"scim_users", "user_name"},
		{"scim_users", "deleted_at"},
		{"scim_groups", "display_name"},
		{"scim_group_members", "user_id"},
	} {
		var n int
		if err := tx.QueryRow(ctx,
			`SELECT count(*) FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
			c.table, c.column).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Errorf("%s.%s missing", c.table, c.column)
		}
	}
	var def string
	if err := tx.QueryRow(ctx,
		`SELECT column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'workspace_members' AND column_name = 'managed_by_scim'`).Scan(&def); err != nil {
		t.Fatal(err)
	}
	if def != "false" {
		t.Errorf("managed_by_scim default = %q, want false so existing memberships stay hand-managed", def)
	}
}
