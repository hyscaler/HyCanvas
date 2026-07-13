package accounts

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// txService opens a transaction that the caller rolls back, and a Service on it,
// so a DB integration test leaves nothing behind. Skips when DATABASE_URL is
// unset, matching the other DB tests in this package.
func txService(t *testing.T) (context.Context, *Service, func()) {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping DB integration test")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, emailStripSchema(dsn))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	return ctx, NewService(tx, "test-jwt-secret"), func() {
		_ = tx.Rollback(ctx)
		conn.Close(ctx)
	}
}

func userExists(ctx context.Context, s *Service, email string) bool {
	_, err := s.findUserByEmail(ctx, email)
	return err == nil
}

// Magic-link signup is create-on-redeem: requesting a link for a new email must
// NOT create an account; only redeeming it does.
func TestMagicLinkSignupCreatesOnRedeem(t *testing.T) {
	ctx, svc, done := txService(t)
	defer done()
	email := "magicnew+" + uuid.NewString() + "@example.com"

	// Request a signup link. No account yet.
	if err := svc.RequestMagicLink(ctx, email, true); err != nil {
		t.Fatalf("request: %v", err)
	}
	if userExists(ctx, svc, email) {
		t.Fatal("requesting a magic-link signup must not create the account")
	}
	tok := lastToken(svc)
	if tok == "" {
		t.Fatal("no signup link was delivered")
	}

	// Redeem: now the account exists and a session is issued.
	u, tokens, err := svc.LoginWithMagicLink(ctx, tok, "d", "ip", true)
	if err != nil || u == nil || tokens == nil || tokens.Access == "" {
		t.Fatalf("redeem should create + sign in: %v", err)
	}
	if !userExists(ctx, svc, email) {
		t.Fatal("account should exist after redeem")
	}
	var owner int
	_ = svc.db.QueryRow(ctx, `SELECT count(*) FROM "workspace_members" WHERE "user_id" = $1 AND role = 'OWNER'`, u.ID).Scan(&owner)
	if owner != 1 {
		t.Fatalf("new magic-signup account should own one workspace, got %d", owner)
	}

	// Redeeming the same signup token again just signs the now-existing user in
	// (idempotent replay), not a duplicate account.
	u2, _, err := svc.LoginWithMagicLink(ctx, tok, "d", "ip", true)
	if err != nil || u2 == nil || u2.ID != u.ID {
		t.Fatalf("replay should reuse the account: %v (u2=%v)", err, u2)
	}
}

// With signup disabled, a request for a new email is a silent no-op and a signup
// token cannot be redeemed into an account.
func TestMagicLinkSignupDisabled(t *testing.T) {
	ctx, svc, done := txService(t)
	defer done()
	email := "magicoff+" + uuid.NewString() + "@example.com"

	if err := svc.RequestMagicLink(ctx, email, false); err != nil {
		t.Fatalf("request: %v", err)
	}
	if lastToken(svc) != "" {
		t.Fatal("a disabled magic-link signup must send no link")
	}
	// Even a hand-built valid signup token is refused at redeem when signup is off.
	tok := svc.signMagicSignupToken(email)
	if _, _, err := svc.LoginWithMagicLink(ctx, tok, "d", "ip", false); !errors.Is(err, ErrToken) {
		t.Errorf("redeem with signup disabled should fail with ErrToken, got %v", err)
	}
	if userExists(ctx, svc, email) {
		t.Fatal("no account should have been created")
	}
}

// OIDC signup gate: a brand-new identity is refused when OidcSignup is off, and
// admitted when it is on.
func TestOidcSignupGate(t *testing.T) {
	ctx, svc, done := txService(t)
	defer done()
	profile := OidcProfile{Subject: "sub-" + uuid.NewString(), Email: "ssogate+" + uuid.NewString() + "@example.com", EmailVerified: true, Name: "SSO"}

	// allowSignup=false: a new identity is refused, no account created.
	if _, _, _, err := svc.LoginWithOidc(ctx, profile, "d", "ip", true, false); !errors.Is(err, ErrOidcSignupDisabled) {
		t.Fatalf("new OIDC identity with signup off should be refused, got %v", err)
	}
	if userExists(ctx, svc, profile.Email) {
		t.Fatal("no account should exist after a refused OIDC signup")
	}

	// allowSignup=true: the account is created.
	u, _, _, err := svc.LoginWithOidc(ctx, profile, "d", "ip", true, true)
	if err != nil || u == nil {
		t.Fatalf("OIDC signup should succeed when enabled: %v", err)
	}

	// allowLogin=false: the now-returning identity is refused.
	if _, _, _, err := svc.LoginWithOidc(ctx, profile, "d", "ip", false, true); !errors.Is(err, ErrOidcLoginDisabled) {
		t.Fatalf("returning OIDC identity with login off should be refused, got %v", err)
	}
}
