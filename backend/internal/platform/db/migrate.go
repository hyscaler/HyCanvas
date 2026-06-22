package db

import (
	"context"
	"fmt"
	"io/fs"
	"sort"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Migrate applies pending SQL migrations from sqlFS in lexical order, tracking
// applied names in "_oc_migrations". Each migration runs in its own transaction;
// a failure aborts that migration and stops the run. Re-running is a no-op once
// everything is applied, so it is safe to call on every boot.
//
// sqlFS is expected to contain sql/<name>/migration.sql entries (the embedded
// migrations.FS). The <name> directory matches the original Prisma migration
// name, so a database previously managed by Prisma is baselined automatically:
// if "_prisma_migrations" exists and "_oc_migrations" is empty, the finished
// Prisma migrations are recorded as applied, so their CREATE statements are not
// replayed against the already-provisioned schema.
func Migrate(ctx context.Context, pool *pgxpool.Pool, sqlFS fs.FS) error {
	if _, err := pool.Exec(ctx, `CREATE TABLE IF NOT EXISTS "_oc_migrations" (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		return fmt.Errorf("create migrations table: %w", err)
	}

	if err := baselineFromPrisma(ctx, pool); err != nil {
		return err
	}

	applied, err := appliedSet(ctx, pool)
	if err != nil {
		return err
	}

	names, err := migrationNames(sqlFS)
	if err != nil {
		return err
	}

	for _, name := range names {
		if applied[name] {
			continue
		}
		sqlBytes, err := fs.ReadFile(sqlFS, "sql/"+name+"/migration.sql")
		if err != nil {
			return fmt.Errorf("read migration %s: %w", name, err)
		}
		if err := applyOne(ctx, pool, name, string(sqlBytes)); err != nil {
			return fmt.Errorf("apply migration %s: %w", name, err)
		}
	}
	return nil
}

// baselineFromPrisma records already-finished Prisma migrations as applied when
// the Go tracking table is empty, so a handoff from the NestJS/Prisma backend
// does not replay schema-creating SQL against an existing database.
func baselineFromPrisma(ctx context.Context, pool *pgxpool.Pool) error {
	var hasPrisma bool
	if err := pool.QueryRow(ctx, `SELECT to_regclass('_prisma_migrations') IS NOT NULL`).Scan(&hasPrisma); err != nil {
		return fmt.Errorf("probe _prisma_migrations: %w", err)
	}
	if !hasPrisma {
		return nil
	}
	var ocCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM "_oc_migrations"`).Scan(&ocCount); err != nil {
		return fmt.Errorf("count _oc_migrations: %w", err)
	}
	if ocCount > 0 {
		return nil
	}
	if _, err := pool.Exec(ctx, `INSERT INTO "_oc_migrations" (name) SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ON CONFLICT (name) DO NOTHING`); err != nil {
		return fmt.Errorf("baseline from _prisma_migrations: %w", err)
	}
	return nil
}

func appliedSet(ctx context.Context, pool *pgxpool.Pool) (map[string]bool, error) {
	rows, err := pool.Query(ctx, `SELECT name FROM "_oc_migrations"`)
	if err != nil {
		return nil, fmt.Errorf("read applied migrations: %w", err)
	}
	defer rows.Close()
	applied := map[string]bool{}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		applied[n] = true
	}
	return applied, rows.Err()
}

func migrationNames(sqlFS fs.FS) ([]string, error) {
	entries, err := fs.ReadDir(sqlFS, "sql")
	if err != nil {
		return nil, fmt.Errorf("read migrations dir: %w", err)
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	return names, nil
}

// applyOne runs a single migration file inside a transaction and records it.
func applyOne(ctx context.Context, pool *pgxpool.Pool, name, sql string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, sql); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO "_oc_migrations" (name) VALUES ($1)`, name); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
