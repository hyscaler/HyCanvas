package accounts

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/auth/totp"
)

// TestMagicLinkRespectsMFA_DB: a magic link is a first factor like a password,
// so an account with MFA enabled gets a challenge from it, not a session. That
// holds for the emailed sign-in link and for a signed sign-up link that lands
// on an existing account.
func TestMagicLinkRespectsMFA_DB(t *testing.T) {
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

	svc := NewService(tx, "test-jwt-secret")
	email := "mfamagic+" + uuid.NewString() + "@example.com"
	user, _, _, err := svc.Signup(ctx, email, "a-strong-password", "MFA Magic")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	_, secret, err := svc.BeginMfaEnrollment(ctx, user.ID)
	if err != nil {
		t.Fatalf("BeginMfaEnrollment: %v", err)
	}
	code := func() string {
		c, ok := totp.Code(secret, time.Now().UnixMilli())
		if !ok {
			t.Fatal("could not compute code")
		}
		return c
	}
	if _, err := svc.ConfirmMfaEnrollment(ctx, user.ID, code()); err != nil {
		t.Fatalf("ConfirmMfaEnrollment: %v", err)
	}

	// Emailed sign-in link.
	if err := svc.RequestMagicLink(ctx, email, false); err != nil {
		t.Fatalf("RequestMagicLink: %v", err)
	}
	u, tokens, mfaToken, err := svc.LoginWithMagicLink(ctx, lastToken(svc), "d", "ip", false)
	if err != ErrMFARequired || u != nil || tokens != nil || mfaToken == "" {
		t.Fatalf("magic link should require MFA: user=%v tokens=%v mfaToken=%q err=%v", u, tokens, mfaToken, err)
	}
	// The challenge completes with the second factor, like password login.
	vu, vtokens, err := svc.VerifyMfaLogin(ctx, mfaToken, code(), "d", "ip")
	if err != nil || vu == nil || vtokens == nil || vtokens.Access == "" {
		t.Fatalf("VerifyMfaLogin after magic link: user=%v tokens=%v err=%v", vu, vtokens, err)
	}

	// Signed sign-up link for an email that already has an account.
	u, tokens, mfaToken, err = svc.LoginWithMagicLink(ctx, svc.signMagicSignupToken(email), "d", "ip", true)
	if err != ErrMFARequired || u != nil || tokens != nil || mfaToken == "" {
		t.Fatalf("sign-up link into an MFA account should require MFA: user=%v tokens=%v mfaToken=%q err=%v", u, tokens, mfaToken, err)
	}
}
