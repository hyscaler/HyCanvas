package db

import (
	"context"
	"testing"
	"time"
)

// A refused local port fails each connect attempt fast, so the retry loop can be
// exercised without a real database.
const refusedDSN = "postgres://u:p@127.0.0.1:1/db"

// ConnectWithRetry retries attempts-1 times (waiting between tries) before it
// gives up, and reports progress through onRetry.
func TestConnectWithRetry_RetriesThenFails(t *testing.T) {
	retries := 0
	start := time.Now()
	pool, err := ConnectWithRetry(context.Background(), refusedDSN, 3, 20*time.Millisecond,
		func(attempt, remaining int, err error) { retries++ })
	if pool != nil {
		pool.Close()
	}
	if err == nil {
		t.Fatal("expected an error connecting to a refused port")
	}
	if retries != 2 {
		t.Fatalf("onRetry called %d times, want 2 (attempts-1)", retries)
	}
	if elapsed := time.Since(start); elapsed < 40*time.Millisecond {
		t.Fatalf("did not wait between retries (elapsed %s)", elapsed)
	}
}

// A non-positive attempts count means a single try, with no retry callback.
func TestConnectWithRetry_SingleTry(t *testing.T) {
	retries := 0
	if _, err := ConnectWithRetry(context.Background(), refusedDSN, 0, time.Second,
		func(int, int, error) { retries++ }); err == nil {
		t.Fatal("expected an error")
	}
	if retries != 0 {
		t.Fatalf("onRetry called %d times, want 0 for a single try", retries)
	}
}

// A cancelled context aborts the wait between retries promptly rather than
// sleeping the full delay.
func TestConnectWithRetry_CancelledContextAbortsWait(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	if _, err := ConnectWithRetry(ctx, refusedDSN, 5, time.Hour, nil); err == nil {
		t.Fatal("expected an error")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("cancelled context did not abort the long wait (elapsed %s)", elapsed)
	}
}

// The session must run in UTC so CURRENT_TIMESTAMP/now() defaults on the naive
// `timestamp without time zone` columns store UTC wall-clock, matching how pgx
// reads them back (UTC-labelled) and how the code serializes (`.UTC()`).
// Without this the Version-history timestamps skew by the server's offset.
func TestBuildConfig_PinsUTCAndSchema(t *testing.T) {
	cfg, err := buildConfig("postgres://u:p@localhost:5432/hycanvas?schema=tenant7")
	if err != nil {
		t.Fatalf("buildConfig: %v", err)
	}
	rp := cfg.ConnConfig.RuntimeParams
	if rp["timezone"] != "UTC" {
		t.Fatalf("timezone = %q, want UTC", rp["timezone"])
	}
	// Prisma's `schema` query param becomes the search_path (not a DSN param).
	if rp["search_path"] != "tenant7" {
		t.Fatalf("search_path = %q, want tenant7", rp["search_path"])
	}
}

// With no `schema` param the search_path defaults to public, and UTC is still
// pinned.
func TestBuildConfig_DefaultSchema(t *testing.T) {
	cfg, err := buildConfig("postgres://u:p@localhost:5432/hycanvas")
	if err != nil {
		t.Fatalf("buildConfig: %v", err)
	}
	rp := cfg.ConnConfig.RuntimeParams
	if rp["search_path"] != "public" {
		t.Fatalf("search_path = %q, want public", rp["search_path"])
	}
	if rp["timezone"] != "UTC" {
		t.Fatalf("timezone = %q, want UTC", rp["timezone"])
	}
}

func TestBuildConfig_InvalidDSN(t *testing.T) {
	if _, err := buildConfig("://not a dsn"); err == nil {
		t.Fatal("expected error for an invalid DSN")
	}
}
