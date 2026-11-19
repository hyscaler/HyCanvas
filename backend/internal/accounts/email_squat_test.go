package accounts

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/auth/totp"
)

// TestUnverifiedEmailCannotClaimInvitations_DB: password signup does not prove
// the email, so an account registered under an invited address must not see or
// answer that invitation in-app until the address is verified. The emailed
// token link still works (it proves the inbox) and verifies the email.
func TestUnverifiedEmailCannotClaimInvitations_DB(t *testing.T) {
	svc, tx, ctx := squatSvc(t)

	owner, _, _, err := svc.Signup(ctx, "owner+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup owner: %v", err)
	}
	ws, err := svc.CreateWorkspace(ctx, owner.ID, "Team", "team")
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}

	// The admin invites an address that has no account yet; someone else
	// registers it with a password before the real person does.
	invited := "new.hire+" + uuid.NewString() + "@example.com"
	inv, _, err := svc.Invite(ctx, owner.ID, ws.ID, invited, "admin")
	if err != nil {
		t.Fatalf("invite: %v", err)
	}
	squatter, _, _, err := svc.Signup(ctx, invited, "attacker-password", "Squatter")
	if err != nil {
		t.Fatalf("squatter signup: %v", err)
	}
	if _, err := svc.MyInvitations(ctx, squatter.ID); !errors.Is(err, ErrEmailUnverified) {
		t.Fatalf("an unverified account must not list invitations, got %v", err)
	}
	if _, err := svc.RespondToInvitation(ctx, squatter.ID, inv.ID, true); !errors.Is(err, ErrEmailUnverified) {
		t.Fatalf("an unverified account must not accept by id, got %v", err)
	}
	if _, err := svc.RespondToInvitation(ctx, squatter.ID, inv.ID, false); !errors.Is(err, ErrEmailUnverified) {
		t.Fatalf("an unverified account must not decline by id, got %v", err)
	}
	var members int
	_ = tx.QueryRow(ctx, `SELECT count(*) FROM "workspace_members" WHERE "workspace_id"=$1 AND "user_id"=$2`, ws.ID, squatter.ID).Scan(&members)
	if members != 0 {
		t.Fatal("the unverified account joined the workspace")
	}

	// Once the address is verified, the in-app flow works as before.
	if err := svc.RequestEmailVerification(ctx, invited); err != nil {
		t.Fatalf("RequestEmailVerification: %v", err)
	}
	if _, err := svc.VerifyEmail(ctx, lastToken(svc)); err != nil {
		t.Fatalf("VerifyEmail: %v", err)
	}
	list, err := svc.MyInvitations(ctx, squatter.ID)
	if err != nil || len(list) != 1 || list[0].ID != inv.ID {
		t.Fatalf("verified account should list its invitation: %+v err=%v", list, err)
	}
	if _, err := svc.RespondToInvitation(ctx, squatter.ID, inv.ID, true); err != nil {
		t.Fatalf("verified accept: %v", err)
	}

	// The emailed token link proves the inbox: an unverified account with the
	// matching email may redeem it, and that verifies the email.
	second := "second+" + uuid.NewString() + "@example.com"
	_, token, err := svc.Invite(ctx, owner.ID, ws.ID, second, "member")
	if err != nil {
		t.Fatalf("invite second: %v", err)
	}
	u2, _, _, err := svc.Signup(ctx, second, "a-strong-password", "Second")
	if err != nil {
		t.Fatalf("signup second: %v", err)
	}
	if _, err := svc.AcceptInvitation(ctx, u2.ID, token); err != nil {
		t.Fatalf("token accept: %v", err)
	}
	if got, _ := svc.GetUserByID(ctx, u2.ID); got == nil || !got.EmailVerified {
		t.Fatal("redeeming the emailed invitation should verify the email")
	}
}

// TestMagicLinkTakesOverSquattedAccount_DB: when a magic link is the first
// proof of an address, the account's creator never owned it, so the password,
// sessions and API keys they set up stop working. A verified account and an
// MFA-protected one keep everything.
func TestMagicLinkTakesOverSquattedAccount_DB(t *testing.T) {
	svc, tx, ctx := squatSvc(t)

	email := "victim+" + uuid.NewString() + "@example.com"
	squatter, ws, _, err := svc.Signup(ctx, email, "attacker-password", "Squatter")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO "api_keys" (id,"workspace_id","user_id",label,prefix,"key_hash",scopes) VALUES ($1,$2,$3,'k','hc_x',$4,'{}')`,
		uuid.NewString(), ws.ID, squatter.ID, uuid.NewString()); err != nil {
		t.Fatalf("api key: %v", err)
	}

	// The real owner signs in with an emailed link.
	if err := svc.RequestMagicLink(ctx, email, false); err != nil {
		t.Fatalf("RequestMagicLink: %v", err)
	}
	u, tokens, _, err := svc.LoginWithMagicLink(ctx, lastToken(svc), "d", "ip", false)
	if err != nil || u == nil || tokens == nil {
		t.Fatalf("magic link: user=%v tokens=%v err=%v", u, tokens, err)
	}
	if !u.EmailVerified {
		t.Fatal("the magic link should verify the email")
	}
	if _, _, _, err := svc.Login(ctx, email, "attacker-password", "d", "ip"); err == nil {
		t.Fatal("the squatter's password must stop working")
	}
	var sessions, liveKeys int
	_ = tx.QueryRow(ctx, `SELECT count(*) FROM "sessions" WHERE "user_id"=$1`, squatter.ID).Scan(&sessions)
	_ = tx.QueryRow(ctx, `SELECT count(*) FROM "api_keys" WHERE "user_id"=$1 AND "revoked_at" IS NULL`, squatter.ID).Scan(&liveKeys)
	if sessions != 1 || liveKeys != 0 {
		t.Fatalf("only the owner's new session should remain and keys be revoked: sessions=%d keys=%d", sessions, liveKeys)
	}

	// The owner sets a password of their own; a later magic link on the now
	// verified account leaves it alone.
	if err := svc.RequestPasswordReset(ctx, email); err != nil {
		t.Fatalf("RequestPasswordReset: %v", err)
	}
	if err := svc.ResetPassword(ctx, lastToken(svc), "owner-new-password"); err != nil {
		t.Fatalf("ResetPassword: %v", err)
	}
	if err := svc.RequestMagicLink(ctx, email, false); err != nil {
		t.Fatalf("RequestMagicLink 2: %v", err)
	}
	if _, _, _, err := svc.LoginWithMagicLink(ctx, lastToken(svc), "d", "ip", false); err != nil {
		t.Fatalf("magic link 2: %v", err)
	}
	if _, _, _, err := svc.Login(ctx, email, "owner-new-password", "d", "ip"); err != nil {
		t.Fatalf("a verified account keeps its password: %v", err)
	}

	// An unverified account with MFA: the link still asks for the code, and
	// nothing is stripped or verified by the link alone.
	mfaEmail := "mfa+" + uuid.NewString() + "@example.com"
	mu, _, _, err := svc.Signup(ctx, mfaEmail, "mfa-password-1", "MFA")
	if err != nil {
		t.Fatalf("signup mfa: %v", err)
	}
	_, secret, err := svc.BeginMfaEnrollment(ctx, mu.ID)
	if err != nil {
		t.Fatalf("enroll: %v", err)
	}
	code, _ := totp.Code(secret, time.Now().UnixMilli())
	if _, err := svc.ConfirmMfaEnrollment(ctx, mu.ID, code); err != nil {
		t.Fatalf("confirm: %v", err)
	}
	if err := svc.RequestMagicLink(ctx, mfaEmail, false); err != nil {
		t.Fatalf("RequestMagicLink mfa: %v", err)
	}
	if _, _, mfaToken, err := svc.LoginWithMagicLink(ctx, lastToken(svc), "d", "ip", false); err != ErrMFARequired || mfaToken == "" {
		t.Fatalf("MFA account should be challenged: err=%v", err)
	}
	got, _ := svc.GetUserByID(ctx, mu.ID)
	if got == nil || got.EmailVerified || !got.MFAEnabled {
		t.Fatalf("an MFA account must keep MFA and stay unverified: %+v", got)
	}
	if _, _, mfaToken, err := svc.Login(ctx, mfaEmail, "mfa-password-1", "d", "ip"); err != ErrMFARequired || mfaToken == "" {
		t.Fatalf("an MFA account keeps its password: err=%v", err)
	}
}

func squatSvc(t *testing.T) (*Service, pgx.Tx, context.Context) {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping DB integration test")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, stripSchema(dsn))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { conn.Close(ctx) })
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	t.Cleanup(func() { _ = tx.Rollback(ctx) })
	return NewService(tx, "test-jwt-secret"), tx, ctx
}
