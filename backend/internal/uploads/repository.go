// SQL access for the uploads module, against the tables "assets"
// and "asset_folders" (quoted identifiers, snake_case columns). meta is JSONB; the
// mediaKind sub-key carries the fine-grained @hc/media kind.
package uploads

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

type assetRow struct {
	ID          string
	WorkspaceID string
	Kind        string // Prisma enum (IMAGE/VIDEO/...)
	StorageKey  string
	Filename    *string
	MimeType    *string
	ByteSize    *int64
	Thumbnail   *string
	FolderID    *string
	Tags        []string
	MediaKind   string // meta.mediaKind
	CreatedAt   time.Time
}

const assetCols = `id,"workspace_id",kind,"storage_key",filename,"mime_type","byte_size",thumbnail,"folder_id",tags,meta,"created_at"`

func scanAsset(row pgx.Row) (assetRow, error) {
	var a assetRow
	var metaRaw []byte
	err := row.Scan(&a.ID, &a.WorkspaceID, &a.Kind, &a.StorageKey, &a.Filename, &a.MimeType, &a.ByteSize, &a.Thumbnail, &a.FolderID, &a.Tags, &metaRaw, &a.CreatedAt)
	if err == nil && len(metaRaw) > 0 {
		var meta map[string]any
		if json.Unmarshal(metaRaw, &meta) == nil {
			if mk, ok := meta["mediaKind"].(string); ok {
				a.MediaKind = mk
			}
		}
	}
	return a, err
}

type createAssetInput struct {
	workspaceID  string
	kind         string
	storageKey   string
	filename     *string
	mimeType     string
	byteSize     int64
	thumbnail    *string
	folderID     *string
	uploadedByID *string
	mediaKind    string
}

func (s *Service) createAsset(ctx context.Context, in createAssetInput) (assetRow, error) {
	meta, _ := json.Marshal(map[string]any{"mediaKind": in.mediaKind})
	const q = `INSERT INTO "assets" (id,"workspace_id",kind,"storage_key",filename,"mime_type","byte_size",thumbnail,"folder_id",tags,"uploaded_by_id",meta,"updated_at")
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()) RETURNING ` + assetCols
	return scanAsset(s.db.QueryRow(ctx, q,
		uuid.NewString(), in.workspaceID, in.kind, in.storageKey, in.filename, in.mimeType, in.byteSize,
		in.thumbnail, in.folderID, []string{}, in.uploadedByID, meta))
}

func (s *Service) getAsset(ctx context.Context, id string) (assetRow, error) {
	a, err := scanAsset(s.db.QueryRow(ctx, `SELECT `+assetCols+` FROM "assets" WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return assetRow{}, ErrNotFound
	}
	return a, err
}

func (s *Service) listByWorkspace(ctx context.Context, workspaceID string) ([]assetRow, error) {
	rows, err := s.db.Query(ctx, `SELECT `+assetCols+` FROM "assets" WHERE "workspace_id" = $1 ORDER BY "created_at" DESC`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []assetRow
	for rows.Next() {
		a, err := scanAsset(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Service) usedBytes(ctx context.Context, workspaceID string) (int64, error) {
	var used int64
	err := s.db.QueryRow(ctx, `SELECT COALESCE(SUM("byte_size"),0) FROM "assets" WHERE "workspace_id" = $1`, workspaceID).Scan(&used)
	return used, err
}

type assetPatch struct {
	filename  *string
	folderID  *string
	folderSet bool
	tags      []string
	tagsSet   bool
}

func (s *Service) updateAsset(ctx context.Context, id string, p assetPatch) (assetRow, error) {
	set := []string{`"updated_at" = now()`}
	args := []any{id}
	add := func(col string, v any) {
		args = append(args, v)
		set = append(set, col+" = $"+itoa(len(args)))
	}
	if p.filename != nil {
		add("filename", *p.filename)
	}
	if p.tagsSet {
		add("tags", p.tags)
	}
	if p.folderSet {
		add(`"folder_id"`, p.folderID)
	}
	q := `UPDATE "assets" SET ` + strings.Join(set, ", ") + ` WHERE id = $1 RETURNING ` + assetCols
	a, err := scanAsset(s.db.QueryRow(ctx, q, args...))
	if errors.Is(err, pgx.ErrNoRows) {
		return assetRow{}, ErrNotFound
	}
	return a, err
}

func (s *Service) deleteAsset(ctx context.Context, id string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM "assets" WHERE id = $1`, id)
	return err
}

// --- folders -------------------------------------------------------------

type folderRow struct {
	ID          string
	WorkspaceID string
	Name        string
	ParentID    *string
	CreatedAt   time.Time
}

const folderCols = `id,"workspace_id",name,"parent_id","created_at"`

func scanFolder(row pgx.Row) (folderRow, error) {
	var f folderRow
	err := row.Scan(&f.ID, &f.WorkspaceID, &f.Name, &f.ParentID, &f.CreatedAt)
	return f, err
}

func (s *Service) listFolders(ctx context.Context, workspaceID string) ([]folderRow, error) {
	rows, err := s.db.Query(ctx, `SELECT `+folderCols+` FROM "asset_folders" WHERE "workspace_id" = $1 ORDER BY "created_at"`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []folderRow
	for rows.Next() {
		f, err := scanFolder(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (s *Service) getFolder(ctx context.Context, id string) (folderRow, error) {
	f, err := scanFolder(s.db.QueryRow(ctx, `SELECT `+folderCols+` FROM "asset_folders" WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return folderRow{}, ErrNotFound
	}
	return f, err
}

func (s *Service) createFolder(ctx context.Context, workspaceID, name string, parentID *string) (folderRow, error) {
	const q = `INSERT INTO "asset_folders" (id,"workspace_id",name,"parent_id") VALUES ($1,$2,$3,$4) RETURNING ` + folderCols
	return scanFolder(s.db.QueryRow(ctx, q, uuid.NewString(), workspaceID, name, parentID))
}

func (s *Service) renameFolder(ctx context.Context, id, name string) (folderRow, error) {
	f, err := scanFolder(s.db.QueryRow(ctx, `UPDATE "asset_folders" SET name = $2 WHERE id = $1 RETURNING `+folderCols, id, name))
	if errors.Is(err, pgx.ErrNoRows) {
		return folderRow{}, ErrNotFound
	}
	return f, err
}

func (s *Service) deleteFolder(ctx context.Context, id string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM "asset_folders" WHERE id = $1`, id)
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
