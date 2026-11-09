package accounts

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ErrSubjectTaken: the SSO subject is already linked to a different account.
var ErrSubjectTaken = errors.New("this sign-in identity is already linked to another account")

// CreateProvisionedUser creates an account an identity provider asked for (SCIM,
// F38 FR-13): passwordless, its email verified (the provider asserted it), with
// the personal workspace every account gets. When oidcSubject is set it also
// records the person's SSO identity, so their first SSO login lands on this
// account by subject rather than by email.
func (s *Service) CreateProvisionedUser(ctx context.Context, email, name, oidcSubject string) (string, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if !emailRe.MatchString(email) {
		return "", ErrBadRequest
	}
	if u, err := s.findUserByEmail(ctx, email); err == nil && u != nil {
		return "", ErrEmailTaken
	} else if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	if oidcSubject != "" {
		owner, err := s.oidcSubjectOwner(ctx, oidcSubject)
		if err != nil {
			return "", err
		}
		if owner != "" {
			return "", ErrSubjectTaken
		}
	}
	return s.createUserWithWorkspace(ctx, email, name, true, func(tx pgx.Tx, userID string) error {
		if oidcSubject == "" {
			return nil
		}
		_, err := tx.Exec(ctx,
			`INSERT INTO "auth_identities" (id, "user_id", provider, "provider_subject") VALUES ($1, $2, 'OIDC', $3)`,
			uuid.NewString(), userID, oidcSubject)
		return err
	})
}

// AdoptForProvisioning links an identity provider to an account that already
// exists with this email (typically someone who signed up through SSO before
// provisioning was configured), under the same rules SSO linking uses
// (LoginWithOidc): the account already carries this SSO subject, or the
// operator vouched for the email's domain with OIDC_ALLOWED_EMAIL_DOMAINS (then
// the subject is linked too). Email alone never adopts: that would let whoever
// controls the provider take over any account by naming its email.
//
// Returns ErrNotFound when no account has the email, ErrEmailTaken when one does
// but may not be adopted, and ErrSubjectTaken when the subject belongs to a
// different account.
func (s *Service) AdoptForProvisioning(ctx context.Context, email, oidcSubject string) (string, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	u, err := s.findUserByEmail(ctx, email)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && u == nil) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	// Adoption never revives a disabled account, even if a subject was linked
	// by an earlier failed login. Detached SCIM relinks are checked separately.
	if err := s.checkActive(ctx, u.ID); err != nil {
		if errors.Is(err, ErrAccountDisabled) {
			return "", ErrEmailTaken
		}
		return "", err
	}
	if oidcSubject != "" {
		owner, err := s.oidcSubjectOwner(ctx, oidcSubject)
		if err != nil {
			return "", err
		}
		if owner == u.ID {
			return u.ID, nil
		}
		if owner != "" {
			return "", ErrSubjectTaken
		}
	}
	if allowed, configured := emailDomainAllowed(email); configured && allowed {
		if oidcSubject != "" {
			if _, err := s.db.Exec(ctx,
				`INSERT INTO "auth_identities" (id, "user_id", provider, "provider_subject") VALUES ($1, $2, 'OIDC', $3)
				 ON CONFLICT (provider, "provider_subject") DO NOTHING`,
				uuid.NewString(), u.ID, oidcSubject); err != nil {
				return "", err
			}
		}
		return u.ID, nil
	}
	return "", ErrEmailTaken
}

// UpdateProvisionedUser applies an identity provider's change of email or name.
// An email another account already uses is ErrEmailTaken and changes nothing.
func (s *Service) UpdateProvisionedUser(ctx context.Context, userID, email, name string) error {
	email = strings.ToLower(strings.TrimSpace(email))
	name = strings.TrimSpace(name)
	if !emailRe.MatchString(email) {
		return ErrBadRequest
	}
	if u, err := s.findUserByEmail(ctx, email); err == nil && u != nil && u.ID != userID {
		return ErrEmailTaken
	} else if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if name == "" {
		name = strings.SplitN(email, "@", 2)[0]
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	ct, err := tx.Exec(ctx, `UPDATE "users" SET email = $2, name = $3, "updated_at" = now() WHERE id = $1`, userID, email, name)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	if _, err := tx.Exec(ctx, `UPDATE "auth_identities" SET "provider_subject" = $2 WHERE "user_id" = $1 AND provider = 'PASSWORD'`, userID, email); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// oidcSubjectOwner returns the id of the account an SSO subject is linked to,
// or "" when it is linked to none.
func (s *Service) oidcSubjectOwner(ctx context.Context, subject string) (string, error) {
	var userID string
	err := s.db.QueryRow(ctx,
		`SELECT "user_id" FROM "auth_identities" WHERE provider = 'OIDC' AND "provider_subject" = $1`, subject).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return userID, err
}
