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

func TestMFA_DB(t *testing.T) {
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
	email := "mfa+" + uuid.NewString() + "@example.com"
	pw := "a-strong-password"
	user, _, _, err := svc.Signup(ctx, email, pw, "MFA User")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}

	code := func(secret string) string {
		c, ok := totp.Code(secret, time.Now().UnixMilli())
		if !ok {
			t.Fatal("could not compute code")
		}
		return c
	}

	// Enroll: get a provisional secret + otpauth URL.
	otpauthURL, secret, err := svc.BeginMfaEnrollment(ctx, user.ID)
	if err != nil || secret == "" || otpauthURL == "" {
		t.Fatalf("BeginMfaEnrollment: url=%q secret=%q err=%v", otpauthURL, secret, err)
	}

	// Confirm with a wrong code fails.
	if _, err := svc.ConfirmMfaEnrollment(ctx, user.ID, "000000"); err != ErrMFAInvalid {
		t.Fatalf("wrong confirm code should fail, got %v", err)
	}
	// Confirm with the right code: MFA on, recovery codes returned once.
	recovery, err := svc.ConfirmMfaEnrollment(ctx, user.ID, code(secret))
	if err != nil || len(recovery) != 10 {
		t.Fatalf("ConfirmMfaEnrollment: codes=%d err=%v", len(recovery), err)
	}

	// Re-enrolling now fails (already enabled).
	if _, _, err := svc.BeginMfaEnrollment(ctx, user.ID); err != ErrMFAAlready {
		t.Fatalf("re-enroll should fail, got %v", err)
	}

	// Login now returns an MFA challenge (no session).
	u2, tokens, mfaToken, err := svc.Login(ctx, email, pw, "d", "ip")
	if err != ErrMFARequired || u2 != nil || tokens != nil || mfaToken == "" {
		t.Fatalf("login should require MFA: u=%v tokens=%v token=%q err=%v", u2, tokens, mfaToken, err)
	}

	// Verify with a wrong code fails.
	if _, _, err := svc.VerifyMfaLogin(ctx, mfaToken, "000000", "d", "ip"); err != ErrMFAInvalid {
		t.Fatalf("wrong verify code should fail, got %v", err)
	}
	// Verify with a valid TOTP code yields a session.
	vu, vtokens, err := svc.VerifyMfaLogin(ctx, mfaToken, code(secret), "d", "ip")
	if err != nil || vu == nil || vtokens == nil || vtokens.Access == "" {
		t.Fatalf("VerifyMfaLogin: %v", err)
	}

	// A recovery code also works as a second factor, and is single-use.
	rc := recovery[0]
	mfaToken2, err := svc.mfaChallengeFor(ctx, email, pw)
	if err != nil {
		t.Fatalf("second challenge: %v", err)
	}
	if _, _, err := svc.VerifyMfaLogin(ctx, mfaToken2, rc, "d", "ip"); err != nil {
		t.Fatalf("recovery code verify: %v", err)
	}
	// The same recovery code cannot be reused.
	mfaToken3, _ := svc.mfaChallengeFor(ctx, email, pw)
	if _, _, err := svc.VerifyMfaLogin(ctx, mfaToken3, rc, "d", "ip"); err != ErrMFAInvalid {
		t.Fatalf("reused recovery code should fail, got %v", err)
	}

	// Disable with a wrong code fails; with a valid TOTP code succeeds.
	if err := svc.DisableMfa(ctx, user.ID, "000000"); err != ErrMFAInvalid {
		t.Fatalf("wrong disable code should fail, got %v", err)
	}
	if err := svc.DisableMfa(ctx, user.ID, code(secret)); err != nil {
		t.Fatalf("DisableMfa: %v", err)
	}
	// Login no longer requires MFA.
	if _, _, _, err := svc.Login(ctx, email, pw, "d", "ip"); err != nil {
		t.Fatalf("login after disable: %v", err)
	}
}

// mfaChallengeFor logs in (expecting ErrMFARequired) and returns the challenge.
func (s *Service) mfaChallengeFor(ctx context.Context, email, pw string) (string, error) {
	_, _, mfaToken, err := s.Login(ctx, email, pw, "d", "ip")
	if err != ErrMFARequired {
		return "", err
	}
	return mfaToken, nil
}
