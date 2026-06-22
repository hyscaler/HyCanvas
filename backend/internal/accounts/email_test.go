package accounts

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func emailStripSchema(dsn string) string {
	for _, sep := range []string{"?schema=", "&schema="} {
		if i := strings.Index(dsn, sep); i >= 0 {
			return dsn[:i]
		}
	}
	return dsn
}

// lastToken pulls the token query param from the most recent outbox link.
func lastToken(s *Service) string {
	box := s.Outbox()
	if len(box) == 0 {
		return ""
	}
	link := box[len(box)-1].Link
	if i := strings.Index(link, "token="); i >= 0 {
		return link[i+len("token="):]
	}
	return ""
}

func TestEmailFlows_DB(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping DB integration test")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, emailStripSchema(dsn))
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
	email := "email+" + uuid.NewString() + "@example.com"
	user, _, _, err := svc.Signup(ctx, email, "a-strong-password", "User")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}

	// Verify-email: request mints a token; verifying marks the user verified.
	if err := svc.RequestEmailVerification(ctx, email); err != nil {
		t.Fatalf("RequestEmailVerification: %v", err)
	}
	tok := lastToken(svc)
	if tok == "" {
		t.Fatal("no verification token captured")
	}
	if _, err := svc.VerifyEmail(ctx, tok); err != nil {
		t.Fatalf("VerifyEmail: %v", err)
	}
	var verified bool
	_ = tx.QueryRow(ctx, `SELECT "emailVerified" FROM "User" WHERE id = $1`, user.ID).Scan(&verified)
	if !verified {
		t.Fatal("email not marked verified")
	}
	// A used token cannot be replayed.
	if _, err := svc.VerifyEmail(ctx, tok); err == nil {
		t.Fatal("consumed token should be rejected")
	}

	// Password reset: changes the password and revokes sessions.
	if err := svc.RequestPasswordReset(ctx, email); err != nil {
		t.Fatalf("RequestPasswordReset: %v", err)
	}
	if err := svc.ResetPassword(ctx, lastToken(svc), "a-new-strong-password"); err != nil {
		t.Fatalf("ResetPassword: %v", err)
	}
	if _, _, _, err := svc.Login(ctx, email, "a-new-strong-password", "d", "ip"); err != nil {
		t.Fatalf("login with new password: %v", err)
	}
	if _, _, _, err := svc.Login(ctx, email, "a-strong-password", "d", "ip"); err == nil {
		t.Fatal("old password should no longer work")
	}

	// Magic link: signs in and issues a session.
	if err := svc.RequestMagicLink(ctx, email); err != nil {
		t.Fatalf("RequestMagicLink: %v", err)
	}
	mu, tokens, err := svc.LoginWithMagicLink(ctx, lastToken(svc), "d", "ip")
	if err != nil || mu == nil || tokens == nil || tokens.Access == "" {
		t.Fatalf("LoginWithMagicLink: user=%v tokens=%v err=%v", mu, tokens, err)
	}

	// Enumeration-safe: requesting for an unknown email is a silent no-op.
	before := len(svc.Outbox())
	if err := svc.RequestPasswordReset(ctx, "nobody+"+uuid.NewString()+"@example.com"); err != nil {
		t.Fatalf("unknown email should be silent: %v", err)
	}
	if len(svc.Outbox()) != before {
		t.Fatal("no mail should be sent for an unknown account")
	}
}
