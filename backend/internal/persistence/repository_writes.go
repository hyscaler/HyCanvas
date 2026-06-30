// Write-side SQL for the persistence lifecycle, against the Prisma-managed
// tables "designs", "design_snapshots", and "design_versions" (quoted identifiers,
// snake_case columns). SnapshotKind is stored UPPERCASE (the enum); the service
// uses lowercase.
package persistence

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// designRow is the internal Design row with raw types (the DTO mapper turns it
// into DesignRecord).
type designRow struct {
	ID              string
	WorkspaceID     string
	Title           string
	SchemaVersion   int
	DocKind         *string
	CurrentSnapshot *string
	CreatedAt       time.Time
	UpdatedAt       time.Time
	DeletedAt       *time.Time
	PurgeAfter      *time.Time
	SourceDesignID  *string
	SourceVersionID *string
}

const designCols = `id,"workspace_id",title,"schema_version","doc_kind","current_snapshot_id","created_at","updated_at","deleted_at","purge_after","source_design_id","source_version_id"`

func scanDesign(row pgx.Row) (designRow, error) {
	var d designRow
	err := row.Scan(&d.ID, &d.WorkspaceID, &d.Title, &d.SchemaVersion, &d.DocKind, &d.CurrentSnapshot,
		&d.CreatedAt, &d.UpdatedAt, &d.DeletedAt, &d.PurgeAfter, &d.SourceDesignID, &d.SourceVersionID)
	return d, err
}

func (s *Service) getDesign(ctx context.Context, id string) (designRow, error) {
	d, err := scanDesign(s.db.QueryRow(ctx, `SELECT `+designCols+` FROM "designs" WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return designRow{}, ErrNotFound
	}
	return d, err
}

type createDesignInput struct {
	workspaceID     string
	title           string
	schemaVersion   int
	docKind         *string
	createdByID     *string
	sourceDesignID  *string
	sourceVersionID *string
}

func (s *Service) createDesign(ctx context.Context, in createDesignInput) (designRow, error) {
	const q = `INSERT INTO "designs" (id,"workspace_id",title,"schema_version","doc_kind","created_by_id","source_design_id","source_version_id","updated_at")
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()) RETURNING ` + designCols
	return scanDesign(s.db.QueryRow(ctx, q, uuid.NewString(), in.workspaceID, in.title, in.schemaVersion, in.docKind, in.createdByID, in.sourceDesignID, in.sourceVersionID))
}

type designPatch struct {
	title             *string
	currentSnapshotID *string
	schemaVersion     *int
	deletedAtSet      bool
	deletedAt         *time.Time
	purgeAfter        *time.Time
}

func (s *Service) updateDesign(ctx context.Context, id string, p designPatch) (designRow, error) {
	set := []string{`"updated_at" = now()`}
	args := []any{id}
	add := func(col string, v any) {
		args = append(args, v)
		set = append(set, col+" = $"+itoa(len(args)))
	}
	if p.title != nil {
		add("title", *p.title)
	}
	if p.currentSnapshotID != nil {
		add(`"current_snapshot_id"`, *p.currentSnapshotID)
	}
	if p.schemaVersion != nil {
		add(`"schema_version"`, *p.schemaVersion)
	}
	if p.deletedAtSet {
		add(`"deleted_at"`, p.deletedAt)
		add(`"purge_after"`, p.purgeAfter)
	}
	q := `UPDATE "designs" SET ` + strings.Join(set, ", ") + ` WHERE id = $1 RETURNING ` + designCols
	d, err := scanDesign(s.db.QueryRow(ctx, q, args...))
	if errors.Is(err, pgx.ErrNoRows) {
		return designRow{}, ErrNotFound
	}
	return d, err
}

func (s *Service) listBranchRows(ctx context.Context, sourceDesignID string) ([]designRow, error) {
	rows, err := s.db.Query(ctx, `SELECT `+designCols+` FROM "designs" WHERE "source_design_id" = $1 AND "deleted_at" IS NULL ORDER BY "created_at"`, sourceDesignID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collectDesigns(rows)
}

func (s *Service) listTrashRows(ctx context.Context, workspaceID string) ([]designRow, error) {
	rows, err := s.db.Query(ctx, `SELECT `+designCols+` FROM "designs" WHERE "workspace_id" = $1 AND "deleted_at" IS NOT NULL ORDER BY "deleted_at" DESC`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collectDesigns(rows)
}

func collectDesigns(rows pgx.Rows) ([]designRow, error) {
	var out []designRow
	for rows.Next() {
		d, err := scanDesign(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *Service) hardDeleteDesign(ctx context.Context, id string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM "designs" WHERE id = $1`, id)
	return err
}

// --- snapshots -----------------------------------------------------------

type snapshotRow struct {
	ID            string
	DesignID      string
	BlobURL       string
	Checksum      string
	SchemaVersion int
	SizeBytes     int64
	Kind          SnapshotKind // lowercase
	AuthorID      *string
	CreatedAt     time.Time
}

const snapshotCols = `id,"design_id","blob_url",checksum,"schema_version","size_bytes",kind,"author_id","created_at"`

func scanSnapshot(row pgx.Row) (snapshotRow, error) {
	var s snapshotRow
	var kind string
	err := row.Scan(&s.ID, &s.DesignID, &s.BlobURL, &s.Checksum, &s.SchemaVersion, &s.SizeBytes, &kind, &s.AuthorID, &s.CreatedAt)
	s.Kind = SnapshotKind(strings.ToLower(kind))
	return s, err
}

type createSnapshotInput struct {
	designID      string
	blobURL       string
	checksum      string
	schemaVersion int
	sizeBytes     int64
	kind          SnapshotKind
	authorID      *string
}

func (s *Service) createSnapshot(ctx context.Context, in createSnapshotInput) (snapshotRow, error) {
	const q = `INSERT INTO "design_snapshots" (id,"design_id","blob_url",checksum,"schema_version","size_bytes",kind,"author_id")
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ` + snapshotCols
	return scanSnapshot(s.db.QueryRow(ctx, q, uuid.NewString(), in.designID, in.blobURL, in.checksum, in.schemaVersion, in.sizeBytes, strings.ToUpper(string(in.kind)), in.authorID))
}

func (s *Service) getSnapshot(ctx context.Context, id string) (snapshotRow, error) {
	r, err := scanSnapshot(s.db.QueryRow(ctx, `SELECT `+snapshotCols+` FROM "design_snapshots" WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return snapshotRow{}, ErrNotFound
	}
	return r, err
}

func (s *Service) listSnapshots(ctx context.Context, designID string) ([]snapshotRow, error) {
	rows, err := s.db.Query(ctx, `SELECT `+snapshotCols+` FROM "design_snapshots" WHERE "design_id" = $1 ORDER BY "created_at" DESC`, designID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []snapshotRow
	for rows.Next() {
		r, err := scanSnapshot(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// --- versions ------------------------------------------------------------

type versionRow struct {
	ID          string
	DesignID    string
	SnapshotID  string
	Label       *string
	AuthorID    *string
	DiffSummary *DiffSummary
	CreatedAt   time.Time
}

const versionCols = `id,"design_id","snapshot_id",label,"author_id","diff_summary","created_at"`

func scanVersion(row pgx.Row) (versionRow, error) {
	var v versionRow
	var diffRaw []byte
	err := row.Scan(&v.ID, &v.DesignID, &v.SnapshotID, &v.Label, &v.AuthorID, &diffRaw, &v.CreatedAt)
	if err == nil && len(diffRaw) > 0 {
		var d DiffSummary
		if json.Unmarshal(diffRaw, &d) == nil {
			v.DiffSummary = &d
		}
	}
	return v, err
}

type createVersionInput struct {
	designID   string
	snapshotID string
	label      *string
	authorID   *string
}

func (s *Service) createVersion(ctx context.Context, in createVersionInput) (versionRow, error) {
	const q = `INSERT INTO "design_versions" (id,"design_id","snapshot_id",label,"author_id")
		VALUES ($1,$2,$3,$4,$5) RETURNING ` + versionCols
	return scanVersion(s.db.QueryRow(ctx, q, uuid.NewString(), in.designID, in.snapshotID, in.label, in.authorID))
}

func (s *Service) getVersion(ctx context.Context, id string) (versionRow, error) {
	v, err := scanVersion(s.db.QueryRow(ctx, `SELECT `+versionCols+` FROM "design_versions" WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return versionRow{}, ErrNotFound
	}
	return v, err
}

// listVersionRows returns newest-first versions, windowed by a createdAt cursor.
func (s *Service) listVersionRows(ctx context.Context, designID string, limit int, cursor *time.Time) ([]versionRow, error) {
	const q = `SELECT ` + versionCols + ` FROM "design_versions"
		WHERE "design_id" = $1 AND ($2::timestamptz IS NULL OR "created_at" < $2)
		ORDER BY "created_at" DESC LIMIT $3`
	rows, err := s.db.Query(ctx, q, designID, cursor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []versionRow
	for rows.Next() {
		v, err := scanVersion(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *Service) setVersionDiff(ctx context.Context, versionID string, d DiffSummary) error {
	raw, _ := json.Marshal(d)
	_, err := s.db.Exec(ctx, `UPDATE "design_versions" SET "diff_summary" = $2 WHERE id = $1`, versionID, raw)
	return err
}

// --- user names (for version author attribution) -------------------------

func (s *Service) getUserNames(ctx context.Context, ids []string) (map[string]string, error) {
	out := map[string]string{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.db.Query(ctx, `SELECT id, name FROM "users" WHERE id = ANY($1)`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		out[id] = name
	}
	return out, rows.Err()
}

// itoa avoids importing strconv for the dynamic-placeholder builder.
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
