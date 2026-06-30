package accounts

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestLoginWithOidc_DB(t *testing.T) {
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
	sub := "oidc-sub-" + uuid.NewString()
	email := "sso+" + uuid.NewString() + "@example.com"

	// 1) New account: creates the user + workspace + identity, issues a session.
	u1, tokens1, mfa1, err := svc.LoginWithOidc(ctx, OidcProfile{Subject: sub, Email: email, EmailVerified: true, Name: "SSO User"}, "d", "ip")
	if err != nil || u1 == nil || tokens1 == nil || tokens1.Access == "" || mfa1 != "" {
		t.Fatalf("new-account OIDC login: %v", err)
	}
	var wsCount int
	_ = tx.QueryRow(ctx, `SELECT count(*) FROM "workspace_members" WHERE "user_id" = $1 AND role = 'OWNER'`, u1.ID).Scan(&wsCount)
	if wsCount != 1 {
		t.Fatalf("expected one owner membership, got %d", wsCount)
	}

	// 2) Returning subject: same identity -> same user, no duplicate.
	u2, _, _, err := svc.LoginWithOidc(ctx, OidcProfile{Subject: sub, Email: email, EmailVerified: true}, "d", "ip")
	if err != nil || u2 == nil || u2.ID != u1.ID {
		t.Fatalf("returning OIDC login should reuse the user: %v", err)
	}
	var idCount int
	_ = tx.QueryRow(ctx, `SELECT count(*) FROM "auth_identities" WHERE provider='OIDC' AND "provider_subject"=$1`, sub).Scan(&idCount)
	if idCount != 1 {
		t.Fatalf("expected one OIDC identity, got %d", idCount)
	}

	// 3) Silent linking of SSO to a PASSWORD account is refused without a domain
	// allowlist (the takeover guard).
	pwEmail := "pw+" + uuid.NewString() + "@example.com"
	pwUser, _, _, err := svc.Signup(ctx, pwEmail, "a-strong-password", "PW User")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	if _, _, _, err := svc.LoginWithOidc(ctx, OidcProfile{Subject: "sub-link-" + uuid.NewString(), Email: pwEmail, EmailVerified: true}, "d", "ip"); err != ErrOidcLinkRefused {
		t.Fatalf("linking SSO to a password account without an allowlist should be refused, got %v", err)
	}

	// 3b) With the domain allowlisted, linking to the password account succeeds.
	t.Setenv("OIDC_ALLOWED_EMAIL_DOMAINS", "example.com")
	linkSub := "sub-link2-" + uuid.NewString()
	linked, ltokens, _, err := svc.LoginWithOidc(ctx, OidcProfile{Subject: linkSub, Email: pwEmail, EmailVerified: true}, "d", "ip")
	if err != nil || linked == nil || linked.ID != pwUser.ID || ltokens == nil {
		t.Fatalf("allowlisted verified email should link to the existing account: %v", err)
	}

	// 4) Unverified email to an existing account is refused.
	if _, _, _, err := svc.LoginWithOidc(ctx, OidcProfile{Subject: "sub-x-" + uuid.NewString(), Email: pwEmail, EmailVerified: false}, "d", "ip"); err != ErrOidcUnverified {
		t.Fatalf("unverified link should be refused, got %v", err)
	}

	// 5) No email at all is refused.
	if _, _, _, err := svc.LoginWithOidc(ctx, OidcProfile{Subject: "sub-y-" + uuid.NewString(), Email: ""}, "d", "ip"); err != ErrOidcNoEmail {
		t.Fatalf("missing email should be refused, got %v", err)
	}

	// 6) A domain outside the allowlist is refused.
	if _, _, _, err := svc.LoginWithOidc(ctx, OidcProfile{Subject: "sub-z-" + uuid.NewString(), Email: "outsider@other.com", EmailVerified: true}, "d", "ip"); err != ErrOidcDomainNotAllowed {
		t.Fatalf("non-allowlisted domain should be refused, got %v", err)
	}

	// 7) SSO into an MFA-enabled account returns an MFA challenge, not a session
	// (the MFA-bypass guard). pwUser is now linked to linkSub from 3b.
	if _, err := tx.Exec(ctx, `UPDATE "users" SET "mfa_enabled" = true WHERE id = $1`, pwUser.ID); err != nil {
		t.Fatalf("enable mfa: %v", err)
	}
	mfaUser, mfaTokens, mfaTok, err := svc.LoginWithOidc(ctx, OidcProfile{Subject: linkSub, Email: pwEmail, EmailVerified: true}, "d", "ip")
	if err != ErrMFARequired || mfaTok == "" || mfaTokens != nil || mfaUser != nil {
		t.Fatalf("SSO into an MFA account must return an MFA challenge, got user=%v tokens=%v tok=%q err=%v", mfaUser, mfaTokens, mfaTok, err)
	}
}

func TestLinkUnlinkOidc_DB(t *testing.T) {
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
	pwUser, _, _, err := svc.Signup(ctx, "lk+"+uuid.NewString()+"@example.com", "a-strong-password", "PW User")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}

	// Initially no SSO identity.
	if has, _ := svc.HasOidcIdentity(ctx, pwUser.ID); has {
		t.Fatal("user should start without an SSO identity")
	}
	// User-initiated link needs no email trust; idempotent for the same subject.
	subA := "linksub-a-" + uuid.NewString()
	if err := svc.LinkOidcIdentity(ctx, pwUser.ID, OidcProfile{Subject: subA}); err != nil {
		t.Fatalf("LinkOidcIdentity: %v", err)
	}
	if err := svc.LinkOidcIdentity(ctx, pwUser.ID, OidcProfile{Subject: subA}); err != nil {
		t.Fatalf("re-linking the same subject should be idempotent: %v", err)
	}
	if has, _ := svc.HasOidcIdentity(ctx, pwUser.ID); !has {
		t.Fatal("user should have an SSO identity after linking")
	}

	// A subject already owned by another account cannot be stolen.
	other, _, _, err := svc.LoginWithOidc(ctx, OidcProfile{Subject: "linksub-b-" + uuid.NewString(), Email: "other+" + uuid.NewString() + "@example.com", EmailVerified: true}, "d", "ip")
	if err != nil {
		t.Fatalf("create SSO-native other user: %v", err)
	}
	var otherSub string
	_ = tx.QueryRow(ctx, `SELECT "provider_subject" FROM "auth_identities" WHERE "user_id"=$1 AND provider='OIDC'`, other.ID).Scan(&otherSub)
	if err := svc.LinkOidcIdentity(ctx, pwUser.ID, OidcProfile{Subject: otherSub}); err != ErrOidcSubjectTaken {
		t.Fatalf("linking a subject owned by another account should be refused, got %v", err)
	}

	// Disconnect: allowed for a password account, refused for an SSO-only one.
	if err := svc.UnlinkOidcIdentity(ctx, pwUser.ID); err != nil {
		t.Fatalf("UnlinkOidcIdentity (has password): %v", err)
	}
	if has, _ := svc.HasOidcIdentity(ctx, pwUser.ID); has {
		t.Fatal("identity should be gone after unlink")
	}
	if err := svc.UnlinkOidcIdentity(ctx, other.ID); err != ErrOidcLastFactor {
		t.Fatalf("unlinking the only login method should be refused, got %v", err)
	}
}
