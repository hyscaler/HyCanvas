package accounts

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
)

// An account the identity provider creates must be the one its person lands on
// at their first SSO login, by subject. The profile here says email_verified
// false, as Authentik's default mapping does: landing must not depend on email.
func TestCreateProvisionedUser_DB(t *testing.T) {
	tx := deactivateTestTx(t)
	ctx := context.Background()
	svc := NewService(tx, "test-jwt-secret")
	email := "prov+" + uuid.NewString() + "@example.com"
	sub := "sub-" + uuid.NewString()

	id, err := svc.CreateProvisionedUser(ctx, email, "Pro Visioned", sub)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	var verified, hasPassword bool
	if err := tx.QueryRow(ctx, `SELECT "email_verified", "password_hash" IS NOT NULL FROM "users" WHERE id = $1`, id).Scan(&verified, &hasPassword); err != nil {
		t.Fatal(err)
	}
	if !verified || hasPassword {
		t.Fatalf("provisioned user: email_verified=%v has_password=%v, want true/false", verified, hasPassword)
	}
	var owners int
	_ = tx.QueryRow(ctx, `SELECT count(*) FROM "workspace_members" WHERE "user_id" = $1 AND role = 'OWNER'`, id).Scan(&owners)
	if owners != 1 {
		t.Fatalf("expected the personal workspace, got %d owner memberships", owners)
	}

	u, _, _, err := svc.LoginWithOidc(ctx, OidcProfile{Subject: sub, Email: email, EmailVerified: false, Name: "x"}, "d", "ip", true, false)
	if err != nil {
		t.Fatalf("first SSO login: %v", err)
	}
	if u.ID != id {
		t.Fatalf("first SSO login landed on %s, want the provisioned %s", u.ID, id)
	}

	if _, err := svc.CreateProvisionedUser(ctx, email, "Dup", "sub-"+uuid.NewString()); !errors.Is(err, ErrEmailTaken) {
		t.Fatalf("duplicate email: got %v, want ErrEmailTaken", err)
	}
	if _, err := svc.CreateProvisionedUser(ctx, "other+"+uuid.NewString()+"@example.com", "Dup", sub); !errors.Is(err, ErrSubjectTaken) {
		t.Fatalf("subject linked elsewhere: got %v, want ErrSubjectTaken", err)
	}
}

// Adopting an account that already exists follows the SSO linking rules: the
// same subject, or a domain the operator vouched for. Never email alone.
func TestAdoptForProvisioning_DB(t *testing.T) {
	tx := deactivateTestTx(t)
	ctx := context.Background()
	svc := NewService(tx, "test-jwt-secret")
	t.Setenv("OIDC_ALLOWED_EMAIL_DOMAINS", "")

	// Signed up through SSO before provisioning existed: same subject adopts.
	sub := "sub-" + uuid.NewString()
	ssoEmail := "jit+" + uuid.NewString() + "@example.com"
	jit, _, _, err := svc.LoginWithOidc(ctx, OidcProfile{Subject: sub, Email: ssoEmail, EmailVerified: true, Name: "JIT"}, "d", "ip", true, true)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := svc.AdoptForProvisioning(ctx, ssoEmail, sub); err != nil || got != jit.ID {
		t.Fatalf("same subject: got %q, %v; want %q", got, err, jit.ID)
	}

	// A password account with a different (or no) SSO identity: refused...
	pwEmail := "pw+" + uuid.NewString() + "@example.com"
	pw, _, _, err := svc.Signup(ctx, pwEmail, "a-strong-password", "PW")
	if err != nil {
		t.Fatal(err)
	}
	other := "sub-" + uuid.NewString()
	if _, err := svc.AdoptForProvisioning(ctx, pwEmail, other); !errors.Is(err, ErrEmailTaken) {
		t.Fatalf("unvouched adoption: got %v, want ErrEmailTaken", err)
	}
	// ...unless the operator vouches for the domain, which also links the subject.
	t.Setenv("OIDC_ALLOWED_EMAIL_DOMAINS", "example.com")
	if got, err := svc.AdoptForProvisioning(ctx, pwEmail, other); err != nil || got != pw.ID {
		t.Fatalf("vouched adoption: got %q, %v; want %q", got, err, pw.ID)
	}
	var linked int
	_ = tx.QueryRow(ctx, `SELECT count(*) FROM "auth_identities" WHERE provider = 'OIDC' AND "provider_subject" = $1 AND "user_id" = $2`, other, pw.ID).Scan(&linked)
	if linked != 1 {
		t.Fatalf("vouched adoption did not link the subject")
	}

	if _, err := svc.AdoptForProvisioning(ctx, "nobody+"+uuid.NewString()+"@example.com", "s"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown email: got %v, want ErrNotFound", err)
	}
}

func TestUpdateProvisionedUser_DB(t *testing.T) {
	tx := deactivateTestTx(t)
	ctx := context.Background()
	svc := NewService(tx, "test-jwt-secret")
	a, err := svc.CreateProvisionedUser(ctx, "upd-a+"+uuid.NewString()+"@example.com", "A", "")
	if err != nil {
		t.Fatal(err)
	}
	takenEmail := "upd-b+" + uuid.NewString() + "@example.com"
	if _, err := svc.CreateProvisionedUser(ctx, takenEmail, "B", ""); err != nil {
		t.Fatal(err)
	}
	newEmail := "upd-a2+" + uuid.NewString() + "@example.com"
	if err := svc.UpdateProvisionedUser(ctx, a, newEmail, "A Renamed"); err != nil {
		t.Fatalf("update: %v", err)
	}
	var email, name string
	_ = tx.QueryRow(ctx, `SELECT email, name FROM "users" WHERE id = $1`, a).Scan(&email, &name)
	if email != newEmail || name != "A Renamed" {
		t.Fatalf("after update: %q %q", email, name)
	}
	if err := svc.UpdateProvisionedUser(ctx, a, takenEmail, "A"); !errors.Is(err, ErrEmailTaken) {
		t.Fatalf("email collision: got %v, want ErrEmailTaken", err)
	}
}
