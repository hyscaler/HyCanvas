// Package db opens the shared Postgres pool with pgx. The Go service connects to
// the SAME database the NestJS/Prisma backend uses (no data migration), so it
// accepts Prisma's `?schema=public` DSN by translating it into a search_path
// runtime parameter that libpq/pgx understands.
package db

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// pingTimeout bounds the connectivity check on the initial connect.
const pingTimeout = 5 * time.Second

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

	pingCtx, cancel := context.WithTimeout(ctx, pingTimeout)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, pingErr(cfg, err)
	}
	return pool, nil
}

// pingErr annotates a failed connectivity check with the address that was tried,
// never the credentials. pgx reports a refused port or an unresolvable host with
// a descriptive error, but when packets are silently dropped (a firewall, or two
// containers that share no route) the ping just hits its deadline and pgx returns
// a bare "context deadline exceeded", which tells an operator nothing about what
// was unreachable or why.
func pingErr(cfg *pgxpool.Config, err error) error {
	addr := net.JoinHostPort(cfg.ConnConfig.Host, strconv.Itoa(int(cfg.ConnConfig.Port)))
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("timed out after %s connecting to postgres at %s: %w "+
			"(the address did not refuse the connection, it never answered: check that the database is reachable from here "+
			"and that no firewall or container network is dropping the traffic)", pingTimeout, addr, err)
	}
	return fmt.Errorf("connecting to postgres at %s: %w", addr, err)
}

// ConnectWithRetry opens the pool like Connect, but tolerates a database that is
// still coming up when the app boots, which is common right after a host reboot
// when the process races Postgres. It retries a failed connect up to `attempts`
// times, waiting `delay` between tries, and returns the first pool that connects
// or the last error. attempts < 1 is treated as a single try (no retry). When
// set, onRetry is called before each wait (with the attempt just made and how
// many remain) so the caller can log progress. A cancelled ctx aborts the wait.
func ConnectWithRetry(ctx context.Context, raw string, attempts int, delay time.Duration, onRetry func(attempt, remaining int, err error)) (*pgxpool.Pool, error) {
	if attempts < 1 {
		attempts = 1
	}
	var lastErr error
	for i := 1; i <= attempts; i++ {
		pool, err := Connect(ctx, raw)
		if err == nil {
			return pool, nil
		}
		lastErr = err
		if i == attempts {
			break
		}
		if onRetry != nil {
			onRetry(i, attempts-i, err)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(delay):
		}
	}
	return nil, lastErr
}
