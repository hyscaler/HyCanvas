// Request access (doc 17 sharing): a signed-in user who cannot open a design
// asks its owners/admins for access. A pending AccessRequest row is the ask;
// approving it creates a DesignGrant, denying it records the decision. The
// requester and the adjudicators are notified through the engagement hook.
package sharing

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/authz"
)

// AccessRequestRow is a row of "access_requests".
type AccessRequestRow struct {
	ID         string
	DesignID   string
	UserID     string
	Mode       authz.AccessMode
	Message    *string
	Status     string
	ResolvedBy *string
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// AccessRequestView is the API view of a pending access request.
type AccessRequestView struct {
	ID        string           `json:"id"`
	DesignID  string           `json:"designId"`
	Requester Principal        `json:"requester"`
	Mode      authz.AccessMode `json:"mode"`
	Message   string           `json:"message,omitempty"`
	Status    string           `json:"status"`
	CreatedAt string           `json:"createdAt"`
}

const accessReqCols = `id, "design_id", "user_id", mode, message, status, "resolved_by_id", "created_at", "updated_at"`

func scanAccessReq(row pgx.Row) (AccessRequestRow, error) {
	var r AccessRequestRow
	var mode string
	err := row.Scan(&r.ID, &r.DesignID, &r.UserID, &mode, &r.Message, &r.Status, &r.ResolvedBy, &r.CreatedAt, &r.UpdatedAt)
	r.Mode = authz.AccessMode(mode)
	return r, err
}

func accessReqView(r AccessRequestRow) AccessRequestView {
	v := AccessRequestView{
		ID: r.ID, DesignID: r.DesignID, Requester: Principal{Kind: "user", ID: r.UserID},
		Mode: r.Mode, Status: r.Status, CreatedAt: r.CreatedAt.UTC().Format(time.RFC3339Nano),
	}
	if r.Message != nil {
		v.Message = *r.Message
	}
	return v
}

// --- repository ----------------------------------------------------------

func (s *Service) findPendingRequest(ctx context.Context, designID, userID string) (AccessRequestRow, error) {
	r, err := scanAccessReq(s.db.QueryRow(ctx,
		`SELECT `+accessReqCols+` FROM "access_requests" WHERE "design_id"=$1 AND "user_id"=$2 AND status='pending'`,
		designID, userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return AccessRequestRow{}, ErrNotFound
	}
	return r, err
}

func (s *Service) getAccessRequest(ctx context.Context, id string) (AccessRequestRow, error) {
	r, err := scanAccessReq(s.db.QueryRow(ctx, `SELECT `+accessReqCols+` FROM "access_requests" WHERE id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return AccessRequestRow{}, ErrNotFound
	}
	return r, err
}

func (s *Service) insertAccessRequest(ctx context.Context, designID, userID string, mode authz.AccessMode, message *string) (AccessRequestRow, error) {
	// Upsert against the pending partial-unique index so a concurrent double
	// request resolves in place instead of failing the constraint (a raw 500).
	const q = `INSERT INTO "access_requests" (id,"design_id","user_id",mode,message,status)
		VALUES ($1,$2,$3,$4,$5,'pending')
		ON CONFLICT ("design_id","user_id") WHERE status = 'pending'
		DO UPDATE SET mode = EXCLUDED.mode, message = EXCLUDED.message, "updated_at" = now()
		RETURNING ` + accessReqCols
	return scanAccessReq(s.db.QueryRow(ctx, q, uuid.NewString(), designID, userID, string(mode), message))
}

func (s *Service) refreshAccessRequest(ctx context.Context, id string, mode authz.AccessMode, message *string) (AccessRequestRow, error) {
	const q = `UPDATE "access_requests" SET mode=$2, message=$3, status='pending', "resolved_by_id"=NULL, "updated_at"=now()
		WHERE id=$1 RETURNING ` + accessReqCols
	return scanAccessReq(s.db.QueryRow(ctx, q, id, string(mode), message))
}

func (s *Service) setAccessRequestStatus(ctx context.Context, id, status, resolvedBy string) (AccessRequestRow, error) {
	const q = `UPDATE "access_requests" SET status=$2, "resolved_by_id"=$3, "updated_at"=now()
		WHERE id=$1 RETURNING ` + accessReqCols
	r, err := scanAccessReq(s.db.QueryRow(ctx, q, id, status, resolvedBy))
	if errors.Is(err, pgx.ErrNoRows) {
		return AccessRequestRow{}, ErrNotFound
	}
	return r, err
}

func (s *Service) listPendingRequests(ctx context.Context, designID string) ([]AccessRequestRow, error) {
	rows, err := s.db.Query(ctx, `SELECT `+accessReqCols+` FROM "access_requests" WHERE "design_id"=$1 AND status='pending' ORDER BY "created_at"`, designID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AccessRequestRow
	for rows.Next() {
		r, err := scanAccessReq(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ownersAndAdmins returns the active owner/admin user ids of a workspace (the
// people who can adjudicate an access request).
func (s *Service) ownersAndAdmins(ctx context.Context, workspaceID string) ([]string, error) {
	rows, err := s.db.Query(ctx,
		`SELECT "user_id"::text FROM "workspace_members" WHERE "workspace_id"=$1 AND status='ACTIVE' AND role IN ('OWNER','ADMIN')`,
		workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// --- service -------------------------------------------------------------

// RequestAccess records (or refreshes) the caller's pending request to open a
// design and notifies its owners/admins (and creator). A caller who already
// resolves to the requested mode or higher is rejected (nothing to request).
func (s *Service) RequestAccess(ctx context.Context, designID, userID, modeStr, message string) (AccessRequestView, error) {
	workspaceID, err := s.workspaceOf(ctx, designID)
	if err != nil {
		return AccessRequestView{}, ErrNotFound
	}
	mode, err := assertMode(modeStr)
	if err != nil {
		return AccessRequestView{}, err
	}
	// If the caller already has at least the requested access, there is nothing
	// to request. authz.Resolve defaults Mode to "view" even for a caller with NO
	// capabilities, so gate on an actual view capability first; otherwise a
	// no-access user requesting the default "view" tier would be wrongly rejected.
	if cur, err := s.resolveForUser(ctx, designID, userID, "", nil); err == nil && has(cur, authz.CapView) && accessAtLeast(cur.Mode, mode) {
		return AccessRequestView{}, ErrBadRequest
	}

	var msg *string
	if m := strings.TrimSpace(message); m != "" {
		msg = &m
	}
	var row AccessRequestRow
	if existing, ferr := s.findPendingRequest(ctx, designID, userID); ferr == nil {
		row, err = s.refreshAccessRequest(ctx, existing.ID, mode, msg)
	} else {
		row, err = s.insertAccessRequest(ctx, designID, userID, mode, msg)
	}
	if err != nil {
		return AccessRequestView{}, err
	}

	// Notify the adjudicators (owners/admins + creator), de-duplicated, skipping
	// the requester themselves.
	targets := map[string]bool{}
	if admins, aerr := s.ownersAndAdmins(ctx, workspaceID); aerr == nil {
		for _, id := range admins {
			targets[id] = true
		}
	}
	if creator, ok := s.designCreator(ctx, designID); ok {
		targets[creator] = true
	}
	delete(targets, userID)
	for id := range targets {
		s.notify(ctx, userID, id, "access_request", designID, map[string]any{"mode": string(mode), "requestId": row.ID})
	}
	return s.enrichRequest(ctx, accessReqView(row)), nil
}

// ListAccessRequests returns the pending requests for a design (share-gated).
func (s *Service) ListAccessRequests(ctx context.Context, designID, userID string) ([]AccessRequestView, error) {
	if err := s.assertCanShare(ctx, designID, userID); err != nil {
		return nil, err
	}
	rows, err := s.listPendingRequests(ctx, designID)
	if err != nil {
		return nil, err
	}
	out := make([]AccessRequestView, 0, len(rows))
	for _, r := range rows {
		out = append(out, accessReqView(r))
	}
	s.enrichRequests(ctx, out)
	return out, nil
}

// ResolveAccessRequest approves (creating/updating a grant) or denies a pending
// request and notifies the requester (share-gated). mode overrides the
// requested mode on approval when non-nil.
func (s *Service) ResolveAccessRequest(ctx context.Context, requestID, userID string, approve bool, mode *string) (AccessRequestView, error) {
	req, err := s.getAccessRequest(ctx, requestID)
	if err != nil {
		return AccessRequestView{}, err
	}
	if err := s.assertCanShare(ctx, req.DesignID, userID); err != nil {
		return AccessRequestView{}, err
	}
	if req.Status != "pending" {
		return AccessRequestView{}, ErrBadRequest
	}

	if !approve {
		row, err := s.setAccessRequestStatus(ctx, requestID, "denied", userID)
		if err != nil {
			return AccessRequestView{}, err
		}
		s.notify(ctx, userID, req.UserID, "access_decision", req.DesignID, map[string]any{"decision": "deny"})
		return s.enrichRequest(ctx, accessReqView(row)), nil
	}

	grantMode := req.Mode
	if mode != nil {
		m, err := assertMode(*mode)
		if err != nil {
			return AccessRequestView{}, err
		}
		grantMode = m
	}
	// Grant the requester (upsert: re-resolving updates their access in place).
	uid := req.UserID
	if existing, ferr := s.findGrantForPrincipal(ctx, req.DesignID, &uid, nil); ferr == nil {
		if _, err := s.updateGrant(ctx, existing.ID, &grantMode, nil, false); err != nil {
			return AccessRequestView{}, err
		}
	} else if _, err := s.createGrant(ctx, GrantRow{DesignID: req.DesignID, UserID: &uid, Mode: grantMode, InvitedBy: &userID}); err != nil {
		return AccessRequestView{}, err
	}
	row, err := s.setAccessRequestStatus(ctx, requestID, "granted", userID)
	if err != nil {
		return AccessRequestView{}, err
	}
	s.emit(ctx, req.DesignID, userID, "share", map[string]any{"op": "added", "mode": string(grantMode), "principalKind": "user"})
	s.notify(ctx, userID, req.UserID, "access_decision", req.DesignID, map[string]any{"decision": "approve", "mode": string(grantMode)})
	return s.enrichRequest(ctx, accessReqView(row)), nil
}

// accessAtLeast reports whether mode a is at least as permissive as b.
func accessAtLeast(a, b authz.AccessMode) bool {
	rank := map[authz.AccessMode]int{authz.ModeView: 1, authz.ModeComment: 2, authz.ModeEdit: 3}
	return rank[a] >= rank[b] && rank[a] > 0
}

func (s *Service) enrichRequest(ctx context.Context, v AccessRequestView) AccessRequestView {
	if name, email, ok := s.userInfo(ctx, v.Requester.ID); ok {
		v.Requester.Name, v.Requester.Email = name, email
	}
	return v
}

func (s *Service) enrichRequests(ctx context.Context, list []AccessRequestView) {
	for i := range list {
		list[i] = s.enrichRequest(ctx, list[i])
	}
}
