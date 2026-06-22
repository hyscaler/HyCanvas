// SQL access for templates, against the Prisma-managed tables "Template" and
// "TemplateCollection" (quoted identifiers, camelCase columns). visibility is
// stored UPPERCASE (the enum); file/style/attribution are JSONB. The repo
// enforces the visibility scope (public global; private = owner; workspace =
// member workspaces) at the query layer.
package templates

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const isoFmt = "2006-01-02T15:04:05.000Z07:00"

// DBTX is the query surface (satisfied by *pgxpool.Pool and pgx.Tx).
type DBTX interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// TemplateRow mirrors the Template table (visibility lowercased on read).
type TemplateRow struct {
	ID             string
	OwnerID        string
	WorkspaceID    *string
	Title          string
	Category       *string
	Tags           []string
	File           json.RawMessage
	Thumbnail      *string
	Visibility     string // private|workspace|public
	CollectionID   *string
	Style          json.RawMessage
	FillableFields json.RawMessage
	Attributions   json.RawMessage
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

const tmplCols = `id,"ownerId","workspaceId",title,category,tags,file,thumbnail,visibility,"collectionId",style,
	'[]'::jsonb,attribution,"createdAt","updatedAt"`

func scanTemplate(row pgx.Row) (TemplateRow, error) {
	var t TemplateRow
	var vis string
	err := row.Scan(&t.ID, &t.OwnerID, &t.WorkspaceID, &t.Title, &t.Category, &t.Tags, &t.File,
		&t.Thumbnail, &vis, &t.CollectionID, &t.Style, &t.FillableFields, &t.Attributions, &t.CreatedAt, &t.UpdatedAt)
	t.Visibility = strings.ToLower(vis)
	return t, err
}

func (s *Service) getRow(ctx context.Context, id string) (TemplateRow, error) {
	t, err := scanTemplate(s.db.QueryRow(ctx, `SELECT `+tmplCols+` FROM "Template" WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return TemplateRow{}, ErrNotFound
	}
	return t, err
}

// listRows returns templates the caller may see (public + own private + member
// workspaces), optionally narrowed to a workspace + collection.
func (s *Service) listRows(ctx context.Context, userID string, memberWS []string, workspaceID, collectionID string) ([]TemplateRow, error) {
	q := `SELECT ` + tmplCols + ` FROM "Template"
		WHERE (visibility = 'PUBLIC'
		   OR (visibility = 'PRIVATE' AND "ownerId" = $1)
		   OR (visibility = 'WORKSPACE' AND "workspaceId" = ANY($2)))`
	args := []any{userID, memberWS}
	if workspaceID != "" {
		args = append(args, workspaceID)
		q += ` AND "workspaceId" = $` + itoa(len(args))
	}
	if collectionID != "" {
		args = append(args, collectionID)
		q += ` AND "collectionId" = $` + itoa(len(args))
	}
	q += ` ORDER BY "updatedAt" DESC`
	rows, err := s.db.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TemplateRow
	for rows.Next() {
		t, err := scanTemplate(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

type createTemplateInput struct {
	ownerID      string
	workspaceID  *string
	title        string
	category     *string
	tags         []string
	file         json.RawMessage
	thumbnail    *string
	visibility   string // lowercase
	collectionID *string
	style        json.RawMessage
}

func (s *Service) createRow(ctx context.Context, in createTemplateInput) (TemplateRow, error) {
	const q = `INSERT INTO "Template" (id,"ownerId","workspaceId",title,category,tags,file,thumbnail,visibility,"collectionId",style,attribution,"updatedAt")
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'[]'::jsonb,now()) RETURNING ` + tmplCols
	if in.tags == nil {
		in.tags = []string{}
	}
	return scanTemplate(s.db.QueryRow(ctx, q,
		uuid.NewString(), in.ownerID, in.workspaceID, in.title, in.category, in.tags, in.file,
		in.thumbnail, strings.ToUpper(in.visibility), in.collectionID, in.style))
}

func (s *Service) setCollection(ctx context.Context, id string, collectionID *string) (TemplateRow, error) {
	t, err := scanTemplate(s.db.QueryRow(ctx, `UPDATE "Template" SET "collectionId" = $2, "updatedAt" = now() WHERE id = $1 RETURNING `+tmplCols, id, collectionID))
	if errors.Is(err, pgx.ErrNoRows) {
		return TemplateRow{}, ErrNotFound
	}
	return t, err
}

// --- collections ---------------------------------------------------------

type collectionRow struct {
	ID          string
	WorkspaceID string
	Name        string
}

func (s *Service) getCollection(ctx context.Context, id string) (collectionRow, error) {
	var c collectionRow
	err := s.db.QueryRow(ctx, `SELECT id,"workspaceId",name FROM "TemplateCollection" WHERE id = $1`, id).Scan(&c.ID, &c.WorkspaceID, &c.Name)
	if errors.Is(err, pgx.ErrNoRows) {
		return collectionRow{}, ErrNotFound
	}
	return c, err
}

func (s *Service) listCollections(ctx context.Context, workspaceID string) ([]collectionRow, error) {
	rows, err := s.db.Query(ctx, `SELECT id,"workspaceId",name FROM "TemplateCollection" WHERE "workspaceId" = $1 ORDER BY "createdAt"`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []collectionRow
	for rows.Next() {
		var c collectionRow
		if err := rows.Scan(&c.ID, &c.WorkspaceID, &c.Name); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Service) createCollection(ctx context.Context, workspaceID, name string) (collectionRow, error) {
	var c collectionRow
	err := s.db.QueryRow(ctx, `INSERT INTO "TemplateCollection" (id,"workspaceId",name) VALUES ($1,$2,$3) RETURNING id,"workspaceId",name`,
		uuid.NewString(), workspaceID, strings.TrimSpace(name)).Scan(&c.ID, &c.WorkspaceID, &c.Name)
	return c, err
}

func (s *Service) deleteCollection(ctx context.Context, id string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM "TemplateCollection" WHERE id = $1`, id)
	return err
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
