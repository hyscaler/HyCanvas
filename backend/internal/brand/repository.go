// SQL access for the brand kit-management module, against the Prisma-managed
// tables "BrandKit" and "BrandKitVersion" (quoted identifiers, camelCase
// columns). palettes/fonts/logos/collections/voice/controls are JSONB.
package brand

import (
	"context"
	"encoding/json"
	"errors"
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

// BrandKitRow mirrors the BrandKit table.
type BrandKitRow struct {
	ID          string
	WorkspaceID string
	Name        string
	Version     int
	IsDefault   bool
	Palettes    json.RawMessage
	Fonts       json.RawMessage
	Logos       json.RawMessage
	Voice       json.RawMessage
	Collections json.RawMessage
	Controls    json.RawMessage
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

const kitCols = `id,"workspaceId",name,version,"isDefault",palettes,fonts,logos,voice,collections,controls,"createdAt","updatedAt"`

func scanKit(row pgx.Row) (BrandKitRow, error) {
	var k BrandKitRow
	err := row.Scan(&k.ID, &k.WorkspaceID, &k.Name, &k.Version, &k.IsDefault,
		&k.Palettes, &k.Fonts, &k.Logos, &k.Voice, &k.Collections, &k.Controls, &k.CreatedAt, &k.UpdatedAt)
	return k, err
}

func (s *Service) requireKit(ctx context.Context, id string) (BrandKitRow, error) {
	k, err := scanKit(s.db.QueryRow(ctx, `SELECT `+kitCols+` FROM "BrandKit" WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return BrandKitRow{}, ErrNotFound
	}
	return k, err
}

// listForWorkspace returns a workspace's kits, default first then by name.
func (s *Service) listForWorkspace(ctx context.Context, workspaceID string) ([]BrandKitRow, error) {
	rows, err := s.db.Query(ctx, `SELECT `+kitCols+` FROM "BrandKit" WHERE "workspaceId" = $1 ORDER BY "isDefault" DESC, name`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []BrandKitRow
	for rows.Next() {
		k, err := scanKit(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

func (s *Service) create(ctx context.Context, workspaceID, name string, isDefault bool) (BrandKitRow, error) {
	// version defaults to 1 and the content columns to '[]'/'{}' per the schema.
	const q = `INSERT INTO "BrandKit" (id,"workspaceId",name,"isDefault","updatedAt")
		VALUES ($1,$2,$3,$4,now()) RETURNING ` + kitCols
	return scanKit(s.db.QueryRow(ctx, q, uuid.NewString(), workspaceID, name, isDefault))
}

// clearDefault unsets isDefault on every other kit in the workspace.
func (s *Service) clearDefault(ctx context.Context, workspaceID, keepID string) error {
	_, err := s.db.Exec(ctx, `UPDATE "BrandKit" SET "isDefault" = false WHERE "workspaceId" = $1 AND id <> $2`, workspaceID, keepID)
	return err
}

func (s *Service) deleteKit(ctx context.Context, id string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM "BrandKit" WHERE id = $1`, id)
	return err
}

type updatePatch struct {
	name        *string
	version     int // 0 = leave unchanged
	isDefault   *bool
	palettes    json.RawMessage
	fonts       json.RawMessage
	logos       json.RawMessage
	voice       json.RawMessage
	voiceSet    bool
	collections json.RawMessage
	controls    json.RawMessage
}

func (s *Service) update(ctx context.Context, id string, p updatePatch) (BrandKitRow, error) {
	set := []string{`"updatedAt" = now()`}
	args := []any{id}
	add := func(col string, val any) {
		args = append(args, val)
		set = append(set, col+" = $"+itoa(len(args)))
	}
	if p.name != nil {
		add("name", *p.name)
	}
	if p.version > 0 {
		add("version", p.version)
	}
	if p.isDefault != nil {
		add(`"isDefault"`, *p.isDefault)
	}
	if p.palettes != nil {
		add("palettes", p.palettes)
	}
	if p.fonts != nil {
		add("fonts", p.fonts)
	}
	if p.logos != nil {
		add("logos", p.logos)
	}
	if p.voiceSet {
		add("voice", nullableJSON(p.voice))
	}
	if p.collections != nil {
		add("collections", p.collections)
	}
	if p.controls != nil {
		add("controls", p.controls)
	}
	q := `UPDATE "BrandKit" SET ` + join(set, ", ") + ` WHERE id = $1 RETURNING ` + kitCols
	k, err := scanKit(s.db.QueryRow(ctx, q, args...))
	if errors.Is(err, pgx.ErrNoRows) {
		return BrandKitRow{}, ErrNotFound
	}
	return k, err
}

// nullableJSON returns nil (SQL NULL) for a JSON "null"/empty voice, else the
// raw bytes, so clearing voice stores a NULL column.
func nullableJSON(b json.RawMessage) any {
	if len(b) == 0 || string(b) == "null" {
		return nil
	}
	return b
}

// --- versions ------------------------------------------------------------

func (s *Service) appendVersion(ctx context.Context, brandKitID string, version int, snapshot json.RawMessage, authorID string) error {
	var author *string
	if authorID != "" {
		author = &authorID
	}
	// Idempotent on (brandKitId, version): re-recording the same version replaces
	// its snapshot rather than failing the write.
	const q = `INSERT INTO "BrandKitVersion" (id,"brandKitId",version,snapshot,"authorId")
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT ("brandKitId",version) DO UPDATE SET snapshot = EXCLUDED.snapshot, "authorId" = EXCLUDED."authorId"`
	_, err := s.db.Exec(ctx, q, uuid.NewString(), brandKitID, version, snapshot, author)
	return err
}

func (s *Service) listVersions(ctx context.Context, brandKitID string) ([]BrandKitVersion, error) {
	rows, err := s.db.Query(ctx, `SELECT id,"brandKitId",version,snapshot,"authorId","createdAt" FROM "BrandKitVersion" WHERE "brandKitId" = $1 ORDER BY version DESC`, brandKitID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BrandKitVersion{}
	for rows.Next() {
		var v BrandKitVersion
		var created time.Time
		if err := rows.Scan(&v.ID, &v.BrandKitID, &v.Version, &v.Snapshot, &v.AuthorID, &created); err != nil {
			return nil, err
		}
		v.CreatedAt = created.UTC().Format(isoFmt)
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *Service) getVersion(ctx context.Context, brandKitID string, version int) (BrandKitVersion, error) {
	var v BrandKitVersion
	var created time.Time
	err := s.db.QueryRow(ctx, `SELECT id,"brandKitId",version,snapshot,"authorId","createdAt" FROM "BrandKitVersion" WHERE "brandKitId" = $1 AND version = $2`, brandKitID, version).
		Scan(&v.ID, &v.BrandKitID, &v.Version, &v.Snapshot, &v.AuthorID, &created)
	if errors.Is(err, pgx.ErrNoRows) {
		return BrandKitVersion{}, ErrNotFound
	}
	if err != nil {
		return BrandKitVersion{}, err
	}
	v.CreatedAt = created.UTC().Format(isoFmt)
	return v, nil
}

// --- tiny string helpers -------------------------------------------------

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

func join(parts []string, sep string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += sep
		}
		out += p
	}
	return out
}
