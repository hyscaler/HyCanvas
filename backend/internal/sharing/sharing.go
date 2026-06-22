// Package sharing ports the NestJS sharing + permissions module (doc 17 slice
// A: FR-5..FR-9, FR-15). It is the single place per-design access is resolved
// (delegating the pure rule to internal/authz) and the only writer of grants,
// share links, and custom roles. Capability-gated: only callers with the
// `share` capability may change sharing; `manage-roles` gates custom roles.
// Workspace isolation is inherited from the design's owning workspace, never a
// client-supplied header.
//
// Deferred vs the Node original: engagement activity/notifications (slice D)
// are emitted through an optional Engagement hook (no-op until that module is
// ported), and approval-lock state comes from an optional ApprovalLock hook
// (false until the approvals module is ported). Both are nil-safe.
package sharing

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"hycanvas/backend/internal/auth/secrets"
	"hycanvas/backend/internal/authz"
)

// DBTX is the query surface (satisfied by *pgxpool.Pool and pgx.Tx).
type DBTX interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Persistence resolves a design to its owning workspace (doc 04).
type Persistence interface {
	GetWorkspaceID(ctx context.Context, designID string) (string, error)
}

// Engagement records share/link/role activity and notifies invited users
// (slice D, best-effort). Nil hook = skip; never blocks the mutation.
type Engagement interface {
	EmitActivity(ctx context.Context, designID, actorID, kind string, payload map[string]any)
	Notify(ctx context.Context, actorID, targetUserID, typ, designID string, payload map[string]any)
}

// ApprovalLock reports whether a design is approval-locked (FR-11). Nil hook =
// never locked.
type ApprovalLock interface {
	IsApprovalLocked(ctx context.Context, designID string) (bool, error)
}

// Files loads a design's current file for the public link-file route (FR-15).
// Optional (attached via WithFiles); nil = the /file route reports not-found.
type Files interface {
	LoadFileForDesign(ctx context.Context, designID string) (any, error)
}

// Errors map to RFC 7807 statuses at the HTTP layer.
var (
	ErrForbidden     = errors.New("forbidden")
	ErrNotFound      = errors.New("not found")
	ErrBadRequest    = errors.New("bad request")
	ErrLinkGone      = errors.New("link expired")
	ErrLinkPassword  = errors.New("link password required")
	ErrLinkSigninReq = errors.New("link sign-in required")
	ErrLinkNotAvail  = errors.New("link no longer available")
)

const linkTokenBytes = 24 // 192 bits of entropy

var accessModes = map[authz.AccessMode]bool{authz.ModeView: true, authz.ModeComment: true, authz.ModeEdit: true}

var capabilitySet = map[authz.Capability]bool{
	authz.CapView: true, authz.CapComment: true, authz.CapEdit: true, authz.CapShare: true,
	authz.CapApprove: true, authz.CapManageRoles: true, authz.CapManageBrand: true, authz.CapDelete: true,
}

// Service is the sharing module.
type Service struct {
	db         DBTX
	persist    Persistence
	engagement Engagement
	locks      ApprovalLock
	files      Files
}

// NewService wires the sharing service. engagement and locks may be nil.
func NewService(db DBTX, persist Persistence, engagement Engagement, locks ApprovalLock) *Service {
	return &Service{db: db, persist: persist, engagement: engagement, locks: locks}
}

// WithFiles attaches the design-file loader, enabling the public link-file route
// (FR-15). Returns the same service for chaining.
func (s *Service) WithFiles(f Files) *Service {
	s.files = f
	return s
}

// ResolvedLinkFile is the public link-file result: the resolved link plus the
// design's current file for a read-only open (FR-15).
type ResolvedLinkFile struct {
	DesignID string           `json:"designId"`
	Mode     authz.AccessMode `json:"mode"`
	File     any              `json:"file"`
}

// ResolveLinkFile validates a share link and returns the design's current file
// for an anonymous read-only open (FR-15).
func (s *Service) ResolveLinkFile(ctx context.Context, token string, opts ResolveLinkOpts) (ResolvedLinkFile, error) {
	resolved, err := s.ResolveLink(ctx, token, opts)
	if err != nil {
		return ResolvedLinkFile{}, err
	}
	if s.files == nil {
		return ResolvedLinkFile{}, ErrNotFound
	}
	file, err := s.files.LoadFileForDesign(ctx, resolved.DesignID)
	if err != nil {
		return ResolvedLinkFile{}, ErrNotFound
	}
	return ResolvedLinkFile{DesignID: resolved.DesignID, Mode: resolved.Mode, File: file}, nil
}

// --- row + view types ----------------------------------------------------

type GrantRow struct {
	ID        string
	DesignID  string
	UserID    *string
	Email     *string
	Mode      authz.AccessMode
	RoleID    *string
	InvitedBy *string
	CreatedAt time.Time
}

type LinkRow struct {
	ID            string
	DesignID      string
	Token         string
	Mode          authz.AccessMode
	PasswordHash  *string
	ExpiresAt     *time.Time
	Disabled      bool
	RequireSignin bool
	CreatedByID   *string
	CreatedAt     time.Time
}

type RoleRow struct {
	ID           string
	WorkspaceID  string
	DesignID     *string
	Name         string
	Capabilities []authz.Capability
	CreatedAt    time.Time
}

// Principal identifies a grant target (a user id or an email).
type Principal struct {
	Kind string `json:"kind"` // "user" | "email"
	ID   string `json:"id"`
}

// ShareGrant is the API view of a grant.
type ShareGrant struct {
	ID        string           `json:"id"`
	DesignID  string           `json:"designId"`
	Principal Principal        `json:"principal"`
	Mode      authz.AccessMode `json:"mode"`
	RoleID    *string          `json:"roleId"`
	InvitedBy *string          `json:"invitedBy"`
	CreatedAt string           `json:"createdAt"`
}

// ShareLinkView is the API view of a share link (token included; never the hash).
type ShareLinkView struct {
	ID            string           `json:"id"`
	DesignID      string           `json:"designId"`
	Token         string           `json:"token"`
	Mode          authz.AccessMode `json:"mode"`
	HasPassword   bool             `json:"hasPassword"`
	ExpiresAt     *string          `json:"expiresAt"`
	Disabled      bool             `json:"disabled"`
	RequireSignin bool             `json:"requireSignin"`
	CreatedAt     string           `json:"createdAt"`
}

// CustomRoleView is the API view of a custom role.
type CustomRoleView struct {
	ID           string             `json:"id"`
	WorkspaceID  string             `json:"workspaceId"`
	DesignID     *string            `json:"designId"`
	Name         string             `json:"name"`
	Capabilities []authz.Capability `json:"capabilities"`
	Scope        string             `json:"scope"` // "design" | "workspace"
	CreatedAt    string             `json:"createdAt"`
}

// DesignAccessView is the caller's resolved access.
type DesignAccessView struct {
	Mode         authz.AccessMode   `json:"mode"`
	Capabilities []authz.Capability `json:"capabilities"`
}

// DesignSharingView is the Share dialog payload.
type DesignSharingView struct {
	MyAccess    DesignAccessView `json:"myAccess"`
	Grants      []ShareGrant     `json:"grants"`
	Links       []ShareLinkView  `json:"links"`
	CustomRoles []CustomRoleView `json:"customRoles"`
}

// ResolvedLink is the public link-resolution result.
type ResolvedLink struct {
	DesignID string           `json:"designId"`
	Mode     authz.AccessMode `json:"mode"`
}

// --- validation ----------------------------------------------------------

func assertMode(mode string) (authz.AccessMode, error) {
	m := authz.AccessMode(mode)
	if !accessModes[m] {
		return "", ErrBadRequest
	}
	return m, nil
}

func assertCapabilities(caps []string) ([]authz.Capability, error) {
	out := make([]authz.Capability, 0, len(caps))
	for _, c := range caps {
		cap := authz.Capability(c)
		if !capabilitySet[cap] {
			return nil, ErrBadRequest
		}
		out = append(out, cap)
	}
	return out, nil
}

func mintToken() (string, error) {
	b := make([]byte, linkTokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// --- low-level lookups ---------------------------------------------------

func (s *Service) workspaceOf(ctx context.Context, designID string) (string, error) {
	return s.persist.GetWorkspaceID(ctx, designID)
}

// membershipRole returns the caller's lowercase workspace role, or "" if not an
// active member.
func (s *Service) membershipRole(ctx context.Context, userID, workspaceID string) authz.WorkspaceRole {
	const q = `SELECT role FROM "WorkspaceMember"
		WHERE "workspaceId" = $1 AND "userId" = $2 AND status = 'ACTIVE'`
	var role string
	if err := s.db.QueryRow(ctx, q, workspaceID, userID).Scan(&role); err != nil {
		return ""
	}
	return authz.WorkspaceRole(strings.ToLower(role))
}

func (s *Service) userEmail(ctx context.Context, userID string) string {
	var email string
	if err := s.db.QueryRow(ctx, `SELECT email FROM "User" WHERE id = $1`, userID).Scan(&email); err != nil {
		return ""
	}
	return email
}

func (s *Service) isApprovalLocked(ctx context.Context, designID string) (bool, error) {
	if s.locks == nil {
		return false, nil
	}
	return s.locks.IsApprovalLocked(ctx, designID)
}

// --- access resolution (FR-7, FR-9) --------------------------------------

// resolveForUser computes a caller's effective access on a design, combining
// workspace role, grants, and custom roles via authz.Resolve, then capping by
// the approval-lock state. linkMode carries a mode the caller entered through a
// link session; lockedOverride (non-nil) overrides the derived lock state.
func (s *Service) resolveForUser(ctx context.Context, designID, userID string, linkMode authz.AccessMode, lockedOverride *bool) (DesignAccessView, error) {
	workspaceID, err := s.workspaceOf(ctx, designID)
	if err != nil {
		return DesignAccessView{}, ErrNotFound
	}
	role := s.membershipRole(ctx, userID, workspaceID)
	email := s.userEmail(ctx, userID)
	var emails []string
	if email != "" {
		emails = []string{email}
	}

	grantRows, err := s.listGrantsForUser(ctx, designID, userID, emails)
	if err != nil {
		return DesignAccessView{}, err
	}
	grants := make([]authz.AccessMode, 0, len(grantRows))
	roleIDs := map[string]bool{}
	for _, g := range grantRows {
		grants = append(grants, g.Mode)
		if g.RoleID != nil {
			roleIDs[*g.RoleID] = true
		}
	}

	var customRoles []authz.CustomRole
	if len(roleIDs) > 0 {
		scoped, err := s.listCustomRolesForDesign(ctx, workspaceID, designID)
		if err != nil {
			return DesignAccessView{}, err
		}
		for _, r := range scoped {
			if roleIDs[r.ID] {
				customRoles = append(customRoles, authz.CustomRole{ID: r.ID, Name: r.Name, Capabilities: r.Capabilities})
			}
		}
	}

	locked := false
	if lockedOverride != nil {
		locked = *lockedOverride
	} else if locked, err = s.isApprovalLocked(ctx, designID); err != nil {
		return DesignAccessView{}, err
	}

	access := authz.Resolve(authz.ResolveInput{
		WorkspaceRole:  role,
		Grants:         grants,
		Link:           linkMode,
		CustomRoles:    customRoles,
		ApprovalLocked: locked,
	})
	return DesignAccessView{Mode: access.Mode, Capabilities: access.Capabilities}, nil
}

// GetAccess resolves the caller's effective access to a design (FR-7).
func (s *Service) GetAccess(ctx context.Context, designID, userID string) (DesignAccessView, error) {
	return s.resolveForUser(ctx, designID, userID, "", nil)
}

// ResolveGatewayRole returns "editor" only when the resolved mode is edit; all
// else connects as "viewer" (FR-9).
func (s *Service) ResolveGatewayRole(ctx context.Context, designID, userID string, lockedOverride *bool) (string, error) {
	access, err := s.resolveForUser(ctx, designID, userID, "", lockedOverride)
	if err != nil {
		return "", err
	}
	if access.Mode == authz.ModeEdit {
		return "editor", nil
	}
	return "viewer", nil
}

func has(access DesignAccessView, c authz.Capability) bool {
	for _, x := range access.Capabilities {
		if x == c {
			return true
		}
	}
	return false
}

// assertCanShare requires the `share` capability on the design (FR-7).
func (s *Service) assertCanShare(ctx context.Context, designID, userID string) error {
	access, err := s.resolveForUser(ctx, designID, userID, "", nil)
	if err != nil {
		return err
	}
	if !has(access, authz.CapShare) {
		return ErrForbidden
	}
	return nil
}

// assertCanManageRoles requires the `manage-roles` capability via the caller's
// workspace role (FR-8).
func (s *Service) assertCanManageRoles(ctx context.Context, workspaceID, userID string) error {
	role := s.membershipRole(ctx, userID, workspaceID)
	access := authz.Resolve(authz.ResolveInput{WorkspaceRole: role})
	if !access.Has(authz.CapManageRoles) {
		return ErrForbidden
	}
	return nil
}

// --- views ---------------------------------------------------------------

func grantView(g GrantRow) ShareGrant {
	p := Principal{Kind: "email"}
	if g.UserID != nil {
		p = Principal{Kind: "user", ID: *g.UserID}
	} else if g.Email != nil {
		p.ID = *g.Email
	}
	return ShareGrant{
		ID: g.ID, DesignID: g.DesignID, Principal: p, Mode: g.Mode,
		RoleID: g.RoleID, InvitedBy: g.InvitedBy, CreatedAt: g.CreatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func linkView(l LinkRow) ShareLinkView {
	var exp *string
	if l.ExpiresAt != nil {
		s := l.ExpiresAt.UTC().Format(time.RFC3339Nano)
		exp = &s
	}
	return ShareLinkView{
		ID: l.ID, DesignID: l.DesignID, Token: l.Token, Mode: l.Mode,
		HasPassword: l.PasswordHash != nil, ExpiresAt: exp, Disabled: l.Disabled,
		RequireSignin: l.RequireSignin, CreatedAt: l.CreatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func roleView(r RoleRow) CustomRoleView {
	scope := "workspace"
	if r.DesignID != nil {
		scope = "design"
	}
	return CustomRoleView{
		ID: r.ID, WorkspaceID: r.WorkspaceID, DesignID: r.DesignID, Name: r.Name,
		Capabilities: r.Capabilities, Scope: scope, CreatedAt: r.CreatedAt.UTC().Format(time.RFC3339Nano),
	}
}

// GetSharing returns the Share dialog payload (FR-5). Any caller with view
// access may read it.
func (s *Service) GetSharing(ctx context.Context, designID, userID string) (DesignSharingView, error) {
	myAccess, err := s.resolveForUser(ctx, designID, userID, "", nil)
	if err != nil {
		return DesignSharingView{}, err
	}
	if !has(myAccess, authz.CapView) {
		return DesignSharingView{}, ErrForbidden
	}
	workspaceID, err := s.workspaceOf(ctx, designID)
	if err != nil {
		return DesignSharingView{}, ErrNotFound
	}
	grants, err := s.listGrantsForDesign(ctx, designID)
	if err != nil {
		return DesignSharingView{}, err
	}
	links, err := s.listLinksForDesign(ctx, designID)
	if err != nil {
		return DesignSharingView{}, err
	}
	roles, err := s.listCustomRolesForDesign(ctx, workspaceID, designID)
	if err != nil {
		return DesignSharingView{}, err
	}
	out := DesignSharingView{MyAccess: myAccess}
	for _, g := range grants {
		out.Grants = append(out.Grants, grantView(g))
	}
	for _, l := range links {
		out.Links = append(out.Links, linkView(l))
	}
	for _, r := range roles {
		out.CustomRoles = append(out.CustomRoles, roleView(r))
	}
	return out, nil
}

// ListDesignGrants returns the raw grant rows (helper for the comments module).
// Not capability-gated; callers must resolve access first.
func (s *Service) ListDesignGrants(ctx context.Context, designID string) ([]GrantRow, error) {
	return s.listGrantsForDesign(ctx, designID)
}

// --- grants (FR-5, FR-7, FR-15) ------------------------------------------

// AddGrantInput is the addGrant payload.
type AddGrantInput struct {
	Principal Principal
	Mode      string
	RoleID    *string
}

func (s *Service) AddGrant(ctx context.Context, designID, userID string, in AddGrantInput) (ShareGrant, error) {
	if err := s.assertCanShare(ctx, designID, userID); err != nil {
		return ShareGrant{}, err
	}
	mode, err := assertMode(in.Mode)
	if err != nil {
		return ShareGrant{}, err
	}
	if strings.TrimSpace(in.Principal.ID) == "" {
		return ShareGrant{}, ErrBadRequest
	}
	var uid, email *string
	if in.Principal.Kind == "user" {
		v := in.Principal.ID
		uid = &v
	} else {
		v := strings.ToLower(strings.TrimSpace(in.Principal.ID))
		email = &v
	}
	row, err := s.createGrant(ctx, GrantRow{DesignID: designID, UserID: uid, Email: email, Mode: mode, RoleID: in.RoleID, InvitedBy: &userID})
	if err != nil {
		return ShareGrant{}, err
	}
	s.emit(ctx, designID, userID, "share", map[string]any{"op": "added", "mode": string(mode), "principalKind": in.Principal.Kind})
	if row.UserID != nil {
		s.notify(ctx, userID, *row.UserID, "share", designID, map[string]any{"mode": string(mode)})
	}
	return grantView(row), nil
}

func (s *Service) UpdateGrant(ctx context.Context, grantID, userID string, mode *string, roleID *string, roleSet bool) (ShareGrant, error) {
	grant, err := s.getGrant(ctx, grantID)
	if err != nil {
		return ShareGrant{}, err
	}
	if err := s.assertCanShare(ctx, grant.DesignID, userID); err != nil {
		return ShareGrant{}, err
	}
	var newMode *authz.AccessMode
	if mode != nil {
		m, err := assertMode(*mode)
		if err != nil {
			return ShareGrant{}, err
		}
		newMode = &m
	}
	row, err := s.updateGrant(ctx, grantID, newMode, roleID, roleSet)
	if err != nil {
		return ShareGrant{}, err
	}
	s.emit(ctx, grant.DesignID, userID, "share", map[string]any{"op": "changed", "mode": string(row.Mode)})
	return grantView(row), nil
}

func (s *Service) RemoveGrant(ctx context.Context, grantID, userID string) error {
	grant, err := s.getGrant(ctx, grantID)
	if err != nil {
		return err
	}
	if err := s.assertCanShare(ctx, grant.DesignID, userID); err != nil {
		return err
	}
	if err := s.deleteGrant(ctx, grantID); err != nil {
		return err
	}
	s.emit(ctx, grant.DesignID, userID, "share", map[string]any{"op": "removed"})
	return nil
}

// --- share links (FR-5, FR-6) --------------------------------------------

// CreateLinkInput is the createLink payload.
type CreateLinkInput struct {
	Mode          string
	Password      string
	ExpiresAt     string
	RequireSignin bool
}

func (s *Service) CreateLink(ctx context.Context, designID, userID string, in CreateLinkInput) (ShareLinkView, error) {
	if err := s.assertCanShare(ctx, designID, userID); err != nil {
		return ShareLinkView{}, err
	}
	mode, err := assertMode(in.Mode)
	if err != nil {
		return ShareLinkView{}, err
	}
	var expiresAt *time.Time
	if in.ExpiresAt != "" {
		t, err := time.Parse(time.RFC3339, in.ExpiresAt)
		if err != nil {
			return ShareLinkView{}, ErrBadRequest
		}
		expiresAt = &t
	}
	var pwHash *string
	if in.Password != "" {
		h, err := secrets.HashPassword(in.Password)
		if err != nil {
			return ShareLinkView{}, err
		}
		pwHash = &h
	}
	token, err := mintToken()
	if err != nil {
		return ShareLinkView{}, err
	}
	row, err := s.createLink(ctx, LinkRow{
		DesignID: designID, Token: token, Mode: mode, PasswordHash: pwHash,
		ExpiresAt: expiresAt, RequireSignin: in.RequireSignin, CreatedByID: &userID,
	})
	if err != nil {
		return ShareLinkView{}, err
	}
	s.emit(ctx, designID, userID, "link_change", map[string]any{"op": "created", "mode": string(mode)})
	return linkView(row), nil
}

// UpdateLinkInput patches a link. expiresSet distinguishes "clear" (Expires nil
// + set) from "leave unchanged".
type UpdateLinkInput struct {
	Mode       *string
	Disabled   *bool
	ExpiresAt  *string
	ExpiresSet bool
}

func (s *Service) UpdateLink(ctx context.Context, linkID, userID string, in UpdateLinkInput) (ShareLinkView, error) {
	link, err := s.getLink(ctx, linkID)
	if err != nil {
		return ShareLinkView{}, err
	}
	if err := s.assertCanShare(ctx, link.DesignID, userID); err != nil {
		return ShareLinkView{}, err
	}
	var newMode *authz.AccessMode
	if in.Mode != nil {
		m, err := assertMode(*in.Mode)
		if err != nil {
			return ShareLinkView{}, err
		}
		newMode = &m
	}
	var expiresAt *time.Time
	expiresSet := in.ExpiresSet
	if in.ExpiresSet && in.ExpiresAt != nil {
		t, err := time.Parse(time.RFC3339, *in.ExpiresAt)
		if err != nil {
			return ShareLinkView{}, ErrBadRequest
		}
		expiresAt = &t
	}
	row, err := s.updateLink(ctx, linkID, linkPatch{mode: newMode, disabled: in.Disabled, expiresAt: expiresAt, expiresSet: expiresSet})
	if err != nil {
		return ShareLinkView{}, err
	}
	op := "updated"
	if in.Disabled != nil && *in.Disabled {
		op = "disabled"
	}
	s.emit(ctx, link.DesignID, userID, "link_change", map[string]any{"op": op})
	return linkView(row), nil
}

// RotateLink issues a new token; the old URL stops working (FR-6).
func (s *Service) RotateLink(ctx context.Context, linkID, userID string) (ShareLinkView, error) {
	link, err := s.getLink(ctx, linkID)
	if err != nil {
		return ShareLinkView{}, err
	}
	if err := s.assertCanShare(ctx, link.DesignID, userID); err != nil {
		return ShareLinkView{}, err
	}
	token, err := mintToken()
	if err != nil {
		return ShareLinkView{}, err
	}
	row, err := s.updateLink(ctx, linkID, linkPatch{token: &token})
	if err != nil {
		return ShareLinkView{}, err
	}
	s.emit(ctx, link.DesignID, userID, "link_change", map[string]any{"op": "rotated"})
	return linkView(row), nil
}

// ResolveLinkOpts carries the optional password and signed-in user for a
// public link resolution.
type ResolveLinkOpts struct {
	Password string
	UserID   string
}

// ResolveLink validates a share link by token and (for a signed-in visitor)
// records a grant so access survives link rotation/disable (FR-6, FR-15).
func (s *Service) ResolveLink(ctx context.Context, token string, opts ResolveLinkOpts) (ResolvedLink, error) {
	link, err := s.getLinkByToken(ctx, token)
	if err != nil || link.Disabled {
		return ResolvedLink{}, ErrLinkNotAvail
	}
	if link.ExpiresAt != nil && !link.ExpiresAt.After(time.Now()) {
		return ResolvedLink{}, ErrLinkGone
	}
	if link.PasswordHash != nil {
		if opts.Password == "" || !secrets.VerifyPassword(opts.Password, *link.PasswordHash) {
			return ResolvedLink{}, ErrLinkPassword
		}
	}
	if link.RequireSignin && opts.UserID == "" {
		return ResolvedLink{}, ErrLinkSigninReq
	}
	if opts.UserID != "" {
		existing, err := s.listGrantsForUser(ctx, link.DesignID, opts.UserID, nil)
		if err == nil && len(existing) == 0 {
			uid := opts.UserID
			// Benign race on the unique (designId,userId) constraint: ignore.
			_, _ = s.createGrant(ctx, GrantRow{DesignID: link.DesignID, UserID: &uid, Mode: link.Mode, InvitedBy: link.CreatedByID})
		}
	}
	return ResolvedLink{DesignID: link.DesignID, Mode: link.Mode}, nil
}

// --- custom roles (FR-8) -------------------------------------------------

func (s *Service) ListRoles(ctx context.Context, workspaceID, userID string) ([]CustomRoleView, error) {
	if err := s.assertCanManageRoles(ctx, workspaceID, userID); err != nil {
		return nil, err
	}
	rows, err := s.listCustomRolesForWorkspace(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	out := make([]CustomRoleView, 0, len(rows))
	for _, r := range rows {
		out = append(out, roleView(r))
	}
	return out, nil
}

func (s *Service) CreateRole(ctx context.Context, workspaceID, userID, name string, caps []string, designID *string) (CustomRoleView, error) {
	if err := s.assertCanManageRoles(ctx, workspaceID, userID); err != nil {
		return CustomRoleView{}, err
	}
	if strings.TrimSpace(name) == "" {
		return CustomRoleView{}, ErrBadRequest
	}
	capList, err := assertCapabilities(caps)
	if err != nil {
		return CustomRoleView{}, err
	}
	row, err := s.createCustomRole(ctx, RoleRow{WorkspaceID: workspaceID, DesignID: designID, Name: strings.TrimSpace(name), Capabilities: capList})
	if err != nil {
		return CustomRoleView{}, err
	}
	return roleView(row), nil
}

func (s *Service) UpdateRole(ctx context.Context, roleID, userID string, name *string, caps *[]string) (CustomRoleView, error) {
	role, err := s.getCustomRole(ctx, roleID)
	if err != nil {
		return CustomRoleView{}, err
	}
	if err := s.assertCanManageRoles(ctx, role.WorkspaceID, userID); err != nil {
		return CustomRoleView{}, err
	}
	var newName *string
	if name != nil {
		n := strings.TrimSpace(*name)
		if n != "" {
			newName = &n
		}
	}
	var newCaps *[]authz.Capability
	if caps != nil {
		capList, err := assertCapabilities(*caps)
		if err != nil {
			return CustomRoleView{}, err
		}
		newCaps = &capList
	}
	row, err := s.updateCustomRole(ctx, roleID, newName, newCaps)
	if err != nil {
		return CustomRoleView{}, err
	}
	return roleView(row), nil
}

func (s *Service) DeleteRole(ctx context.Context, roleID, userID string) error {
	role, err := s.getCustomRole(ctx, roleID)
	if err != nil {
		return err
	}
	if err := s.assertCanManageRoles(ctx, role.WorkspaceID, userID); err != nil {
		return err
	}
	return s.deleteCustomRole(ctx, roleID)
}

// AssignRole assigns a custom role to a member on a design (FR-8), modeled as a
// grant carrying the roleId. Capability-gated on `manage-roles`.
func (s *Service) AssignRole(ctx context.Context, designID, userID, targetUserID, roleID string, mode *string) (ShareGrant, error) {
	workspaceID, err := s.workspaceOf(ctx, designID)
	if err != nil {
		return ShareGrant{}, ErrNotFound
	}
	if err := s.assertCanManageRoles(ctx, workspaceID, userID); err != nil {
		return ShareGrant{}, err
	}
	role, err := s.getCustomRole(ctx, roleID)
	if err != nil || role.WorkspaceID != workspaceID {
		return ShareGrant{}, ErrNotFound
	}
	modeStr := "comment"
	if mode != nil {
		modeStr = *mode
	}
	m, err := assertMode(modeStr)
	if err != nil {
		return ShareGrant{}, err
	}
	row, err := s.createGrant(ctx, GrantRow{DesignID: designID, UserID: &targetUserID, Mode: m, RoleID: &roleID, InvitedBy: &userID})
	if err != nil {
		return ShareGrant{}, err
	}
	s.emit(ctx, designID, userID, "role_change", map[string]any{"targetUserId": targetUserID, "roleId": roleID, "roleName": role.Name})
	s.notify(ctx, userID, targetUserID, "share", designID, map[string]any{"mode": string(m)})
	return grantView(row), nil
}

// --- engagement hooks (best-effort, nil-safe) ----------------------------

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
