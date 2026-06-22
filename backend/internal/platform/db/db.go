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

// Connect parses the DSN (handling Prisma's `schema` query param), opens a pool,
// and verifies connectivity with a ping.
func Connect(ctx context.Context, raw string) (*pgxpool.Pool, error) {
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
