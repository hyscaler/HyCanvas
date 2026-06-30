// OIDC identity linking + session issuance (doc 15 SSO). A returning SSO subject
// signs in; a verified email matching an existing account links the OIDC identity
// to it; otherwise a new passwordless account + personal workspace is created.
//
// Security posture (see also the SSO review):
//   - SSO never downgrades an account's auth assurance: if the resolved account
//     has TOTP MFA enabled, SSO returns the SAME MFA challenge the password path
//     uses (issueSession is gated behind VerifyMfaLogin), so SSO cannot bypass MFA.
//   - SSO does not silently bind to a pre-existing password account on a mere
//     verified-email match (the account-takeover vector when the IdP is not
//     strictly authoritative for the email). Linking to a credentialed account is
//     allowed only when the operator vouches for the IdP via OIDC_ALLOWED_EMAIL_DOMAINS.
package accounts

import (
	"context"
	"os"
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
	ErrOidcNoEmail          = errOidc("the identity provider did not return an email")
	ErrOidcUnverified       = errOidc("the identity provider did not verify this email; cannot link to the existing account")
	ErrOidcNoAccount        = errOidc("account not found")
	ErrOidcLinkRefused      = errOidc("an account with this email already exists; sign in with your password, then connect SSO from settings")
	ErrOidcDomainNotAllowed = errOidc("this email domain is not permitted for SSO")
	ErrOidcSubjectTaken     = errOidc("this SSO identity is already linked to another account")
	ErrOidcLastFactor       = errOidc("set a password before disconnecting SSO so you are not locked out")
)

// LinkOidcIdentity connects an IdP identity to an already-authenticated user
// (the in-product "connect SSO" flow). Because the caller proved they own both
// the account (session) and the IdP login (code exchange), no email-trust check
// is needed. Idempotent for the same user; refuses to steal an identity already
// bound to a different account.
func (s *Service) LinkOidcIdentity(ctx context.Context, userID string, p OidcProfile) error {
	if p.Subject == "" {
		return ErrOidcNoAccount
	}
	// Atomically claim the subject: insert it, or on the (provider,providerSubject)
	// unique-index conflict leave the existing row's owner untouched. RETURNING
	// reflects the final row, so we report the true owner instead of trusting a
	// DO NOTHING that silently inserts 0 rows on a lost race (which would falsely
	// tell the user "connected"). owner == userID means linked-to-us (idempotent);
	// any other owner means the identity already belongs to a different account.
	var owner string
	err := s.db.QueryRow(ctx,
		`INSERT INTO "auth_identities" (id,"user_id",provider,"provider_subject") VALUES ($1,$2,'OIDC',$3)
		 ON CONFLICT (provider,"provider_subject") DO UPDATE SET "user_id" = "auth_identities"."user_id"
		 RETURNING "user_id"`,
		uuid.NewString(), userID, p.Subject).Scan(&owner)
	if err != nil {
		return err
	}
	if owner != userID {
		return ErrOidcSubjectTaken
	}
	return nil
}

// UnlinkOidcIdentity removes the caller's OIDC identity, refusing if it would
// leave them with no way to sign in (no password and no other factor).
func (s *Service) UnlinkOidcIdentity(ctx context.Context, userID string) error {
	u, err := s.findUserByID(ctx, userID)
	if err != nil || u == nil {
		return ErrOidcNoAccount
	}
	if u.PasswordHash == nil {
		return ErrOidcLastFactor
	}
	_, err = s.db.Exec(ctx, `DELETE FROM "auth_identities" WHERE "user_id"=$1 AND provider='OIDC'`, userID)
	return err
}

// HasOidcIdentity reports whether the user has a linked OIDC identity.
func (s *Service) HasOidcIdentity(ctx context.Context, userID string) (bool, error) {
	var n int
	err := s.db.QueryRow(ctx, `SELECT count(*) FROM "auth_identities" WHERE "user_id"=$1 AND provider='OIDC'`, userID).Scan(&n)
	return n > 0, err
}

type oidcError string

func (e oidcError) Error() string { return string(e) }
func errOidc(s string) error      { return oidcError(s) }

// emailDomainAllowed reports whether an email's domain may auto-link/provision
// via SSO. configured is true when OIDC_ALLOWED_EMAIL_DOMAINS is set; when unset,
// allowed is true and the caller applies its own (stricter) default for
// credentialed accounts.
func emailDomainAllowed(email string) (allowed, configured bool) {
	raw := strings.TrimSpace(os.Getenv("OIDC_ALLOWED_EMAIL_DOMAINS"))
	if raw == "" {
		return true, false
	}
	at := strings.LastIndex(email, "@")
	if at < 0 {
		return false, true
	}
	domain := strings.ToLower(email[at+1:])
	for _, d := range strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == ' ' || r == '\n' || r == '\t' }) {
		if strings.ToLower(strings.TrimSpace(d)) == domain {
			return true, true
		}
	}
	return false, true
}

// finishOidcLogin issues a session, or returns an MFA challenge (ErrMFARequired +
// token) when the account has TOTP enabled, so SSO enforces the second factor
// exactly like the password login path.
func (s *Service) finishOidcLogin(ctx context.Context, u *UserRow, device, ip string) (*AuthUser, *Tokens, string, error) {
	if u.MFAEnabled {
		tok, err := s.mfaChallengeToken(u.ID)
		if err != nil {
			return nil, nil, "", err
		}
		return nil, nil, tok, ErrMFARequired
	}
	v, tokens, err := s.issueSession(ctx, u, device, ip)
	if err != nil {
		return nil, nil, "", err
	}
	return v, tokens, "", nil
}

// LoginWithOidc links an OIDC profile to an account and issues a session (or an
// MFA challenge). Returns (user, tokens, mfaToken, err); on ErrMFARequired the
// caller drives the same VerifyMfaLogin step the password flow uses.
func (s *Service) LoginWithOidc(ctx context.Context, p OidcProfile, device, ip string) (*AuthUser, *Tokens, string, error) {
	// 1) Returning SSO user: an identity already exists for this subject.
	var existingUserID string
	err := s.db.QueryRow(ctx, `SELECT "user_id" FROM "auth_identities" WHERE provider = 'OIDC' AND "provider_subject" = $1`, p.Subject).Scan(&existingUserID)
	if err == nil && existingUserID != "" {
		u, err := s.findUserByID(ctx, existingUserID)
		if err != nil || u == nil {
			return nil, nil, "", ErrOidcNoAccount
		}
		return s.finishOidcLogin(ctx, u, device, ip)
	}

	email := strings.ToLower(strings.TrimSpace(p.Email))
	if email == "" {
		return nil, nil, "", ErrOidcNoEmail
	}
	allowed, domainConfigured := emailDomainAllowed(email)
	if domainConfigured && !allowed {
		return nil, nil, "", ErrOidcDomainNotAllowed
	}

	// 2) Existing account with the same verified email: link the SSO identity.
	if u, err := s.findUserByEmail(ctx, email); err == nil && u != nil {
		if !p.EmailVerified {
			return nil, nil, "", ErrOidcUnverified
		}
		// Refuse to silently bind SSO to a credentialed (password) account on a
		// bare email match: that is the account-takeover vector if the IdP is not
		// strictly authoritative for the email. Allow it only when the operator has
		// vouched for the IdP's authority over this domain via the allowlist. (MFA
		// accounts are additionally protected by the challenge in finishOidcLogin.)
		if u.PasswordHash != nil && !domainConfigured {
			return nil, nil, "", ErrOidcLinkRefused
		}
		if _, err := s.db.Exec(ctx,
			`INSERT INTO "auth_identities" (id,"user_id",provider,"provider_subject") VALUES ($1,$2,'OIDC',$3)
			 ON CONFLICT (provider,"provider_subject") DO NOTHING`,
			uuid.NewString(), u.ID, p.Subject); err != nil {
			return nil, nil, "", err
		}
		return s.finishOidcLogin(ctx, u, device, ip)
	}

	// 3) New account: user (no password) + OIDC identity + personal workspace.
	name := strings.TrimSpace(p.Name)
	if name == "" {
		name = strings.SplitN(email, "@", 2)[0]
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	userID := uuid.NewString()
	if _, err := tx.Exec(ctx,
		`INSERT INTO "users" (id, email, name, "email_verified", "updated_at") VALUES ($1,$2,$3,$4, now())`,
		userID, email, name, p.EmailVerified); err != nil {
		return nil, nil, "", err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO "auth_identities" (id,"user_id",provider,"provider_subject") VALUES ($1,$2,'OIDC',$3)`,
		uuid.NewString(), userID, p.Subject); err != nil {
		return nil, nil, "", err
	}
	wsID := uuid.NewString()
	if _, err := tx.Exec(ctx,
		`INSERT INTO "workspaces" (id, kind, name, slug, "owner_id", "updated_at") VALUES ($1,'PERSONAL',$2,$3,$4, now())`,
		wsID, name+" Workspace", slugify(name), userID); err != nil {
		return nil, nil, "", err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO "workspace_members" (id, "workspace_id", "user_id", role, status, "joined_at", "updated_at")
		 VALUES ($1,$2,$3,'OWNER','ACTIVE', now(), now())`,
		uuid.NewString(), wsID, userID); err != nil {
		return nil, nil, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, "", err
	}

	u, err := s.findUserByID(ctx, userID)
	if err != nil || u == nil {
		return nil, nil, "", ErrOidcNoAccount
	}
	return s.finishOidcLogin(ctx, u, device, ip)
}
