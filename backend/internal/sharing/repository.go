// SQL access for the sharing module, against the tables
// "design_grants", "share_links", and "custom_roles" (quoted identifiers, snake_case
// columns). Mode/capability strings are stored as-is (lowercase). Capabilities
// is a Postgres text[] column.
package sharing

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/authz"
)

// --- grants --------------------------------------------------------------

func scanGrant(row pgx.Row) (GrantRow, error) {
	var g GrantRow
	var mode string
	err := row.Scan(&g.ID, &g.DesignID, &g.UserID, &g.Email, &mode, &g.RoleID, &g.InvitedBy, &g.CreatedAt)
	g.Mode = authz.AccessMode(mode)
	return g, err
}

const grantCols = `id, "design_id", "user_id", email, mode, "role_id", "invited_by", "created_at"`

func (s *Service) createGrant(ctx context.Context, in GrantRow) (GrantRow, error) {
	// A grant carries exactly one of userId/email; target the matching unique
	// index so a concurrent insert for the same principal updates in place rather
	// than failing the constraint (a raw 500). roleId is preserved on conflict
	// unless a new one is supplied, so a racing link/auto grant cannot wipe it.
	conflict := `("design_id","user_id")`
	if in.UserID == nil {
		conflict = `("design_id",email)`
	}
	q := `INSERT INTO "design_grants" (id,"design_id","user_id",email,mode,"role_id","invited_by")
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		ON CONFLICT ` + conflict + ` DO UPDATE
		SET mode = EXCLUDED.mode, "role_id" = COALESCE(EXCLUDED."role_id", "design_grants"."role_id")
		RETURNING ` + grantCols
	return scanGrant(s.db.QueryRow(ctx, q, uuid.NewString(), in.DesignID, in.UserID, in.Email, string(in.Mode), in.RoleID, in.InvitedBy))
}

func (s *Service) getGrant(ctx context.Context, id string) (GrantRow, error) {
	g, err := scanGrant(s.db.QueryRow(ctx, `SELECT `+grantCols+` FROM "design_grants" WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return GrantRow{}, ErrNotFound
	}
	return g, err
}

func (s *Service) listGrantsForDesign(ctx context.Context, designID string) ([]GrantRow, error) {
	rows, err := s.db.Query(ctx, `SELECT `+grantCols+` FROM "design_grants" WHERE "design_id" = $1 ORDER BY "created_at"`, designID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collectGrants(rows)
}

// listGrantsForUser returns grants that apply to a caller for a design: by user
// id or any of their verified emails (FR-7).
func (s *Service) listGrantsForUser(ctx context.Context, designID, userID string, emails []string) ([]GrantRow, error) {
	rows, err := s.db.Query(ctx,
		`SELECT `+grantCols+` FROM "design_grants"
		 WHERE "design_id" = $1 AND ("user_id" = $2 OR email = ANY($3))`,
		designID, userID, emails)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collectGrants(rows)
}

func collectGrants(rows pgx.Rows) ([]GrantRow, error) {
	var out []GrantRow
	for rows.Next() {
		g, err := scanGrant(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

func (s *Service) updateGrant(ctx context.Context, id string, mode *authz.AccessMode, roleID *string, roleSet bool) (GrantRow, error) {
	var modeStr *string
	if mode != nil {
		v := string(*mode)
		modeStr = &v
	}
	// COALESCE keeps the column when the patch field is nil; roleSet lets a
	// caller explicitly clear roleId to NULL.
	const q = `UPDATE "design_grants"
		SET mode = COALESCE($2, mode),
		    "role_id" = CASE WHEN $4 THEN $3 ELSE "role_id" END
		WHERE id = $1 RETURNING ` + grantCols
	g, err := scanGrant(s.db.QueryRow(ctx, q, id, modeStr, roleID, roleSet))
	if errors.Is(err, pgx.ErrNoRows) {
		return GrantRow{}, ErrNotFound
	}
	return g, err
}

func (s *Service) deleteGrant(ctx context.Context, id string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM "design_grants" WHERE id = $1`, id)
	return err
}

// findGrantForPrincipal locates an existing grant on a design for the given
// principal (by user id or email), used to make re-inviting update access in
// place rather than fail the unique constraint. Returns ErrNotFound if absent.
func (s *Service) findGrantForPrincipal(ctx context.Context, designID string, uid, email *string) (GrantRow, error) {
	var row pgx.Row
	switch {
	case uid != nil:
		row = s.db.QueryRow(ctx, `SELECT `+grantCols+` FROM "design_grants" WHERE "design_id" = $1 AND "user_id" = $2`, designID, *uid)
	case email != nil:
		row = s.db.QueryRow(ctx, `SELECT `+grantCols+` FROM "design_grants" WHERE "design_id" = $1 AND email = $2`, designID, *email)
	default:
		return GrantRow{}, ErrNotFound
	}
	g, err := scanGrant(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return GrantRow{}, ErrNotFound
	}
	return g, err
}

// --- links ---------------------------------------------------------------

func scanLink(row pgx.Row) (LinkRow, error) {
	var l LinkRow
	var mode string
	err := row.Scan(&l.ID, &l.DesignID, &l.Token, &mode, &l.PasswordHash, &l.ExpiresAt, &l.Disabled, &l.RequireSignin, &l.CreatedByID, &l.CreatedAt)
	l.Mode = authz.AccessMode(mode)
	return l, err
}

const linkCols = `id, "design_id", token, mode, "password_hash", "expires_at", disabled, "require_signin", "created_by_id", "created_at"`

func (s *Service) createLink(ctx context.Context, in LinkRow) (LinkRow, error) {
	const q = `INSERT INTO "share_links" (id,"design_id",token,mode,"password_hash","expires_at","require_signin","created_by_id")
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ` + linkCols
	return scanLink(s.db.QueryRow(ctx, q, uuid.NewString(), in.DesignID, in.Token, string(in.Mode), in.PasswordHash, in.ExpiresAt, in.RequireSignin, in.CreatedByID))
}

func (s *Service) getLink(ctx context.Context, id string) (LinkRow, error) {
	l, err := scanLink(s.db.QueryRow(ctx, `SELECT `+linkCols+` FROM "share_links" WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return LinkRow{}, ErrNotFound
	}
	return l, err
}

func (s *Service) getLinkByToken(ctx context.Context, token string) (LinkRow, error) {
	l, err := scanLink(s.db.QueryRow(ctx, `SELECT `+linkCols+` FROM "share_links" WHERE token = $1`, token))
	if errors.Is(err, pgx.ErrNoRows) {
		return LinkRow{}, ErrNotFound
	}
	return l, err
}

func (s *Service) listLinksForDesign(ctx context.Context, designID string) ([]LinkRow, error) {
	rows, err := s.db.Query(ctx, `SELECT `+linkCols+` FROM "share_links" WHERE "design_id" = $1 ORDER BY "created_at"`, designID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []LinkRow
	for rows.Next() {
		l, err := scanLink(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

type linkPatch struct {
	mode          *authz.AccessMode
	disabled      *bool
	expiresAt     *time.Time
	expiresSet    bool
	token         *string
	requireSignin *bool
}

func (s *Service) updateLink(ctx context.Context, id string, p linkPatch) (LinkRow, error) {
	var modeStr *string
	if p.mode != nil {
		v := string(*p.mode)
		modeStr = &v
	}
	const q = `UPDATE "share_links"
		SET mode = COALESCE($2, mode),
		    disabled = COALESCE($3, disabled),
		    "expires_at" = CASE WHEN $5 THEN $4 ELSE "expires_at" END,
		    token = COALESCE($6, token),
		    "require_signin" = COALESCE($7, "require_signin")
		WHERE id = $1 RETURNING ` + linkCols
	l, err := scanLink(s.db.QueryRow(ctx, q, id, modeStr, p.disabled, p.expiresAt, p.expiresSet, p.token, p.requireSignin))
	if errors.Is(err, pgx.ErrNoRows) {
		return LinkRow{}, ErrNotFound
	}
	return l, err
}

func (s *Service) deleteLink(ctx context.Context, id string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM "share_links" WHERE id = $1`, id)
	return err
}

// --- custom roles --------------------------------------------------------

func scanRole(row pgx.Row) (RoleRow, error) {
	var r RoleRow
	var caps []string
	err := row.Scan(&r.ID, &r.WorkspaceID, &r.DesignID, &r.Name, &caps, &r.CreatedAt)
	for _, c := range caps {
		r.Capabilities = append(r.Capabilities, authz.Capability(c))
	}
	return r, err
}

const roleCols = `id, "workspace_id", "design_id", name, capabilities, "created_at"`

func capStrings(caps []authz.Capability) []string {
	out := make([]string, len(caps))
	for i, c := range caps {
		out[i] = string(c)
	}
	return out
}

func (s *Service) createCustomRole(ctx context.Context, in RoleRow) (RoleRow, error) {
	const q = `INSERT INTO "custom_roles" (id,"workspace_id","design_id",name,capabilities)
		VALUES ($1,$2,$3,$4,$5) RETURNING ` + roleCols
	return scanRole(s.db.QueryRow(ctx, q, uuid.NewString(), in.WorkspaceID, in.DesignID, in.Name, capStrings(in.Capabilities)))
}

func (s *Service) getCustomRole(ctx context.Context, id string) (RoleRow, error) {
	r, err := scanRole(s.db.QueryRow(ctx, `SELECT `+roleCols+` FROM "custom_roles" WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return RoleRow{}, ErrNotFound
	}
	return r, err
}

func (s *Service) listCustomRolesForWorkspace(ctx context.Context, workspaceID string) ([]RoleRow, error) {
	rows, err := s.db.Query(ctx, `SELECT `+roleCols+` FROM "custom_roles" WHERE "workspace_id" = $1 ORDER BY "created_at"`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collectRoles(rows)
}

// listCustomRolesForDesign returns workspace-wide roles (designId null) plus
// ones pinned to this design.
func (s *Service) listCustomRolesForDesign(ctx context.Context, workspaceID, designID string) ([]RoleRow, error) {
	rows, err := s.db.Query(ctx,
		`SELECT `+roleCols+` FROM "custom_roles"
		 WHERE "workspace_id" = $1 AND ("design_id" IS NULL OR "design_id" = $2)
		 ORDER BY "created_at"`,
		workspaceID, designID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collectRoles(rows)
}

func collectRoles(rows pgx.Rows) ([]RoleRow, error) {
	var out []RoleRow
	for rows.Next() {
		r, err := scanRole(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Service) updateCustomRole(ctx context.Context, id string, name *string, caps *[]authz.Capability) (RoleRow, error) {
	var capArr []string
	if caps != nil {
		capArr = capStrings(*caps)
	}
	const q = `UPDATE "custom_roles"
		SET name = COALESCE($2, name),
		    capabilities = CASE WHEN $4 THEN $3 ELSE capabilities END
		WHERE id = $1 RETURNING ` + roleCols
	r, err := scanRole(s.db.QueryRow(ctx, q, id, name, capArr, caps != nil))
	if errors.Is(err, pgx.ErrNoRows) {
		return RoleRow{}, ErrNotFound
	}
	return r, err
}

func (s *Service) deleteCustomRole(ctx context.Context, id string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM "custom_roles" WHERE id = $1`, id)
	return err
}
