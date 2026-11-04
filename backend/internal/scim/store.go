package scim

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// userRec is a live SCIM user link joined to its account.
type userRec struct {
	ID          string
	UserID      string
	UserName    string
	ExternalID  *string
	Attrs       map[string]any
	Email       string
	Name        string
	Deactivated bool
	Created     time.Time
	Updated     time.Time
}

const userSelect = `SELECT su.id, su."user_id", su."user_name", su."external_id", su.attributes, u.email, u.name,
	u."deactivated_at" IS NOT NULL, su."created_at", su."updated_at"
	FROM "scim_users" su JOIN "users" u ON u.id = su."user_id"`

func scanUserRec(row pgx.Row) (*userRec, error) {
	var u userRec
	var raw []byte
	if err := row.Scan(&u.ID, &u.UserID, &u.UserName, &u.ExternalID, &raw, &u.Email, &u.Name, &u.Deactivated, &u.Created, &u.Updated); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(raw, &u.Attrs)
	if u.Attrs == nil {
		u.Attrs = map[string]any{}
	}
	return &u, nil
}

// getUserRec loads a live link by SCIM id; errNotFound for unknown, deleted, or
// malformed ids.
func getUserRec(ctx context.Context, tx pgx.Tx, id string) (*userRec, error) {
	if _, err := uuid.Parse(id); err != nil {
		return nil, errNotFound
	}
	u, err := scanUserRec(tx.QueryRow(ctx, userSelect+` WHERE su.id = $1 AND su."deleted_at" IS NULL`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	return u, err
}

// userFilterSQL maps a parsed filter attribute to its WHERE clause.
var userFilterSQL = map[string]string{
	"userName":     `lower(su."user_name") = lower($1)`,
	"externalId":   `su."external_id" = $1`,
	"emails.value": `u.email = lower($1)`,
}

func listUserRecs(ctx context.Context, tx pgx.Tx, attr, value string, start, count int) ([]*userRec, int, error) {
	where, args := `su."deleted_at" IS NULL`, []any{}
	if attr != "" {
		where += " AND " + userFilterSQL[attr]
		args = append(args, value)
	}
	var total int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM "scim_users" su JOIN "users" u ON u.id = su."user_id" WHERE `+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	n := len(args)
	rows, err := tx.Query(ctx, userSelect+` WHERE `+where+` ORDER BY su."created_at", su.id OFFSET $`+strconv.Itoa(n+1)+` LIMIT $`+strconv.Itoa(n+2),
		append(args, start-1, count)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []*userRec
	for rows.Next() {
		u, err := scanUserRec(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, u)
	}
	return out, total, rows.Err()
}

// liveLinkConflict reports whether another live link already uses this userName
// or externalId (excluding the link with id except).
func liveLinkConflict(ctx context.Context, tx pgx.Tx, userName string, externalID *string, except string) (bool, error) {
	var n int
	err := tx.QueryRow(ctx, `SELECT count(*) FROM "scim_users" WHERE "deleted_at" IS NULL AND id::text <> $3
		AND (lower("user_name") = lower($1) OR ($2::text IS NOT NULL AND "external_id" = $2))`,
		userName, externalID, except).Scan(&n)
	return n > 0, err
}

// liveLinkForAccount returns the live link of an account, if any.
func liveLinkForAccount(ctx context.Context, tx pgx.Tx, userID string) (string, error) {
	var id string
	err := tx.QueryRow(ctx, `SELECT id FROM "scim_users" WHERE "user_id" = $1 AND "deleted_at" IS NULL`, userID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return id, err
}

// deletedLinkByExternalID finds a link a SCIM DELETE detached, so re-creating
// the same person relinks their account instead of making a second one.
func deletedLinkByExternalID(ctx context.Context, tx pgx.Tx, externalID string) (id, userID string, err error) {
	err = tx.QueryRow(ctx, `SELECT id, "user_id" FROM "scim_users" WHERE "external_id" = $1 AND "deleted_at" IS NOT NULL
		ORDER BY "deleted_at" DESC LIMIT 1`, externalID).Scan(&id, &userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", nil
	}
	return id, userID, err
}

// upsertLink links an account to the provider, reviving the account's detached
// link if it has one (an account has at most one link row, live or detached).
// The caller has already refused a conflicting live link.
func upsertLink(ctx context.Context, tx pgx.Tx, userID, userName string, externalID *string, attrs map[string]any) (string, error) {
	raw, _ := json.Marshal(attrs)
	var id string
	err := tx.QueryRow(ctx, `INSERT INTO "scim_users" (id, "user_id", "external_id", "user_name", attributes)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT ("user_id") DO UPDATE SET "external_id" = EXCLUDED."external_id", "user_name" = EXCLUDED."user_name",
			attributes = EXCLUDED.attributes, "deleted_at" = NULL, "updated_at" = now()
		RETURNING id`, uuid.NewString(), userID, externalID, userName, raw).Scan(&id)
	return id, err
}

// updateLink replaces a live link's provider-facing attributes.
func updateLink(ctx context.Context, tx pgx.Tx, id, userName string, externalID *string, attrs map[string]any) error {
	raw, _ := json.Marshal(attrs)
	_, err := tx.Exec(ctx, `UPDATE "scim_users" SET "user_name" = $2, "external_id" = $3, attributes = $4, "updated_at" = now() WHERE id = $1`,
		id, userName, externalID, raw)
	return err
}
