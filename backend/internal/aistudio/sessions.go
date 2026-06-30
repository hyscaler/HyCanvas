package aistudio

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// DBTX is the database surface this package needs; *pgxpool.Pool and pgx.Tx both
// satisfy it (so tests can run in a rolled-back transaction).
type DBTX interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// AiSession is a conversation thread scoped to one design (FR-9 persistence).
type AiSession struct {
	ID          string    `json:"id"`
	WorkspaceID string    `json:"workspaceId"`
	DesignID    string    `json:"designId"`
	CreatedAt   time.Time `json:"createdAt"`
}

// AiTurn is one message in a session, carrying an optional plan + provenance
// (FR-27) so a generation is reproducible/auditable.
type AiTurn struct {
	ID         string          `json:"id"`
	SessionID  string          `json:"sessionId"`
	Role       string          `json:"role"` // "user" | "assistant"
	Text       string          `json:"text"`
	Plan       json.RawMessage `json:"plan,omitempty"`
	Provenance json.RawMessage `json:"provenance,omitempty"`
	CreatedAt  time.Time       `json:"createdAt"`
}

type sessionStore struct {
	db DBTX
}

func (s *sessionStore) createSession(ctx context.Context, workspaceID, designID string) (AiSession, error) {
	const q = `INSERT INTO "ai_sessions" ("workspace_id","design_id") VALUES ($1,$2) RETURNING "id","created_at"`
	var out AiSession
	out.WorkspaceID = workspaceID
	out.DesignID = designID
	err := s.db.QueryRow(ctx, q, workspaceID, designID).Scan(&out.ID, &out.CreatedAt)
	return out, err
}

func (s *sessionStore) listSessions(ctx context.Context, workspaceID, designID string) ([]AiSession, error) {
	const q = `SELECT "id","workspace_id","design_id","created_at" FROM "ai_sessions" WHERE "workspace_id"=$1 AND "design_id"=$2 ORDER BY "created_at" DESC`
	rows, err := s.db.Query(ctx, q, workspaceID, designID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AiSession{}
	for rows.Next() {
		var a AiSession
		if err := rows.Scan(&a.ID, &a.WorkspaceID, &a.DesignID, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// sessionInScope verifies a session belongs to BOTH the workspace and the design
// it is being accessed through (isolation precise to the design-scoped route, not
// just the workspace).
func (s *sessionStore) sessionInScope(ctx context.Context, sessionID, workspaceID, designID string) (bool, error) {
	const q = `SELECT 1 FROM "ai_sessions" WHERE "id"=$1 AND "workspace_id"=$2 AND "design_id"=$3`
	var one int
	err := s.db.QueryRow(ctx, q, sessionID, workspaceID, designID).Scan(&one)
	if err == pgx.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

func (s *sessionStore) appendTurn(ctx context.Context, t AiTurn) (AiTurn, error) {
	const q = `INSERT INTO "ai_turns" ("session_id","role","text","plan","provenance") VALUES ($1,$2,$3,$4,$5) RETURNING "id","created_at"`
	var plan, prov any
	if len(t.Plan) > 0 {
		plan = string(t.Plan)
	}
	if len(t.Provenance) > 0 {
		prov = string(t.Provenance)
	}
	err := s.db.QueryRow(ctx, q, t.SessionID, t.Role, t.Text, plan, prov).Scan(&t.ID, &t.CreatedAt)
	return t, err
}

func (s *sessionStore) listTurns(ctx context.Context, sessionID string) ([]AiTurn, error) {
	const q = `SELECT "id","session_id","role","text",COALESCE("plan"::text,''),COALESCE("provenance"::text,''),"created_at" FROM "ai_turns" WHERE "session_id"=$1 ORDER BY "created_at" ASC`
	rows, err := s.db.Query(ctx, q, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AiTurn{}
	for rows.Next() {
		var t AiTurn
		var plan, prov string
		if err := rows.Scan(&t.ID, &t.SessionID, &t.Role, &t.Text, &plan, &prov, &t.CreatedAt); err != nil {
			return nil, err
		}
		if plan != "" {
			t.Plan = json.RawMessage(plan)
		}
		if prov != "" {
			t.Provenance = json.RawMessage(prov)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// Public session API (nil-safe: returns ErrNoStore when history is disabled).

// ErrNoStore is returned by session methods when the service was built without a DB.
var ErrNoStore = errStr("session history is not available")

type errStr string

func (e errStr) Error() string { return string(e) }

// CreateSession starts a new conversation thread for a design.
func (s *Service) CreateSession(ctx context.Context, workspaceID, designID string) (AiSession, error) {
	if s.store == nil {
		return AiSession{}, ErrNoStore
	}
	return s.store.createSession(ctx, workspaceID, designID)
}

// ListSessions returns a design's sessions, newest first.
func (s *Service) ListSessions(ctx context.Context, workspaceID, designID string) ([]AiSession, error) {
	if s.store == nil {
		return nil, ErrNoStore
	}
	return s.store.listSessions(ctx, workspaceID, designID)
}

// AppendTurn records a message in a session after verifying the session belongs
// to the workspace AND the design it is accessed through (isolation at the query
// layer, precise to the design-scoped route).
func (s *Service) AppendTurn(ctx context.Context, workspaceID, designID string, t AiTurn) (AiTurn, error) {
	if s.store == nil {
		return AiTurn{}, ErrNoStore
	}
	ok, err := s.store.sessionInScope(ctx, t.SessionID, workspaceID, designID)
	if err != nil {
		return AiTurn{}, err
	}
	if !ok {
		return AiTurn{}, ErrNoStore
	}
	return s.store.appendTurn(ctx, t)
}

// ListTurns returns a session's messages after verifying it belongs to the
// workspace AND the design it is accessed through.
func (s *Service) ListTurns(ctx context.Context, workspaceID, designID, sessionID string) ([]AiTurn, error) {
	if s.store == nil {
		return nil, ErrNoStore
	}
	ok, err := s.store.sessionInScope(ctx, sessionID, workspaceID, designID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, ErrNoStore
	}
	return s.store.listTurns(ctx, sessionID)
}
