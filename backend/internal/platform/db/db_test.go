package db

import "testing"

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
