// SQL access for whiteboard voting against the Prisma-managed tables
// "WhiteboardVoteSession" and "WhiteboardVote" (quoted identifiers, camelCase
// columns). Every query is scoped by design id (and session id) so a caller can
// only ever touch a design they have been granted access to at the HTTP layer.
package whiteboard

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// DBTX is the query surface (satisfied by *pgxpool.Pool and pgx.Tx).
type DBTX interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Repo is the pgx-backed VoteRepo.
type Repo struct{ db DBTX }

// NewRepo builds the repository over a pgx pool/tx.
func NewRepo(db DBTX) *Repo { return &Repo{db: db} }

const sessionCols = `"id", "designId", "budgetPerUser", "anonymous", "revealed", "open", "createdById"`

func scanSession(row pgx.Row) (SessionRow, error) {
	var s SessionRow
	err := row.Scan(&s.ID, &s.DesignID, &s.BudgetPerUser, &s.Anonymous, &s.Revealed, &s.Open, &s.CreatedByID)
	return s, err
}

func (r *Repo) CreateSession(ctx context.Context, s SessionRow) (SessionRow, error) {
	const q = `INSERT INTO "WhiteboardVoteSession" ("id","designId","budgetPerUser","anonymous","revealed","open","createdById")
		VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6) RETURNING ` + sessionCols
	return scanSession(r.db.QueryRow(ctx, q, s.DesignID, s.BudgetPerUser, s.Anonymous, s.Revealed, s.Open, s.CreatedByID))
}

func (r *Repo) GetSession(ctx context.Context, designID, sessionID string) (SessionRow, error) {
	const q = `SELECT ` + sessionCols + ` FROM "WhiteboardVoteSession" WHERE "id" = $1 AND "designId" = $2`
	s, err := scanSession(r.db.QueryRow(ctx, q, sessionID, designID))
	if errors.Is(err, pgx.ErrNoRows) {
		return SessionRow{}, ErrNotFound
	}
	return s, err
}

func (r *Repo) SetSessionState(ctx context.Context, designID, sessionID string, open, revealed bool) (SessionRow, error) {
	const q = `UPDATE "WhiteboardVoteSession"
		SET "open" = $3, "revealed" = $4, "closedAt" = CASE WHEN $3 THEN NULL ELSE CURRENT_TIMESTAMP END
		WHERE "id" = $1 AND "designId" = $2 RETURNING ` + sessionCols
	s, err := scanSession(r.db.QueryRow(ctx, q, sessionID, designID, open, revealed))
	if errors.Is(err, pgx.ErrNoRows) {
		return SessionRow{}, ErrNotFound
	}
	return s, err
}

func (r *Repo) HasVote(ctx context.Context, sessionID, nodeID, userID string) (bool, error) {
	const q = `SELECT EXISTS(SELECT 1 FROM "WhiteboardVote" WHERE "sessionId" = $1 AND "nodeId" = $2 AND "userId" = $3)`
	var exists bool
	err := r.db.QueryRow(ctx, q, sessionID, nodeID, userID).Scan(&exists)
	return exists, err
}

func (r *Repo) CountUserVotes(ctx context.Context, sessionID, userID string) (int, error) {
	const q = `SELECT COUNT(*) FROM "WhiteboardVote" WHERE "sessionId" = $1 AND "userId" = $2`
	var n int
	err := r.db.QueryRow(ctx, q, sessionID, userID).Scan(&n)
	return n, err
}

func (r *Repo) InsertVote(ctx context.Context, sessionID, designID, nodeID, userID string, budget int) (bool, error) {
	// A single atomic statement enforces BOTH invariants the budget depends on:
	//  - the WHERE (SELECT count(*) ...) < budget caps the per-user row count, so
	//    two concurrent distinct-node casts can't both pass (the 2nd sees the 1st),
	//  - ON CONFLICT DO NOTHING keeps the unique (session,node,user) invariant for
	//    a same-node double-submit.
	// 0 rows affected means the cast lost the budget race (or duplicated a node).
	const q = `INSERT INTO "WhiteboardVote" ("id","sessionId","designId","nodeId","userId")
		SELECT gen_random_uuid(), $1, $2, $3, $4
		WHERE (SELECT COUNT(*) FROM "WhiteboardVote" WHERE "sessionId" = $1 AND "userId" = $4) < $5
		ON CONFLICT ("sessionId","nodeId","userId") DO NOTHING`
	tag, err := r.db.Exec(ctx, q, sessionID, designID, nodeID, userID, budget)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func (r *Repo) DeleteVote(ctx context.Context, sessionID, nodeID, userID string) error {
	const q = `DELETE FROM "WhiteboardVote" WHERE "sessionId" = $1 AND "nodeId" = $2 AND "userId" = $3`
	_, err := r.db.Exec(ctx, q, sessionID, nodeID, userID)
	return err
}

func (r *Repo) Votes(ctx context.Context, sessionID string) ([]CastRow, error) {
	const q = `SELECT "nodeId", "userId" FROM "WhiteboardVote" WHERE "sessionId" = $1`
	rows, err := r.db.Query(ctx, q, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CastRow
	for rows.Next() {
		var c CastRow
		if err := rows.Scan(&c.NodeID, &c.UserID); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
