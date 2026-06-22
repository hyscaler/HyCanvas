// OIDC identity linking + session issuance (doc 15 SSO). Mirrors the NestJS
// loginWithOidc: a returning SSO subject signs straight in; a verified email
// matching an existing account links the OIDC identity to it; otherwise a new
// account (no password) + personal workspace is created. The IdP redirect/token/
// userinfo dance lives in internal/oidc; this is the persistence + session side.
package accounts

import (
	"context"
	"strings"

	"github.com/google/uuid"
)

// OidcProfile is the resolved identity from the IdP userinfo endpoint.
type OidcProfile struct {
	Subject       string
	Email         string
	EmailVerified bool
	Name          string
}

// ErrOidc covers SSO link failures (mapped to 400/401 / a login redirect).
var (
	ErrOidcNoEmail    = errOidc("the identity provider did not return an email")
	ErrOidcUnverified = errOidc("the identity provider did not verify this email; cannot link to the existing account")
	ErrOidcNoAccount  = errOidc("account not found")
)

type oidcError string

func (e oidcError) Error() string { return string(e) }
func errOidc(s string) error      { return oidcError(s) }

// LoginWithOidc links an OIDC profile to an account and issues a session.
func (s *Service) LoginWithOidc(ctx context.Context, p OidcProfile, device, ip string) (*AuthUser, *Tokens, error) {
	// 1) Returning SSO user: an identity already exists for this subject.
	var existingUserID string
	err := s.db.QueryRow(ctx, `SELECT "userId" FROM "AuthIdentity" WHERE provider = 'OIDC' AND "providerSubject" = $1`, p.Subject).Scan(&existingUserID)
	if err == nil && existingUserID != "" {
		u, err := s.findUserByID(ctx, existingUserID)
		if err != nil || u == nil {
			return nil, nil, ErrOidcNoAccount
		}
		return s.issueSession(ctx, u, device, ip)
	}

	email := strings.ToLower(strings.TrimSpace(p.Email))
	if email == "" {
		return nil, nil, ErrOidcNoEmail
	}

	// 2) Existing account with the same (verified) email: link the SSO identity.
	if u, err := s.findUserByEmail(ctx, email); err == nil && u != nil {
		if !p.EmailVerified {
			return nil, nil, ErrOidcUnverified
		}
		if _, err := s.db.Exec(ctx,
			`INSERT INTO "AuthIdentity" (id,"userId",provider,"providerSubject") VALUES ($1,$2,'OIDC',$3)
			 ON CONFLICT (provider,"providerSubject") DO NOTHING`,
			uuid.NewString(), u.ID, p.Subject); err != nil {
			return nil, nil, err
		}
		return s.issueSession(ctx, u, device, ip)
	}

	// 3) New account: user (no password) + OIDC identity + personal workspace.
	name := strings.TrimSpace(p.Name)
	if name == "" {
		name = strings.SplitN(email, "@", 2)[0]
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	userID := uuid.NewString()
	if _, err := tx.Exec(ctx,
		`INSERT INTO "User" (id, email, name, "emailVerified", "updatedAt") VALUES ($1,$2,$3,$4, now())`,
		userID, email, name, p.EmailVerified); err != nil {
		return nil, nil, err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO "AuthIdentity" (id,"userId",provider,"providerSubject") VALUES ($1,$2,'OIDC',$3)`,
		uuid.NewString(), userID, p.Subject); err != nil {
		return nil, nil, err
	}
	wsID := uuid.NewString()
	if _, err := tx.Exec(ctx,
		`INSERT INTO "Workspace" (id, kind, name, slug, "ownerId", "updatedAt") VALUES ($1,'PERSONAL',$2,$3,$4, now())`,
		wsID, name+" Workspace", slugify(name), userID); err != nil {
		return nil, nil, err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO "WorkspaceMember" (id, "workspaceId", "userId", role, status, "joinedAt", "updatedAt")
		 VALUES ($1,$2,$3,'OWNER','ACTIVE', now(), now())`,
		uuid.NewString(), wsID, userID); err != nil {
		return nil, nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, err
	}

	u, err := s.findUserByID(ctx, userID)
	if err != nil || u == nil {
		return nil, nil, ErrOidcNoAccount
	}
	return s.issueSession(ctx, u, device, ip)
}
