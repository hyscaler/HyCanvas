// Package approvals ports the NestJS approval-workflows module (doc 17 slice C:
// FR-10, FR-11). It is the single place approvals are read and written, gated by
// the sharing access resolver so every check is server-side:
//   - request needs `share` OR `edit`, and no active approval may already exist,
//   - decide needs `approve` AND being a selected approver,
//   - reopen needs `manage-roles` OR being a selected approver,
//   - read needs `view`.
//
// Policy resolution (FR-10): "any" -> first approve grants; "all" -> every
// selected approver must approve. A single reject rejects the whole approval. On
// grant the design becomes approval-LOCKED, which sharing.Resolve honors by
// capping every editor to comment/view (FR-11); reopen clears it.
//
// Deferred vs the Node original: the live RealtimeService.refreshRoles call
// (F16 AC-9) and engagement activity/notifications (slice D) are optional hooks
// (nil-safe), since realtime stays on the TS service and engagement is not yet
// ported.
package approvals

import (
	"context"
	"errors"
	"strings"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/authz"
	"hycanvas/backend/internal/sharing"
)

const (
	maxApprovers = 50
	maxNote      = 2000
)

// Errors map to RFC 7807 statuses at the HTTP layer.
var (
	ErrForbidden  = errors.New("forbidden")
	ErrNotFound   = errors.New("not found")
	ErrBadRequest = errors.New("bad request")
	ErrConflict   = errors.New("conflict")
)

// Access resolves a caller's per-design capabilities (sharing slice A).
type Access interface {
	GetAccess(ctx context.Context, designID, userID string) (sharing.DesignAccessView, error)
}

// Accounts resolves display names for the approval banner.
type Accounts interface {
	GetUserByID(ctx context.Context, id string) (*accounts.AuthUser, error)
}

// RoleRefresher pushes a live role refresh to connected clients after a
// lock/unlock flip (F16 AC-9). Nil hook = skip (realtime stays on the TS side).
type RoleRefresher interface {
	RefreshRoles(ctx context.Context, designID, reason string)
}

// Engagement mirrors approval activity into the unified feed + bell (slice D).
// Nil hook = skip.
type Engagement interface {
	EmitActivity(ctx context.Context, designID, actorID, kind string, payload map[string]any)
	Notify(ctx context.Context, actorID, targetUserID, typ, designID string, payload map[string]any)
}

// Service is the approvals module.
type Service struct {
	db         DBTX
	access     Access
	accounts   Accounts
	roles      RoleRefresher
	engagement Engagement
}

// NewService wires the approvals service. roles and engagement may be nil.
func NewService(db DBTX, access Access, acct Accounts, roles RoleRefresher, engagement Engagement) *Service {
	return &Service{db: db, access: access, accounts: acct, roles: roles, engagement: engagement}
}

// --- view types (match the NestJS JSON exactly) -------------------------

type Person struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type DecisionView struct {
	ApproverID   string  `json:"approverId"`
	ApproverName string  `json:"approverName"`
	Decision     string  `json:"decision"`
	Note         *string `json:"note"`
	DecidedAt    string  `json:"decidedAt"`
}

type Actions struct {
	CanRequest bool `json:"canRequest"`
	CanDecide  bool `json:"canDecide"`
	CanReopen  bool `json:"canReopen"`
}

type ApprovalView struct {
	ID            string         `json:"id"`
	DesignID      string         `json:"designId"`
	Requester     Person         `json:"requester"`
	Policy        string         `json:"policy"`
	Status        string         `json:"status"`
	Approvers     []Person       `json:"approvers"`
	Decisions     []DecisionView `json:"decisions"`
	ApprovedCount int            `json:"approvedCount"`
	ApproverCount int            `json:"approverCount"`
	CreatedAt     string         `json:"createdAt"`
	DecidedAt     *string        `json:"decidedAt"`
}

type DesignApprovalView struct {
	Approval *ApprovalView `json:"approval"`
	Locked   bool          `json:"locked"`
	Actions  Actions       `json:"actions"`
}

// --- validation ----------------------------------------------------------

func assertPolicy(policy string) (string, error) {
	if policy != "any" && policy != "all" {
		return "", ErrBadRequest
	}
	return policy, nil
}

func assertDecision(decision string) (string, error) {
	if decision != "approve" && decision != "reject" {
		return "", ErrBadRequest
	}
	return decision, nil
}

func assertNote(note *string) (*string, error) {
	if note == nil {
		return nil, nil
	}
	if len(*note) > maxNote {
		return nil, ErrBadRequest
	}
	trimmed := strings.TrimSpace(*note)
	if trimmed == "" {
		return nil, nil
	}
	return &trimmed, nil
}

func hasCap(access sharing.DesignAccessView, c authz.Capability) bool {
	for _, x := range access.Capabilities {
		if x == c {
			return true
		}
	}
	return false
}

// normalizeApprovers dedupes + trims the approver id list (the requester may
// include themselves).
func normalizeApprovers(raw []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, id := range raw {
		t := strings.TrimSpace(id)
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
	}
	return out
}

// --- name resolution -----------------------------------------------------

func (s *Service) nameOf(ctx context.Context, userID string) string {
	u, err := s.accounts.GetUserByID(ctx, userID)
	if err != nil || u == nil || u.Name == "" {
		return "Unknown"
	}
	return u.Name
}

func (s *Service) person(ctx context.Context, userID string) Person {
	return Person{ID: userID, Name: s.nameOf(ctx, userID)}
}

// --- request (FR-10) -----------------------------------------------------

// RequestInput is the request-approval payload.
type RequestInput struct {
	ApproverIDs []string
	Policy      string
}

func (s *Service) Request(ctx context.Context, designID, userID string, in RequestInput) (DesignApprovalView, error) {
	access, err := s.access.GetAccess(ctx, designID, userID)
	if err != nil {
		return DesignApprovalView{}, err
	}
	if !hasCap(access, authz.CapShare) && !hasCap(access, authz.CapEdit) {
		return DesignApprovalView{}, ErrForbidden
	}
	policy, err := assertPolicy(in.Policy)
	if err != nil {
		return DesignApprovalView{}, err
	}
	approverIDs := normalizeApprovers(in.ApproverIDs)
	if len(approverIDs) == 0 {
		return DesignApprovalView{}, ErrBadRequest
	}
	if len(approverIDs) > maxApprovers {
		return DesignApprovalView{}, ErrBadRequest
	}
	active, err := s.getActiveApproval(ctx, designID)
	if err != nil {
		return DesignApprovalView{}, err
	}
	if active != nil {
		return DesignApprovalView{}, ErrConflict
	}
	// Every approver must be able to open the design (FR-10 edge case).
	for _, aid := range approverIDs {
		a, err := s.access.GetAccess(ctx, designID, aid)
		if err != nil {
			return DesignApprovalView{}, err
		}
		if !hasCap(a, authz.CapView) {
			return DesignApprovalView{}, ErrBadRequest
		}
	}
	row, err := s.createApproval(ctx, designID, userID, policy, approverIDs)
	if err != nil {
		return DesignApprovalView{}, err
	}
	_ = s.recordEvent(ctx, row.ID, designID, &userID, "request", map[string]any{"policy": policy, "approverIds": approverIDs})
	s.emit(ctx, designID, userID, "approval_request", map[string]any{"approvalId": row.ID, "policy": policy})
	for _, aid := range approverIDs {
		s.notify(ctx, userID, aid, "approval_request", designID, map[string]any{"approvalId": row.ID})
	}
	// A fresh pending approval does not lock yet, so no role refresh.
	return s.viewFor(ctx, designID, userID)
}

// --- decide (FR-10, FR-11) ----------------------------------------------

// DecideInput is the decide payload.
type DecideInput struct {
	Decision string
	Note     *string
}

func (s *Service) Decide(ctx context.Context, approvalID, userID string, in DecideInput) (DesignApprovalView, error) {
	approval, err := s.getApproval(ctx, approvalID)
	if err != nil {
		return DesignApprovalView{}, err
	}
	if approval.Status != "pending" {
		return DesignApprovalView{}, ErrConflict
	}
	access, err := s.access.GetAccess(ctx, approval.DesignID, userID)
	if err != nil {
		return DesignApprovalView{}, err
	}
	if !hasCap(access, authz.CapApprove) {
		return DesignApprovalView{}, ErrForbidden
	}
	if !contains(approval.ApproverIDs, userID) {
		return DesignApprovalView{}, ErrForbidden
	}
	decision, err := assertDecision(in.Decision)
	if err != nil {
		return DesignApprovalView{}, err
	}
	note, err := assertNote(in.Note)
	if err != nil {
		return DesignApprovalView{}, err
	}
	if err := s.upsertDecision(ctx, approval.ID, userID, decision, note); err != nil {
		return DesignApprovalView{}, err
	}
	_ = s.recordEvent(ctx, approval.ID, approval.DesignID, &userID, "decision", map[string]any{"decision": decision, "note": note})
	s.emit(ctx, approval.DesignID, userID, "approval_decision", map[string]any{"approvalId": approval.ID, "decision": decision})
	s.notify(ctx, userID, approval.RequesterID, "approval_decision", approval.DesignID, map[string]any{"approvalId": approval.ID, "decision": decision})

	decisions, err := s.listDecisions(ctx, approval.ID)
	if err != nil {
		return DesignApprovalView{}, err
	}
	switch resolveOutcome(approval.Policy, approval.ApproverIDs, decisions) {
	case "approved":
		if err := s.updateApprovalStatus(ctx, approval.ID, "approved", true); err != nil {
			return DesignApprovalView{}, err
		}
		s.refreshRoles(ctx, approval.DesignID, "approval-locked")
	case "rejected":
		if err := s.updateApprovalStatus(ctx, approval.ID, "rejected", true); err != nil {
			return DesignApprovalView{}, err
		}
	}
	return s.viewFor(ctx, approval.DesignID, userID)
}

// --- reopen (FR-11) ------------------------------------------------------

func (s *Service) Reopen(ctx context.Context, approvalID, userID string) (DesignApprovalView, error) {
	approval, err := s.getApproval(ctx, approvalID)
	if err != nil {
		return DesignApprovalView{}, err
	}
	if approval.Status != "approved" {
		return DesignApprovalView{}, ErrConflict
	}
	access, err := s.access.GetAccess(ctx, approval.DesignID, userID)
	if err != nil {
		return DesignApprovalView{}, err
	}
	isApprover := contains(approval.ApproverIDs, userID)
	if !hasCap(access, authz.CapManageRoles) && !isApprover {
		return DesignApprovalView{}, ErrForbidden
	}
	if err := s.updateApprovalStatus(ctx, approval.ID, "reopened", true); err != nil {
		return DesignApprovalView{}, err
	}
	_ = s.recordEvent(ctx, approval.ID, approval.DesignID, &userID, "reopen", nil)
	s.emit(ctx, approval.DesignID, userID, "reopen", map[string]any{"approvalId": approval.ID})
	s.refreshRoles(ctx, approval.DesignID, "approval-reopened")
	return s.viewFor(ctx, approval.DesignID, userID)
}

// --- read (FR-10, FR-11) -------------------------------------------------

func (s *Service) GetForDesign(ctx context.Context, designID, userID string) (DesignApprovalView, error) {
	access, err := s.access.GetAccess(ctx, designID, userID)
	if err != nil {
		return DesignApprovalView{}, err
	}
	if !hasCap(access, authz.CapView) {
		return DesignApprovalView{}, ErrNotFound
	}
	return s.viewFor(ctx, designID, userID)
}

func (s *Service) viewFor(ctx context.Context, designID, userID string) (DesignApprovalView, error) {
	active, err := s.getActiveApproval(ctx, designID)
	if err != nil {
		return DesignApprovalView{}, err
	}
	latest := active
	if latest == nil {
		latest, err = s.getLatestApproval(ctx, designID)
		if err != nil {
			return DesignApprovalView{}, err
		}
	}
	locked := active != nil && active.Status == "approved"

	var approvalView *ApprovalView
	if latest != nil {
		v, err := s.approvalView(ctx, *latest)
		if err != nil {
			return DesignApprovalView{}, err
		}
		approvalView = &v
	}
	access, err := s.access.GetAccess(ctx, designID, userID)
	if err != nil {
		return DesignApprovalView{}, err
	}
	return DesignApprovalView{Approval: approvalView, Locked: locked, Actions: actionsFor(userID, access, active)}, nil
}

func actionsFor(userID string, access sharing.DesignAccessView, active *ApprovalRow) Actions {
	isApprover := active != nil && contains(active.ApproverIDs, userID)
	return Actions{
		CanRequest: active == nil && (hasCap(access, authz.CapShare) || hasCap(access, authz.CapEdit)),
		CanDecide:  active != nil && active.Status == "pending" && isApprover && hasCap(access, authz.CapApprove),
		CanReopen:  active != nil && active.Status == "approved" && (hasCap(access, authz.CapManageRoles) || isApprover),
	}
}

func (s *Service) approvalView(ctx context.Context, row ApprovalRow) (ApprovalView, error) {
	decisions, err := s.listDecisions(ctx, row.ID)
	if err != nil {
		return ApprovalView{}, err
	}
	approvers := make([]Person, 0, len(row.ApproverIDs))
	for _, id := range row.ApproverIDs {
		approvers = append(approvers, s.person(ctx, id))
	}
	decisionViews := make([]DecisionView, 0, len(decisions))
	approvedCount := 0
	for _, d := range decisions {
		if d.Decision == "approve" {
			approvedCount++
		}
		decisionViews = append(decisionViews, DecisionView{
			ApproverID: d.ApproverID, ApproverName: s.nameOf(ctx, d.ApproverID),
			Decision: d.Decision, Note: d.Note, DecidedAt: d.DecidedAt.UTC().Format(isoFmt),
		})
	}
	var decidedAt *string
	if row.DecidedAt != nil {
		v := row.DecidedAt.UTC().Format(isoFmt)
		decidedAt = &v
	}
	return ApprovalView{
		ID: row.ID, DesignID: row.DesignID, Requester: s.person(ctx, row.RequesterID),
		Policy: row.Policy, Status: row.Status, Approvers: approvers, Decisions: decisionViews,
		ApprovedCount: approvedCount, ApproverCount: len(row.ApproverIDs),
		CreatedAt: row.CreatedAt.UTC().Format(isoFmt), DecidedAt: decidedAt,
	}, nil
}

// resolveOutcome is the pure policy resolution (FR-10): a single reject fails;
// "any" needs one approve; "all" needs every selected approver to approve.
// Decisions from non-approvers are ignored defensively.
func resolveOutcome(policy string, approverIDs []string, decisions []DecisionRow) string {
	approverSet := map[string]bool{}
	for _, id := range approverIDs {
		approverSet[id] = true
	}
	approvedBy := map[string]bool{}
	for _, d := range decisions {
		if !approverSet[d.ApproverID] {
			continue
		}
		if d.Decision == "reject" {
			return "rejected"
		}
		if d.Decision == "approve" {
			approvedBy[d.ApproverID] = true
		}
	}
	if policy == "any" {
		if len(approvedBy) >= 1 {
			return "approved"
		}
		return "pending"
	}
	for _, id := range approverIDs {
		if !approvedBy[id] {
			return "pending"
		}
	}
	return "approved"
}

// --- hooks (nil-safe) ----------------------------------------------------

func (s *Service) refreshRoles(ctx context.Context, designID, reason string) {
	if s.roles != nil {
		s.roles.RefreshRoles(ctx, designID, reason)
	}
}

func (s *Service) emit(ctx context.Context, designID, actorID, kind string, payload map[string]any) {
	if s.engagement != nil {
		s.engagement.EmitActivity(ctx, designID, actorID, kind, payload)
	}
}

func (s *Service) notify(ctx context.Context, actorID, targetUserID, typ, designID string, payload map[string]any) {
	if s.engagement != nil {
		s.engagement.Notify(ctx, actorID, targetUserID, typ, designID, payload)
	}
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}
