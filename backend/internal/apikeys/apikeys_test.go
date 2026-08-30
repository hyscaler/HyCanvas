package apikeys

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/accounts"
)

func stripSchema(dsn string) string {
	for _, sep := range []string{"?schema=", "&schema="} {
		if i := strings.Index(dsn, sep); i >= 0 {
			return dsn[:i]
		}
	}
	return dsn
}

func TestAPIKeys_DB(t *testing.T) {
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

	acct := accounts.NewService(tx, "test-jwt-secret")
	user, ws, _, err := acct.Signup(ctx, "apikey-owner+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	svc := NewService(tx)

	// Mint: raw key comes back exactly once with the hyk_ prefix; the view
	// carries the display prefix and scopes, never the hash or raw key.
	raw, view, err := svc.Mint(ctx, ws.ID, user.ID, "  CI deck bot  ", []string{"generate", "READ", "generate"})
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	if !strings.HasPrefix(raw, Prefix) || len(raw) < 40 {
		t.Fatalf("raw key shape wrong: %q", raw)
	}
	if view.Label != "CI deck bot" || view.Prefix != raw[:12] || view.Revoked {
		t.Fatalf("view wrong: %+v", view)
	}
	if len(view.Scopes) != 2 || view.Scopes[0] != "generate" || view.Scopes[1] != "read" {
		t.Fatalf("scopes not normalized/deduped: %v", view.Scopes)
	}

	// Invalid mints are rejected.
	if _, _, err := svc.Mint(ctx, ws.ID, user.ID, "", []string{"generate"}); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("blank label must be rejected, got %v", err)
	}
	if _, _, err := svc.Mint(ctx, ws.ID, user.ID, "x", []string{"admin"}); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("unknown scope must be rejected, got %v", err)
	}
	if _, _, err := svc.Mint(ctx, ws.ID, user.ID, "x", nil); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("empty scopes must be rejected, got %v", err)
	}

	// Verify: the raw key authenticates and carries the key's identity.
	info, err := svc.Verify(ctx, raw)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if info.WorkspaceID != ws.ID || info.UserID != user.ID || !info.HasScope("generate") || info.HasScope("export") {
		t.Fatalf("info wrong: %+v", info)
	}
	if _, err := svc.Verify(ctx, Prefix+"not-a-real-key"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("bogus key must be ErrNotFound, got %v", err)
	}
	if _, err := svc.Verify(ctx, "sess-token"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("non-prefixed token must be ErrNotFound, got %v", err)
	}

	// List shows the key without secrets; Revoke kills verification and is
	// tenant-scoped (a wrong workspace id 404s instead of revoking).
	keys, err := svc.List(ctx, ws.ID)
	if err != nil || len(keys) != 1 {
		t.Fatalf("list: %v %d", err, len(keys))
	}
	if err := svc.Revoke(ctx, view.ID, uuid.NewString()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant revoke must 404, got %v", err)
	}
	if err := svc.Revoke(ctx, view.ID, ws.ID); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, err := svc.Verify(ctx, raw); !errors.Is(err, ErrRevoked) {
		t.Fatalf("revoked key must be ErrRevoked, got %v", err)
	}
	if err := svc.Revoke(ctx, view.ID, ws.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("double revoke must 404, got %v", err)
	}
}
