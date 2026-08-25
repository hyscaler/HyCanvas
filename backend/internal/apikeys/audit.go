// API-key audit trail (F40 E08): every meaningful key-authed action (HTTP
// route or MCP tool) writes one row - key, workspace, user, surface, and the
// design it touched. Best-effort by design (an audit failure never fails the
// request), with retention enforced by the writer: at most once an hour, rows
// older than the window are pruned, so no background job is needed and the
// table cannot grow without bound.
package apikeys

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// auditRetention bounds how far back the trail reaches.
const auditRetention = 90 * 24 * time.Hour

// AuditEntry is one recorded key action, as the admin list endpoint returns it.
type AuditEntry struct {
	ID          string  `json:"id"`
	KeyID       string  `json:"keyId"`
	WorkspaceID string  `json:"workspaceId"`
	UserID      string  `json:"userId"`
	Surface     string  `json:"surface"`
	DesignID    *string `json:"designId"`
	At          string  `json:"at"`
}

// Audit records one key action. Best-effort: errors are swallowed (the
// request must not fail because auditing did), and the hourly prune rides
// along on the writer.
func (s *Service) Audit(ctx context.Context, key *KeyInfo, surface string, designID string) {
	if key == nil || surface == "" {
		return
	}
	var did *string
	if designID != "" {
		did = &designID
	}
	_, _ = s.db.Exec(ctx,
		`INSERT INTO "api_audit_log" (id, "key_id", "workspace_id", "user_id", surface, "design_id") VALUES ($1,$2,$3,$4,$5,$6)`,
		uuid.NewString(), key.ID, key.WorkspaceID, key.UserID, surface, did)
	s.maybePrune(ctx)
}

// maybePrune deletes rows past retention, at most once an hour per process.
func (s *Service) maybePrune(ctx context.Context) {
	now := time.Now()
	s.mu.Lock()
	if now.Sub(s.lastPrune) < time.Hour {
		s.mu.Unlock()
		return
	}
	s.lastPrune = now
	s.mu.Unlock()
	_, _ = s.db.Exec(ctx, `DELETE FROM "api_audit_log" WHERE "at" < $1`, now.Add(-auditRetention))
}

// AuditList returns the workspace's most recent key actions (admin surface).
func (s *Service) AuditList(ctx context.Context, workspaceID string, limit int) ([]AuditEntry, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	const q = `SELECT id, "key_id", "workspace_id", "user_id", surface, "design_id", "at"
		FROM "api_audit_log" WHERE "workspace_id" = $1 ORDER BY "at" DESC LIMIT $2`
	rows, err := s.db.Query(ctx, q, workspaceID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]AuditEntry, 0, limit)
	for rows.Next() {
		var e AuditEntry
		var at time.Time
		if err := rows.Scan(&e.ID, &e.KeyID, &e.WorkspaceID, &e.UserID, &e.Surface, &e.DesignID, &at); err != nil {
			return nil, err
		}
		e.At = at.UTC().Format(time.RFC3339Nano)
		out = append(out, e)
	}
	return out, rows.Err()
}
