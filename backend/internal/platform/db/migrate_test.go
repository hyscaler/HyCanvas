package db

import (
	"context"
	"os"
	"strings"
	"testing"

	"hycanvas/backend/internal/migrations"
)

// TestMigrate_FreshSchema applies the full embedded migration set into a throwaway
// schema and asserts the resulting database has the expected tables, then proves
// a second run is a no-op (idempotent).
func TestMigrate_FreshSchema(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping migration integration test")
	}
	ctx := context.Background()

	// A unique schema name so the test is isolated and self-cleaning. The schema
	// is derived from the test name (no Date/rand available), dropped on cleanup.
	schema := "migtest_oc"
	base := stripSchemaParam(dsn)

	admin, err := Connect(ctx, base)
	if err != nil {
		t.Fatalf("connect admin: %v", err)
	}
	defer admin.Close()
	if _, err := admin.Exec(ctx, `DROP SCHEMA IF EXISTS "`+schema+`" CASCADE`); err != nil {
		t.Fatalf("drop pre-existing schema: %v", err)
	}
	if _, err := admin.Exec(ctx, `CREATE SCHEMA "`+schema+`"`); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), `DROP SCHEMA IF EXISTS "`+schema+`" CASCADE`)
	})

	pool, err := Connect(ctx, base+"?schema="+schema)
	if err != nil {
		t.Fatalf("connect to test schema: %v", err)
	}
	defer pool.Close()

	if err := Migrate(ctx, pool, migrations.FS); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	// Spot-check tables created across the migration set.
	for _, table := range []string{"users", "workspaces", "designs", "design_versions", "comments", "brand_kits"} {
		var present bool
		if err := pool.QueryRow(ctx,
			`SELECT to_regclass($1) IS NOT NULL`, `"`+schema+`"."`+table+`"`).Scan(&present); err != nil {
			t.Fatalf("probe table %s: %v", table, err)
		}
		if !present {
			t.Fatalf("expected table %q after migration", table)
		}
	}

	// Every migration directory is recorded as applied.
	var applied int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM "_oc_migrations"`).Scan(&applied); err != nil {
		t.Fatalf("count applied: %v", err)
	}
	names, _ := migrationNames(migrations.FS)
	if applied != len(names) {
		t.Fatalf("expected %d migrations recorded, got %d", len(names), applied)
	}

	// Second run is a clean no-op.
	if err := Migrate(ctx, pool, migrations.FS); err != nil {
		t.Fatalf("Migrate (second run): %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM "_oc_migrations"`).Scan(&applied); err != nil {
		t.Fatalf("count applied after rerun: %v", err)
	}
	if applied != len(names) {
		t.Fatalf("rerun changed applied count: got %d want %d", applied, len(names))
	}
}

func stripSchemaParam(dsn string) string {
	for _, sep := range []string{"?schema=", "&schema="} {
		if i := strings.Index(dsn, sep); i >= 0 {
			return dsn[:i]
		}
	}
	return dsn
}
