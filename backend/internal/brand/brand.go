// Package brand ports the kit-management half of the NestJS brand module (doc
// 18 slice A: FR-1, FR-2, FR-9, FR-12). It is the single place brand kits are
// read/written and the enforcer of the manage-brand capability: reading a kit
// needs workspace membership (doc 15 isolation); creating/editing kits + setting
// the default need the manage-brand capability (owner/admin via authz).
//
// Deferred vs the Node original: the design-scoped operations (assign a kit to a
// design, resolve a design's brand, lint, the pre-export gate, pin/track a
// version, mark-reviewed, locked regions, and the locked-save validateSnapshot)
// all read/write DesignFile.meta on the durable snapshot and load the design
// file, which the Go persistence snapshot read/write is not yet ported for.
// Those routes stay on the Node service until the persistence-writes slice
// lands; the strangler proxy keeps them there.
package brand

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"hycanvas/backend/internal/authz"
)

// Errors map to RFC 7807 statuses at the HTTP layer.
var (
	ErrForbidden  = errors.New("forbidden")
	ErrNotFound   = errors.New("not found")
	ErrBadRequest = errors.New("bad request")
)

// Service is the brand module. The design-scoped half (access + store) is
// attached via WithDesignScope; the kit-management half needs only db.
type Service struct {
	db     DBTX
	access Access
	store  DesignStore
}

// NewService wires the brand service (kit-management). Call WithDesignScope to
// enable the design-scoped operations.
func NewService(db DBTX) *Service { return &Service{db: db} }

// --- types ---------------------------------------------------------------

// BrandControls are the brand controls (doc 18 FR-4/FR-5/FR-8). lintPolicy is
// the pre-export gate strictness ("off" | "warn" | "block").
type BrandControls struct {
	LockColors        bool   `json:"lockColors"`
	LockFonts         bool   `json:"lockFonts"`
	RestrictTemplates bool   `json:"restrictTemplates"`
	LintPolicy        string `json:"lintPolicy"`
}

// defaultControls is the control set a fresh kit starts with (nothing locked;
// lint warns so violations surface without blocking).
func defaultControls() BrandControls {
	return BrandControls{LintPolicy: "warn"}
}

// BrandKit is the API view of a kit. The content collections are passed through
// as raw JSON (the kit-management half does not interpret their internals);
// controls is typed with the defaults merged in.
type BrandKit struct {
	ID          string          `json:"id"`
	WorkspaceID string          `json:"workspaceId"`
	Name        string          `json:"name"`
	Version     int             `json:"version"`
	IsDefault   bool            `json:"isDefault"`
	Palettes    json.RawMessage `json:"palettes"`
	Fonts       json.RawMessage `json:"fonts"`
	Logos       json.RawMessage `json:"logos"`
	Voice       json.RawMessage `json:"voice"`
	Collections json.RawMessage `json:"collections"`
	Controls    BrandControls   `json:"controls"`
	CreatedAt   string          `json:"createdAt"`
	UpdatedAt   string          `json:"updatedAt"`
}

// BrandKitVersion is the API view of a stored version snapshot.
type BrandKitVersion struct {
	ID         string          `json:"id"`
	BrandKitID string          `json:"brandKitId"`
	Version    int             `json:"version"`
	Snapshot   json.RawMessage `json:"snapshot"`
	AuthorID   *string         `json:"authorId"`
	CreatedAt  string          `json:"createdAt"`
}

// UpdateInput patches a kit. The *Set / non-nil fields select which columns to
// write; ControlsRaw (when non-nil) is a partial merged over the current controls.
type UpdateInput struct {
	Name        *string
	IsDefault   *bool
	Palettes    json.RawMessage
	Fonts       json.RawMessage
	Logos       json.RawMessage
	Voice       json.RawMessage
	VoiceSet    bool
	Collections json.RawMessage
	ControlsRaw json.RawMessage
}

// --- capability helpers --------------------------------------------------

// workspaceRole returns the caller's lowercase active role, or "".
func (s *Service) workspaceRole(ctx context.Context, userID, workspaceID string) authz.WorkspaceRole {
	const q = `SELECT role FROM "WorkspaceMember" WHERE "workspaceId" = $1 AND "userId" = $2 AND status = 'ACTIVE'`
	var role string
	if err := s.db.QueryRow(ctx, q, workspaceID, userID).Scan(&role); err != nil {
		return ""
	}
	return authz.WorkspaceRole(strings.ToLower(role))
}

func (s *Service) assertMember(ctx context.Context, userID, workspaceID string) error {
	if s.workspaceRole(ctx, userID, workspaceID) == "" {
		return ErrForbidden
	}
	return nil
}

// canManageBrand reports whether the caller holds manage-brand in the workspace
// (owner/admin via the built-in role table, FR-12).
func (s *Service) canManageBrand(ctx context.Context, userID, workspaceID string) bool {
	role := s.workspaceRole(ctx, userID, workspaceID)
	if role == "" {
		return false
	}
	return authz.Resolve(authz.ResolveInput{WorkspaceRole: role}).Has(authz.CapManageBrand)
}

func (s *Service) assertCanManage(ctx context.Context, userID, workspaceID string) error {
	if err := s.assertMember(ctx, userID, workspaceID); err != nil {
		return err
	}
	if !s.canManageBrand(ctx, userID, workspaceID) {
		return ErrForbidden
	}
	return nil
}

// --- views ---------------------------------------------------------------

func view(row BrandKitRow) BrandKit {
	controls := defaultControls()
	if len(row.Controls) > 0 {
		_ = json.Unmarshal(row.Controls, &controls) // present keys override defaults
	}
	return BrandKit{
		ID: row.ID, WorkspaceID: row.WorkspaceID, Name: row.Name, Version: row.Version,
		IsDefault: row.IsDefault, Palettes: jsonOrEmpty(row.Palettes), Fonts: jsonOrEmpty(row.Fonts),
		Logos: jsonOrEmpty(row.Logos), Voice: jsonOrNull(row.Voice), Collections: jsonOrEmpty(row.Collections),
		Controls: controls, CreatedAt: row.CreatedAt.UTC().Format(isoFmt), UpdatedAt: row.UpdatedAt.UTC().Format(isoFmt),
	}
}

func jsonOrEmpty(b json.RawMessage) json.RawMessage {
	if len(b) == 0 {
		return json.RawMessage("[]")
	}
	return b
}

func jsonOrNull(b json.RawMessage) json.RawMessage {
	if len(b) == 0 {
		return json.RawMessage("null")
	}
	return b
}

// --- CRUD (FR-1, FR-2, FR-9, FR-12) --------------------------------------

// ListKits returns all kits in a workspace (default first). Membership-gated.
func (s *Service) ListKits(ctx context.Context, workspaceID, userID string) ([]BrandKit, error) {
	if err := s.assertMember(ctx, userID, workspaceID); err != nil {
		return nil, err
	}
	rows, err := s.listForWorkspace(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	out := make([]BrandKit, 0, len(rows))
	for _, r := range rows {
		out = append(out, view(r))
	}
	return out, nil
}

// GetKit returns one kit. Membership-gated (workspace isolation).
func (s *Service) GetKit(ctx context.Context, kitID, userID string) (BrandKit, error) {
	kit, err := s.requireKit(ctx, kitID)
	if err != nil {
		return BrandKit{}, err
	}
	if err := s.assertMember(ctx, userID, kit.WorkspaceID); err != nil {
		return BrandKit{}, err
	}
	return view(kit), nil
}

// CreateKit creates a brand kit (manage-brand only). The first kit (or one
// created with isDefault) becomes the workspace default.
func (s *Service) CreateKit(ctx context.Context, workspaceID, userID, name string, isDefault *bool) (BrandKit, error) {
	if err := s.assertCanManage(ctx, userID, workspaceID); err != nil {
		return BrandKit{}, err
	}
	n := strings.TrimSpace(name)
	if n == "" {
		n = "Untitled brand kit"
	}
	existing, err := s.listForWorkspace(ctx, workspaceID)
	if err != nil {
		return BrandKit{}, err
	}
	makeDefault := len(existing) == 0
	if isDefault != nil {
		makeDefault = *isDefault
	}
	row, err := s.create(ctx, workspaceID, n, makeDefault)
	if err != nil {
		return BrandKit{}, err
	}
	if makeDefault {
		if err := s.clearDefault(ctx, workspaceID, row.ID); err != nil {
			return BrandKit{}, err
		}
	}
	if err := s.recordVersion(ctx, row, userID); err != nil {
		return BrandKit{}, err
	}
	return view(row), nil
}

// UpdateKit updates a kit's metadata/contents/controls (manage-brand only).
// Every write advances the version and records an immutable version snapshot.
func (s *Service) UpdateKit(ctx context.Context, kitID, userID string, in UpdateInput) (BrandKit, error) {
	kit, err := s.requireKit(ctx, kitID)
	if err != nil {
		return BrandKit{}, err
	}
	if err := s.assertCanManage(ctx, userID, kit.WorkspaceID); err != nil {
		return BrandKit{}, err
	}
	// Merge a partial controls patch over the current (defaults-merged) controls.
	var controlsRaw json.RawMessage
	if in.ControlsRaw != nil {
		merged := defaultControls()
		if len(kit.Controls) > 0 {
			_ = json.Unmarshal(kit.Controls, &merged)
		}
		_ = json.Unmarshal(in.ControlsRaw, &merged)
		b, _ := json.Marshal(merged)
		controlsRaw = b
	}
	var name *string
	if in.Name != nil {
		t := strings.TrimSpace(*in.Name)
		if t != "" {
			name = &t
		}
	}
	row, err := s.update(ctx, kitID, updatePatch{
		name: name, version: kit.Version + 1, isDefault: in.IsDefault,
		palettes: in.Palettes, fonts: in.Fonts, logos: in.Logos,
		voice: in.Voice, voiceSet: in.VoiceSet, collections: in.Collections, controls: controlsRaw,
	})
	if err != nil {
		return BrandKit{}, err
	}
	if in.IsDefault != nil && *in.IsDefault {
		if err := s.clearDefault(ctx, kit.WorkspaceID, kitID); err != nil {
			return BrandKit{}, err
		}
	}
	if err := s.recordVersion(ctx, row, userID); err != nil {
		return BrandKit{}, err
	}
	return view(row), nil
}

// ListVersions returns a kit's version history, newest first (manage-brand only).
func (s *Service) ListVersions(ctx context.Context, kitID, userID string) ([]BrandKitVersion, error) {
	kit, err := s.requireKit(ctx, kitID)
	if err != nil {
		return nil, err
	}
	if err := s.assertCanManage(ctx, userID, kit.WorkspaceID); err != nil {
		return nil, err
	}
	return s.listVersions(ctx, kitID)
}

// RestoreVersion restores a kit to a prior version by writing that snapshot's
// contents back as a NEW version (manage-brand only); intervening history is
// never destroyed.
func (s *Service) RestoreVersion(ctx context.Context, kitID, userID string, version int) (BrandKit, error) {
	kit, err := s.requireKit(ctx, kitID)
	if err != nil {
		return BrandKit{}, err
	}
	if err := s.assertCanManage(ctx, userID, kit.WorkspaceID); err != nil {
		return BrandKit{}, err
	}
	snap, err := s.getVersion(ctx, kitID, version)
	if err != nil {
		return BrandKit{}, err
	}
	var prior BrandKit
	if err := json.Unmarshal(snap.Snapshot, &prior); err != nil {
		return BrandKit{}, ErrBadRequest
	}
	controlsRaw, _ := json.Marshal(prior.Controls)
	row, err := s.update(ctx, kitID, updatePatch{
		name: &prior.Name, version: kit.Version + 1,
		palettes: prior.Palettes, fonts: prior.Fonts, logos: prior.Logos,
		voice: prior.Voice, voiceSet: true, collections: prior.Collections, controls: controlsRaw,
	})
	if err != nil {
		return BrandKit{}, err
	}
	if err := s.recordVersion(ctx, row, userID); err != nil {
		return BrandKit{}, err
	}
	return view(row), nil
}

// DeleteKit deletes a brand kit (manage-brand only).
func (s *Service) DeleteKit(ctx context.Context, kitID, userID string) error {
	kit, err := s.requireKit(ctx, kitID)
	if err != nil {
		return err
	}
	if err := s.assertCanManage(ctx, userID, kit.WorkspaceID); err != nil {
		return err
	}
	return s.deleteKit(ctx, kitID)
}

// SetDefault sets a kit as the workspace default (manage-brand only).
func (s *Service) SetDefault(ctx context.Context, kitID, userID string) (BrandKit, error) {
	kit, err := s.requireKit(ctx, kitID)
	if err != nil {
		return BrandKit{}, err
	}
	if err := s.assertCanManage(ctx, userID, kit.WorkspaceID); err != nil {
		return BrandKit{}, err
	}
	t := true
	row, err := s.update(ctx, kitID, updatePatch{isDefault: &t})
	if err != nil {
		return BrandKit{}, err
	}
	if err := s.clearDefault(ctx, kit.WorkspaceID, kitID); err != nil {
		return BrandKit{}, err
	}
	return view(row), nil
}

// recordVersion appends a snapshot of the kit's current state at its version.
func (s *Service) recordVersion(ctx context.Context, row BrandKitRow, authorID string) error {
	snapshot, err := json.Marshal(view(row))
	if err != nil {
		return err
	}
	return s.appendVersion(ctx, row.ID, row.Version, snapshot, authorID)
}
