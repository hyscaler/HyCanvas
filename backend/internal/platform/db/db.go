// Package db opens the shared Postgres pool with pgx. The Go service connects to
// the SAME database the NestJS/Prisma backend uses (no data migration), so it
// accepts Prisma's `?schema=public` DSN by translating it into a search_path
// runtime parameter that libpq/pgx understands.
package db

import (
	"context"
	"net/url"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// buildConfig parses the DSN (handling Prisma's `schema` query param) into a
// pool config, pinning the session search_path and timezone.
//
// timezone is pinned to UTC on every connection. The `created_at`/`updated_at`
// columns are `timestamp without time zone`, and pgx reads such values back as a
// UTC-labelled time.Time; the whole codebase serializes with `.UTC()`. For that
// to be truthful, the value written by `CURRENT_TIMESTAMP`/`now()` defaults must
// also be UTC wall-clock, which only holds when the session runs in UTC. Without
// this, a server whose default timezone is not UTC stores local wall-clock and
// every timestamp comes back skewed by the offset (e.g. a just-created version
// showing "7h ago" in Version history).
func buildConfig(raw string) (*pgxpool.Config, error) {
	schema := "public"
	if u, err := url.Parse(raw); err == nil {
		q := u.Query()
		if s := q.Get("schema"); s != "" {
			schema = s
			q.Del("schema")
			u.RawQuery = q.Encode()
			raw = u.String()
		}
	}

	cfg, err := pgxpool.ParseConfig(raw)
	if err != nil {
		return nil, err
	}
	if cfg.ConnConfig.RuntimeParams == nil {
		cfg.ConnConfig.RuntimeParams = map[string]string{}
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	cfg.ConnConfig.RuntimeParams["timezone"] = "UTC"
	return cfg, nil
}

// Connect parses the DSN (handling Prisma's `schema` query param), opens a pool,
// and verifies connectivity with a ping.
func Connect(ctx context.Context, raw string) (*pgxpool.Pool, error) {
	cfg, err := buildConfig(raw)
	if err != nil {
		return nil, err
	}

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}

	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}
