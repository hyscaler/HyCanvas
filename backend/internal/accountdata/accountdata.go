// Package accountdata provides self-serve account data export and account
// deletion (doc 15 FR-17). It sits above accounts + persistence (its own package
// to avoid an accounts<->persistence import cycle): export assembles a portable
// JSON bundle of the user's profile, memberships, and designs; deletion
// re-authenticates, tears down sole-member workspaces, drops shared memberships
// (transferring ownership first), and removes all account-scoped rows.
package accountdata

import (
	"context"
	"strings"
	"time"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/persistence"
)

const exportFormat = "hycanvas/account-export@1"

// DBTX is the minimal data surface (satisfied by *pgxpool.Pool / pgx.Tx).
type DBTX = accounts.DBTX

// Service orchestrates export + deletion.
type Service struct {
	db      DBTX
	acct    *accounts.Service
	persist *persistence.Service
}

func NewService(db DBTX, acct *accounts.Service, persist *persistence.Service) *Service {
	return &Service{db: db, acct: acct, persist: persist}
}

type exportWorkspace struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	Name  string `json:"name"`
	Slug  string `json:"slug"`
	Role  string `json:"role"`
	Owner bool   `json:"owner"`
}

type exportDesign struct {
	ID            string         `json:"id"`
	WorkspaceID   string         `json:"workspaceId"`
	Title         string         `json:"title"`
	SchemaVersion int            `json:"schemaVersion"`
	CreatedAt     string         `json:"createdAt"`
	UpdatedAt     string         `json:"updatedAt"`
	File          map[string]any `json:"file"`
}

// Export is the downloadable account bundle.
type Export struct {
	Format     string            `json:"format"`
	ExportedAt string            `json:"exportedAt"`
	Profile    map[string]any    `json:"profile"`
	Workspaces []exportWorkspace `json:"workspaces"`
	Designs    []exportDesign    `json:"designs"`
}

func iso(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z07:00") }

// Export assembles the user's full data export. The password hash and MFA secret
// are deliberately omitted (GetUserByID returns the public profile only).
func (s *Service) Export(ctx context.Context, userID string) (*Export, error) {
	user, err := s.acct.GetUserByID(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := &Export{
		Format: exportFormat, ExportedAt: iso(time.Now()),
		Profile: map[string]any{
			"id": user.ID, "email": user.Email, "emailVerified": user.EmailVerified,
			"name": user.Name, "avatarUrl": user.AvatarURL, "locale": user.Locale,
			"theme": user.Theme, "mfaEnabled": user.MFAEnabled, "createdAt": user.CreatedAt,
		},
		Workspaces: []exportWorkspace{}, Designs: []exportDesign{},
	}

	rows, err := s.db.Query(ctx,
		`SELECT m."workspaceId", m.role, w.kind, w.name, w.slug, w."ownerId"
		 FROM "WorkspaceMember" m JOIN "Workspace" w ON w.id = m."workspaceId"
		 WHERE m."userId" = $1 AND m.status = 'ACTIVE'`, userID)
	if err != nil {
		return nil, err
	}
	type wsRow struct{ id, role, kind, name, slug, owner string }
	var memberWS []wsRow
	for rows.Next() {
		var r wsRow
		if err := rows.Scan(&r.id, &r.role, &r.kind, &r.name, &r.slug, &r.owner); err != nil {
			rows.Close()
			return nil, err
		}
		memberWS = append(memberWS, r)
	}
	rows.Close()

	for _, ws := range memberWS {
		out.Workspaces = append(out.Workspaces, exportWorkspace{
			ID: ws.id, Kind: strings.ToLower(ws.kind), Name: ws.name, Slug: ws.slug,
			Role: strings.ToLower(ws.role), Owner: ws.owner == userID,
		})
		designs, err := s.persist.ListByWorkspace(ctx, ws.id, 200)
		if err != nil {
			return nil, err
		}
		for _, rec := range designs {
			loaded, err := s.persist.LoadFile(ctx, rec.ID, ws.id)
			if err != nil {
				continue // skip an unreadable snapshot rather than failing the export
			}
			out.Designs = append(out.Designs, exportDesign{
				ID: rec.ID, WorkspaceID: ws.id, Title: rec.Title, SchemaVersion: rec.SchemaVersion,
				CreatedAt: rec.CreatedAt, UpdatedAt: rec.UpdatedAt, File: loaded.File,
			})
		}
	}
	return out, nil
}

// Delete permanently removes the account after re-authentication. Sole-member
// workspaces are torn down with their designs; shared workspaces keep standing
// (ownership transferred to a remaining member if the leaver owns it), then all
// account-scoped rows are cleared in FK-safe order with the user row last.
func (s *Service) Delete(ctx context.Context, userID, password, code string) error {
	if err := s.acct.VerifyReauth(ctx, userID, password, code); err != nil {
		return err
	}

	type mem struct{ id, wsID string }
	rows, err := s.db.Query(ctx, `SELECT id, "workspaceId" FROM "WorkspaceMember" WHERE "userId" = $1`, userID)
	if err != nil {
		return err
	}
	var mems []mem
	for rows.Next() {
		var m mem
		if err := rows.Scan(&m.id, &m.wsID); err != nil {
			rows.Close()
			return err
		}
		mems = append(mems, m)
	}
	rows.Close()

	for _, m := range mems {
		others, err := s.otherMembers(ctx, m.wsID, userID)
		if err != nil {
			return err
		}
		if len(others) == 0 {
			if err := s.purgeWorkspace(ctx, m.wsID); err != nil {
				return err
			}
			if _, err := s.db.Exec(ctx, `DELETE FROM "Workspace" WHERE id = $1`, m.wsID); err != nil {
				return err
			}
			continue
		}
		var owner string
		if err := s.db.QueryRow(ctx, `SELECT "ownerId" FROM "Workspace" WHERE id = $1`, m.wsID).Scan(&owner); err == nil && owner == userID {
			successor := pickSuccessor(others)
			if _, err := s.db.Exec(ctx, `UPDATE "Workspace" SET "ownerId" = $1, "updatedAt" = now() WHERE id = $2`, successor, m.wsID); err != nil {
				return err
			}
		}
		if _, err := s.db.Exec(ctx, `DELETE FROM "WorkspaceMember" WHERE id = $1`, m.id); err != nil {
			return err
		}
	}

	for _, q := range []string{
		`DELETE FROM "Session" WHERE "userId" = $1`,
		`DELETE FROM "Favorite" WHERE "userId" = $1`,
		`DELETE FROM "VerificationToken" WHERE "userId" = $1`,
		`DELETE FROM "MfaRecoveryCode" WHERE "userId" = $1`,
		`DELETE FROM "AuthIdentity" WHERE "userId" = $1`,
		`DELETE FROM "User" WHERE id = $1`,
	} {
		if _, err := s.db.Exec(ctx, q, userID); err != nil {
			return err
		}
	}
	return nil
}

type member struct {
	userID string
	role   string
}

func (s *Service) otherMembers(ctx context.Context, workspaceID, excludeUser string) ([]member, error) {
	rows, err := s.db.Query(ctx,
		`SELECT "userId", role FROM "WorkspaceMember" WHERE "workspaceId" = $1 AND "userId" <> $2`, workspaceID, excludeUser)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []member
	for rows.Next() {
		var m member
		if err := rows.Scan(&m.userID, &m.role); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// pickSuccessor prefers an admin, then an owner, then any remaining member.
func pickSuccessor(others []member) string {
	for _, m := range others {
		if m.role == "ADMIN" {
			return m.userID
		}
	}
	for _, m := range others {
		if m.role == "OWNER" {
			return m.userID
		}
	}
	return others[0].userID
}

// purgeWorkspace hard-deletes all of a workspace's designs (active + trashed),
// looping so it is not bounded by the list page size.
func (s *Service) purgeWorkspace(ctx context.Context, workspaceID string) error {
	for i := 0; i < 1000; i++ {
		designs, err := s.persist.ListByWorkspace(ctx, workspaceID, 200)
		if err != nil {
			return err
		}
		if len(designs) == 0 {
			break
		}
		for _, d := range designs {
			if err := s.persist.Purge(ctx, d.ID, workspaceID); err != nil {
				return err
			}
		}
	}
	trash, err := s.persist.ListTrash(ctx, workspaceID)
	if err != nil {
		return err
	}
	for _, d := range trash {
		if err := s.persist.Purge(ctx, d.ID, workspaceID); err != nil {
			return err
		}
	}
	return nil
}
