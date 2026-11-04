package accounts

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/auth/jwt"
)

func deactivateTestTx(t *testing.T) pgx.Tx {
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
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	t.Cleanup(func() {
		_ = tx.Rollback(ctx)
		_ = conn.Close(ctx)
	})
	return tx
}

func memberStatuses(t *testing.T, tx pgx.Tx, userID string) map[string]string {
	t.Helper()
	rows, err := tx.Query(context.Background(),
		`SELECT "workspace_id", status::text || CASE WHEN "suspended_by_deactivation" THEN '+flag' ELSE '' END
		 FROM "workspace_members" WHERE "user_id" = $1`, userID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var ws, st string
		if err := rows.Scan(&ws, &st); err != nil {
			t.Fatal(err)
		}
		out[ws] = st
	}
	return out
}

// Deactivation must cut access, not just record a flag: a token issued before
// it is refused, the refresh token is dead, and signing in again is refused.
// Reactivation restores exactly what deactivation suspended.
func TestDeactivateUser_DB(t *testing.T) {
	tx := deactivateTestTx(t)
	ctx := context.Background()
	svc := NewService(tx, "test-jwt-secret")

	emailA := "deact-a+" + uuid.NewString() + "@example.com"
	a, wsA, _, err := svc.Signup(ctx, emailA, "a-strong-password", "A")
	if err != nil {
		t.Fatalf("signup a: %v", err)
	}
	b, wsB, tokensB, err := svc.Signup(ctx, "deact-b+"+uuid.NewString()+"@example.com", "a-strong-password", "B")
	if err != nil {
		t.Fatalf("signup b: %v", err)
	}
	// A is also a member of B's workspace.
	if _, err := tx.Exec(ctx,
		`INSERT INTO "workspace_members" (id, "workspace_id", "user_id", role, status, "joined_at", "updated_at")
		 VALUES ($1, $2, $3, 'MEMBER', 'ACTIVE', now(), now())`, uuid.NewString(), wsB.ID, a.ID); err != nil {
		t.Fatal(err)
	}
	_, tokensA, _, err := svc.Login(ctx, emailA, "a-strong-password", "d", "ip")
	if err != nil {
		t.Fatalf("login a: %v", err)
	}

	if err := svc.DeactivateUser(ctx, a.ID); err != nil {
		t.Fatalf("deactivate: %v", err)
	}

	if _, _, err := svc.VerifyAccess(ctx, tokensA.Access); err == nil {
		t.Fatal("an access token issued before deactivation still verifies")
	}
	if _, err := svc.Refresh(ctx, tokensA.Refresh); !errors.Is(err, ErrSessionRevoked) {
		t.Fatalf("refresh after deactivation: got %v, want ErrSessionRevoked", err)
	}
	if _, _, _, err := svc.Login(ctx, emailA, "a-strong-password", "d", "ip"); !errors.Is(err, ErrAccountDisabled) {
		t.Fatalf("login after deactivation: got %v, want ErrAccountDisabled", err)
	}
	if got := memberStatuses(t, tx, a.ID); got[wsA.ID] != "SUSPENDED+flag" || got[wsB.ID] != "SUSPENDED+flag" {
		t.Fatalf("memberships after deactivation = %v, want both SUSPENDED+flag", got)
	}
	// Nobody else is touched.
	if _, _, err := svc.VerifyAccess(ctx, tokensB.Access); err != nil {
		t.Fatalf("another user's session was affected: %v", err)
	}
	if got := memberStatuses(t, tx, b.ID); got[wsB.ID] != "ACTIVE" {
		t.Fatalf("another user's membership changed: %v", got)
	}
	// Deactivating twice is harmless.
	if err := svc.DeactivateUser(ctx, a.ID); err != nil {
		t.Fatalf("second deactivate: %v", err)
	}

	// While A is deactivated, B's admin removes A from B's workspace. Reactivation
	// must not bring that membership back.
	if _, err := tx.Exec(ctx, `DELETE FROM "workspace_members" WHERE "workspace_id" = $1 AND "user_id" = $2`, wsB.ID, a.ID); err != nil {
		t.Fatal(err)
	}

	if err := svc.ReactivateUser(ctx, a.ID); err != nil {
		t.Fatalf("reactivate: %v", err)
	}
	got := memberStatuses(t, tx, a.ID)
	if got[wsA.ID] != "ACTIVE" {
		t.Fatalf("personal workspace membership after reactivation = %q, want ACTIVE", got[wsA.ID])
	}
	if _, present := got[wsB.ID]; present {
		t.Fatal("reactivation restored a membership an admin removed")
	}
	if _, _, err := svc.VerifyAccess(ctx, tokensA.Access); err == nil {
		t.Fatal("reactivation revived a session revoked by deactivation")
	}
	if _, _, _, err := svc.Login(ctx, emailA, "a-strong-password", "d", "ip"); err != nil {
		t.Fatalf("login after reactivation: %v", err)
	}
}

// A linked SSO identity must not sign a deactivated account back in.
func TestDeactivatedOidcLogin_DB(t *testing.T) {
	tx := deactivateTestTx(t)
	ctx := context.Background()
	svc := NewService(tx, "test-jwt-secret")
	p := OidcProfile{Subject: "sub-" + uuid.NewString(), Email: "deact-sso+" + uuid.NewString() + "@example.com", EmailVerified: true, Name: "SSO"}
	u, _, _, err := svc.LoginWithOidc(ctx, p, "d", "ip", true, true)
	if err != nil {
		t.Fatalf("first sso login: %v", err)
	}
	if err := svc.DeactivateUser(ctx, u.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := svc.LoginWithOidc(ctx, p, "d", "ip", true, true); !errors.Is(err, ErrAccountDisabled) {
		t.Fatalf("sso login after deactivation: got %v, want ErrAccountDisabled", err)
	}
}

// A session that slipped in while the account was deactivated (issued between
// the check and the insert) must not come back to life on reactivation: the
// person signs in afresh (FR-18).
func TestReactivationDoesNotReviveWindowSessions_DB(t *testing.T) {
	tx := deactivateTestTx(t)
	ctx := context.Background()
	svc := NewService(tx, "test-jwt-secret")
	u, _, _, err := svc.Signup(ctx, "window+"+uuid.NewString()+"@example.com", "a-strong-password", "W")
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.DeactivateUser(ctx, u.ID); err != nil {
		t.Fatal(err)
	}
	// The race: a session row written after deactivation revoked the others.
	sid := uuid.NewString()
	if _, err := tx.Exec(ctx, `INSERT INTO "sessions" (id, "user_id", "current_token_hash") VALUES ($1, $2, $3)`, sid, u.ID, "h-"+sid); err != nil {
		t.Fatal(err)
	}
	access, err := jwt.Sign(u.ID, sid, "test-jwt-secret", AccessTTL)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.VerifyAccess(ctx, access); err == nil {
		t.Fatal("control: the window session should already be refused while deactivated")
	}
	if err := svc.ReactivateUser(ctx, u.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.VerifyAccess(ctx, access); err == nil {
		t.Fatal("reactivation revived a session issued during the deactivation window")
	}
}

// Every sign-in path answers "account disabled" the same way: an MFA account
// must not get a second-factor challenge first (FR-17).
func TestDeactivatedMFAAccountIsRefusedBeforeChallenge_DB(t *testing.T) {
	tx := deactivateTestTx(t)
	ctx := context.Background()
	svc := NewService(tx, "test-jwt-secret")
	email := "mfa+" + uuid.NewString() + "@example.com"
	u, _, _, err := svc.Signup(ctx, email, "a-strong-password", "M")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE "users" SET "mfa_enabled" = true WHERE id = $1`, u.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := svc.Login(ctx, email, "a-strong-password", "d", "ip"); !errors.Is(err, ErrMFARequired) {
		t.Fatalf("control: an active MFA account should get a challenge, got %v", err)
	}
	if err := svc.DeactivateUser(ctx, u.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := svc.Login(ctx, email, "a-strong-password", "d", "ip"); !errors.Is(err, ErrAccountDisabled) {
		t.Fatalf("deactivated MFA account: got %v, want ErrAccountDisabled", err)
	}
}
