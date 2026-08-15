// Package persistence ports the design metadata read paths AND the durable
// save/load lifecycle (doc 04): the design record + workspace lookup used for
// authorization and the dashboard, plus create/load/snapshot/versions/diff/
// restore/branch/trash over content-addressed snapshot blobs in storage. The
// DesignFile is handled as opaque JSON (the open file format), so the Go service
// reads and writes the SAME blobs as the NestJS backend.
//
// Deferred: schema-version MIGRATION of an older stored file (the Go service
// returns it verbatim; the frontend @hc/schema migrates on open), and the
// brand-lock validateSnapshot gate on the user-facing POST /snapshots route
// (that route stays on the Node service until brand findBrandViolations is
// ported, so no brand-lock regression). The Go snapshot() method is still used
// internally by the brand-meta accessors for meta-only checkpoint writes.
package persistence

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"hycanvas/backend/internal/storage"
)

// DBTX is the query surface persistence needs (satisfied by *pgxpool.Pool /
// pgx.Tx). Exec is used by the write lifecycle; read-only callers never invoke
// the write methods.
type DBTX interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	// Begin scopes the few writes that must be atomic across statements (the
	// checkpoint compaction / branch-creation pair). Satisfied by both a pool
	// and a pgx.Tx (which nests via savepoint), so tests still run inside one
	// rolled-back transaction.
	Begin(ctx context.Context) (pgx.Tx, error)
}

// DesignRecord matches the NestJS DesignRecord JSON shape exactly.
type DesignRecord struct {
	ID              string  `json:"id"`
	WorkspaceID     string  `json:"workspaceId"`
	Title           string  `json:"title"`
	SchemaVersion   int     `json:"schemaVersion"`
	DocKind         *string `json:"docKind"`
	CurrentSnapshot *string `json:"currentSnapshotId"`
	CreatedAt       string  `json:"createdAt"`
	UpdatedAt       string  `json:"updatedAt"`
	DeletedAt       *string `json:"deletedAt"`
	PurgeAfter      *string `json:"purgeAfter"`
	SourceDesignID  *string `json:"sourceDesignId"`
	SourceVersionID *string `json:"sourceVersionId"`
}

type Service struct {
	db      DBTX
	storage storage.Driver // nil for read-only callers; required by the write lifecycle
}

func NewService(db DBTX) *Service { return &Service{db: db} }

// WithStorage attaches a storage driver, enabling the save/load/snapshot
// lifecycle. Returns the same service for chaining at wiring time.
func (s *Service) WithStorage(driver storage.Driver) *Service {
	s.storage = driver
	return s
}

// retentionDays is the trash retention window before a design is purge-eligible
// (doc 04 FR-9).
const retentionDays = 30

// GetWorkspaceID resolves a design's workspace (for authorization). Returns
// pgx.ErrNoRows when the design does not exist.
func (s *Service) GetWorkspaceID(ctx context.Context, designID string) (string, error) {
	var ws string
	err := s.db.QueryRow(ctx, `SELECT "workspace_id" FROM "designs" WHERE id = $1`, designID).Scan(&ws)
	return ws, err
}

const iso = "2006-01-02T15:04:05.000Z07:00"

func isoPtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.UTC().Format(iso)
	return &s
}

// GetRecord returns the design metadata record.
func (s *Service) GetRecord(ctx context.Context, designID string) (*DesignRecord, error) {
	const q = `SELECT id, "workspace_id", title, "schema_version", "doc_kind", "current_snapshot_id",
		"created_at", "updated_at", "deleted_at", "purge_after", "source_design_id", "source_version_id"
		FROM "designs" WHERE id = $1`
	var (
		r                  DesignRecord
		created, updated   time.Time
		deletedAt, purgeAt *time.Time
	)
	if err := s.db.QueryRow(ctx, q, designID).Scan(
		&r.ID, &r.WorkspaceID, &r.Title, &r.SchemaVersion, &r.DocKind, &r.CurrentSnapshot,
		&created, &updated, &deletedAt, &purgeAt, &r.SourceDesignID, &r.SourceVersionID,
	); err != nil {
		return nil, err
	}
	r.CreatedAt = created.UTC().Format(iso)
	r.UpdatedAt = updated.UTC().Format(iso)
	r.DeletedAt = isoPtr(deletedAt)
	r.PurgeAfter = isoPtr(purgeAt)
	return &r, nil
}

// ListByWorkspace returns non-deleted designs in a workspace, newest first
// (the dashboard's recent list).
func (s *Service) ListByWorkspace(ctx context.Context, workspaceID string, limit int) ([]DesignRecord, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	const q = `SELECT id, "workspace_id", title, "schema_version", "doc_kind", "current_snapshot_id",
		"created_at", "updated_at", "deleted_at", "purge_after", "source_design_id", "source_version_id"
		FROM "designs" WHERE "workspace_id" = $1 AND "deleted_at" IS NULL
		ORDER BY "updated_at" DESC LIMIT $2`
	rows, err := s.db.Query(ctx, q, workspaceID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DesignRecord{}
	for rows.Next() {
		var (
			r                  DesignRecord
			created, updated   time.Time
			deletedAt, purgeAt *time.Time
		)
		if err := rows.Scan(
			&r.ID, &r.WorkspaceID, &r.Title, &r.SchemaVersion, &r.DocKind, &r.CurrentSnapshot,
			&created, &updated, &deletedAt, &purgeAt, &r.SourceDesignID, &r.SourceVersionID,
		); err != nil {
			return nil, err
		}
		r.CreatedAt = created.UTC().Format(iso)
		r.UpdatedAt = updated.UTC().Format(iso)
		r.DeletedAt = isoPtr(deletedAt)
		r.PurgeAfter = isoPtr(purgeAt)
		out = append(out, r)
	}
	return out, rows.Err()
}
