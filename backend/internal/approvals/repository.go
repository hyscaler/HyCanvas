// SQL access for approvals, against the Prisma-managed tables "Approval",
// "ApprovalDecision", and "ApprovalEvent" (quoted identifiers, camelCase
// columns). Policy/status/decision strings are stored verbatim (lowercase).
// approverIds is a Postgres text[]/uuid[] column.
package approvals

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

// ApprovalRow mirrors the Approval table.
type ApprovalRow struct {
	ID          string
	DesignID    string
	RequesterID string
	Policy      string
	Status      string
	ApproverIDs []string
	CreatedAt   time.Time
	DecidedAt   *time.Time
}

// DecisionRow mirrors the ApprovalDecision table.
type DecisionRow struct {
	ID         string
	ApprovalID string
	ApproverID string
	Decision   string
	Note       *string
	DecidedAt  time.Time
}

const approvalCols = `id, "designId", "requesterId", policy, status, "approverIds", "createdAt", "decidedAt"`

func scanApproval(row pgx.Row) (ApprovalRow, error) {
	var a ApprovalRow
	err := row.Scan(&a.ID, &a.DesignID, &a.RequesterID, &a.Policy, &a.Status, &a.ApproverIDs, &a.CreatedAt, &a.DecidedAt)
	return a, err
}

func (s *Service) createApproval(ctx context.Context, designID, requesterID, policy string, approverIDs []string) (ApprovalRow, error) {
	const q = `INSERT INTO "Approval" (id,"designId","requesterId",policy,status,"approverIds")
		VALUES ($1,$2,$3,$4,'pending',$5) RETURNING ` + approvalCols
	return scanApproval(s.db.QueryRow(ctx, q, uuid.NewString(), designID, requesterID, policy, approverIDs))
}

func (s *Service) getApproval(ctx context.Context, id string) (ApprovalRow, error) {
	a, err := scanApproval(s.db.QueryRow(ctx, `SELECT `+approvalCols+` FROM "Approval" WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return ApprovalRow{}, ErrNotFound
	}
	return a, err
}

// getActiveApproval returns the single active (pending|approved) approval for a
// design, most recent first.
func (s *Service) getActiveApproval(ctx context.Context, designID string) (*ApprovalRow, error) {
	const q = `SELECT ` + approvalCols + ` FROM "Approval"
		WHERE "designId" = $1 AND status IN ('pending','approved')
		ORDER BY "createdAt" DESC LIMIT 1`
	a, err := scanApproval(s.db.QueryRow(ctx, q, designID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}

func (s *Service) getLatestApproval(ctx context.Context, designID string) (*ApprovalRow, error) {
	const q = `SELECT ` + approvalCols + ` FROM "Approval" WHERE "designId" = $1 ORDER BY "createdAt" DESC LIMIT 1`
	a, err := scanApproval(s.db.QueryRow(ctx, q, designID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}

func (s *Service) updateApprovalStatus(ctx context.Context, id, status string, setDecided bool) error {
	var decidedAt *time.Time
	if setDecided {
		now := time.Now()
		decidedAt = &now
	}
	_, err := s.db.Exec(ctx, `UPDATE "Approval" SET status = $2, "decidedAt" = $3 WHERE id = $1`, id, status, decidedAt)
	return err
}

func (s *Service) upsertDecision(ctx context.Context, approvalID, approverID, decision string, note *string) error {
	// Idempotent on (approvalId, approverId): a re-decision overwrites the prior.
	const q = `INSERT INTO "ApprovalDecision" (id,"approvalId","approverId",decision,note)
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT ("approvalId","approverId")
		DO UPDATE SET decision = EXCLUDED.decision, note = EXCLUDED.note, "decidedAt" = now()`
	_, err := s.db.Exec(ctx, q, uuid.NewString(), approvalID, approverID, decision, note)
	return err
}

func (s *Service) listDecisions(ctx context.Context, approvalID string) ([]DecisionRow, error) {
	rows, err := s.db.Query(ctx,
		`SELECT id, "approvalId", "approverId", decision, note, "decidedAt"
		 FROM "ApprovalDecision" WHERE "approvalId" = $1 ORDER BY "decidedAt"`, approvalID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DecisionRow
	for rows.Next() {
		var d DecisionRow
		if err := rows.Scan(&d.ID, &d.ApprovalID, &d.ApproverID, &d.Decision, &d.Note, &d.DecidedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *Service) recordEvent(ctx context.Context, approvalID, designID string, actorID *string, typ string, payload map[string]any) error {
	var raw []byte
	if payload != nil {
		raw, _ = json.Marshal(payload)
	}
	_, err := s.db.Exec(ctx,
		`INSERT INTO "ApprovalEvent" (id,"approvalId","designId","actorId",type,payload)
		 VALUES ($1,$2,$3,$4,$5,$6)`,
		uuid.NewString(), approvalID, designID, actorID, typ, raw)
	return err
}
