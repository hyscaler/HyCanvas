package accounts

import (
	"context"
	"errors"
)

// ErrAccountDisabled is returned by every sign-in path for a deactivated account.
var ErrAccountDisabled = errors.New("account disabled")

// DeactivateUser cuts a person off (F38 FR-13): it marks the account
// deactivated, revokes every session and API key it holds, and suspends its
// active memberships, all in one transaction. Access ends on the next request,
// because every access-token check and every API-key check reads the session or
// key it presents. Data is never deleted: memberships are SUSPENDED, not
// removed, and remember that deactivation suspended them so ReactivateUser can
// restore exactly those.
//
// Open realtime sockets are not this package's to close; the caller does that
// after commit (realtime.Hub.DisconnectUser). Idempotent.
func (s *Service) DeactivateUser(ctx context.Context, userID string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	ct, err := tx.Exec(ctx,
		`UPDATE "users" SET "deactivated_at" = COALESCE("deactivated_at", now()), "updated_at" = now() WHERE id = $1`, userID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	for _, q := range []string{
		`UPDATE "sessions" SET "revoked_at" = now() WHERE "user_id" = $1 AND "revoked_at" IS NULL`,
		`UPDATE "api_keys" SET "revoked_at" = now() WHERE "user_id" = $1 AND "revoked_at" IS NULL`,
		`UPDATE "workspace_members" SET status = 'SUSPENDED', "suspended_by_deactivation" = true, "updated_at" = now()
		 WHERE "user_id" = $1 AND status = 'ACTIVE'`,
	} {
		if _, err := tx.Exec(ctx, q, userID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// ReactivateUser undoes DeactivateUser's account state: the account can sign in
// again, and the memberships deactivation suspended are active again. A
// membership an admin removed in the meantime stays removed, and a membership
// suspended for any other reason stays suspended. Revoked sessions and API keys
// stay revoked; the person signs in afresh.
func (s *Service) ReactivateUser(ctx context.Context, userID string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	ct, err := tx.Exec(ctx,
		`UPDATE "users" SET "deactivated_at" = NULL, "updated_at" = now() WHERE id = $1`, userID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	if _, err := tx.Exec(ctx,
		`UPDATE "workspace_members" SET status = 'ACTIVE', "suspended_by_deactivation" = false, "updated_at" = now()
		 WHERE "user_id" = $1 AND "suspended_by_deactivation"`, userID); err != nil {
		return err
	}
	// Deactivation revoked every session and key, so any still unrevoked was
	// created inside the deactivation window (a sign-in racing it). Those were
	// refused while the account was off; reactivating must not revive them.
	for _, q := range []string{
		`UPDATE "sessions" SET "revoked_at" = now() WHERE "user_id" = $1 AND "revoked_at" IS NULL`,
		`UPDATE "api_keys" SET "revoked_at" = now() WHERE "user_id" = $1 AND "revoked_at" IS NULL`,
	} {
		if _, err := tx.Exec(ctx, q, userID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// isDeactivated reports whether the account is deactivated. A lookup failure
// reads as deactivated: a sign-in path must fail closed.
func (s *Service) isDeactivated(ctx context.Context, userID string) bool {
	var off bool
	if err := s.db.QueryRow(ctx, `SELECT "deactivated_at" IS NOT NULL FROM "users" WHERE id = $1`, userID).Scan(&off); err != nil {
		return true
	}
	return off
}
