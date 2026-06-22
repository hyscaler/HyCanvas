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
	u1, tokens1, err := svc.LoginWithOidc(ctx, OidcProfile{Subject: sub, Email: email, EmailVerified: true, Name: "SSO User"}, "d", "ip")
	if err != nil || u1 == nil || tokens1.Access == "" {
		t.Fatalf("new-account OIDC login: %v", err)
	}
	// The user has a personal workspace (owner membership).
	var wsCount int
	_ = tx.QueryRow(ctx, `SELECT count(*) FROM "WorkspaceMember" WHERE "userId" = $1 AND role = 'OWNER'`, u1.ID).Scan(&wsCount)
	if wsCount != 1 {
		t.Fatalf("expected one owner membership, got %d", wsCount)
	}

	// 2) Returning subject: same identity -> same user, no duplicate.
	u2, _, err := svc.LoginWithOidc(ctx, OidcProfile{Subject: sub, Email: email, EmailVerified: true}, "d", "ip")
	if err != nil || u2.ID != u1.ID {
		t.Fatalf("returning OIDC login should reuse the user: %v", err)
	}
	var idCount int
	_ = tx.QueryRow(ctx, `SELECT count(*) FROM "AuthIdentity" WHERE provider='OIDC' AND "providerSubject"=$1`, sub).Scan(&idCount)
	if idCount != 1 {
		t.Fatalf("expected one OIDC identity, got %d", idCount)
	}

	// 3) Link to an existing password account by verified email.
	pwEmail := "pw+" + uuid.NewString() + "@example.com"
	pwUser, _, _, err := svc.Signup(ctx, pwEmail, "a-strong-password", "PW User")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	linked, _, err := svc.LoginWithOidc(ctx, OidcProfile{Subject: "sub-link-" + uuid.NewString(), Email: pwEmail, EmailVerified: true}, "d", "ip")
	if err != nil || linked.ID != pwUser.ID {
		t.Fatalf("verified email should link to existing account: %v", err)
	}
	// 4) Unverified email to an existing account is refused.
	if _, _, err := svc.LoginWithOidc(ctx, OidcProfile{Subject: "sub-x-" + uuid.NewString(), Email: pwEmail, EmailVerified: false}, "d", "ip"); err != ErrOidcUnverified {
		t.Fatalf("unverified link should be refused, got %v", err)
	}
	// 5) No email at all is refused.
	if _, _, err := svc.LoginWithOidc(ctx, OidcProfile{Subject: "sub-y-" + uuid.NewString(), Email: ""}, "d", "ip"); err != ErrOidcNoEmail {
		t.Fatalf("missing email should be refused, got %v", err)
	}
}
