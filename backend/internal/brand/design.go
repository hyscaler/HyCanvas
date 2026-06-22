// Design-scoped brand operations (doc 18 FR-2, FR-6, FR-10, FR-11): assign a kit
// to a design, resolve a design's active brand (honoring a pinned version), pin/
// track a version, mark a tracked update reviewed, and set locked regions /
// editable fields. Per-design manage-brand is resolved via the sharing access
// resolver (so custom roles + grants count, not just the workspace role); the
// brand-meta itself lives on the design's DesignFile.meta via persistence.
//
// Deferred: lintDesign + the pre-export lintGate, which need the @hc/brandkit
// linter (not ported); those routes stay on the Node service.
package brand

import (
	"context"
	"encoding/json"

	"hycanvas/backend/internal/authz"
	"hycanvas/backend/internal/persistence"
	"hycanvas/backend/internal/sharing"
)

// Access resolves a caller's per-design capabilities (sharing slice A).
type Access interface {
	GetAccess(ctx context.Context, designID, userID string) (sharing.DesignAccessView, error)
}

// DesignStore is the persistence brand-meta surface (satisfied by
// *persistence.Service). Version values use -1 for "none / track latest".
type DesignStore interface {
	GetWorkspaceID(ctx context.Context, designID string) (string, error)
	GetActiveBrandKitID(ctx context.Context, designID, workspaceID string) (string, error)
	SetActiveBrandKit(ctx context.Context, designID, workspaceID, brandKitID string, authorID *string) error
	GetActiveBrandKitVersion(ctx context.Context, designID, workspaceID string) (int, error)
	SetActiveBrandKitVersion(ctx context.Context, designID, workspaceID string, version int, authorID *string) error
	GetBrandReviewedVersion(ctx context.Context, designID, workspaceID string) (int, error)
	SetBrandReviewedVersion(ctx context.Context, designID, workspaceID string, version int, authorID *string) error
	GetLockedRegions(ctx context.Context, designID, workspaceID string) ([]string, error)
	SetLockedRegions(ctx context.Context, designID, workspaceID string, nodeIDs []string, authorID *string) ([]string, error)
	GetEditableFields(ctx context.Context, designID, workspaceID string) ([]persistence.BrandEditableField, error)
	SetEditableFields(ctx context.Context, designID, workspaceID string, fields []persistence.BrandEditableField, authorID *string) ([]persistence.BrandEditableField, error)
	FileFor(ctx context.Context, designID, workspaceID string) (persistence.DesignFile, error)
}

// WithDesignScope attaches the collaborators the design-scoped operations need.
// Returns the same service for chaining at wiring time.
func (s *Service) WithDesignScope(access Access, store DesignStore) *Service {
	s.access = access
	s.store = store
	return s
}

// ResolvedBrand is the design's active resolved brand (doc 18 FR-11).
type ResolvedBrand struct {
	Kit            *BrandKit                        `json:"kit"`
	CanManage      bool                             `json:"canManage"`
	PinnedVersion  *int                             `json:"pinnedVersion"`
	LockedRegions  []string                         `json:"lockedRegions"`
	EditableFields []persistence.BrandEditableField `json:"editableFields"`
}

// BrandUpdateSummary describes how a tracked kit advanced past a design's
// reviewed version (doc 18 FR-10).
type BrandUpdateSummary struct {
	HasUpdate     bool     `json:"hasUpdate"`
	DesignVersion *int     `json:"designVersion"`
	LatestVersion int      `json:"latestVersion"`
	Pinned        bool     `json:"pinned"`
	Changes       []string `json:"changes"`
}

// canManageBrandForDesign resolves manage-brand on a specific design via the
// sharing resolver (honors custom roles + grants, not just the workspace role).
func (s *Service) canManageBrandForDesign(ctx context.Context, designID, userID string) bool {
	access, err := s.access.GetAccess(ctx, designID, userID)
	if err != nil {
		return false
	}
	for _, c := range access.Capabilities {
		if c == authz.CapManageBrand {
			return true
		}
	}
	return false
}

func (s *Service) assertCanManageDesign(ctx context.Context, designID, workspaceID, userID string) error {
	if err := s.assertMember(ctx, userID, workspaceID); err != nil {
		return err
	}
	if !s.canManageBrandForDesign(ctx, designID, userID) {
		return ErrForbidden
	}
	return nil
}

// resolveKitRow finds the design's assigned kit (or the workspace default).
func (s *Service) resolveKitRow(ctx context.Context, designID, workspaceID string) (*BrandKitRow, error) {
	assignedID, err := s.store.GetActiveBrandKitID(ctx, designID, workspaceID)
	if err != nil {
		return nil, err
	}
	if assignedID != "" {
		if row, err := s.requireKit(ctx, assignedID); err == nil && row.WorkspaceID == workspaceID {
			return &row, nil
		}
	}
	all, err := s.listForWorkspace(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].IsDefault {
			return &all[i], nil
		}
	}
	return nil, nil
}

// AssignDesignBrand assigns (or clears with "") a design's active brand kit
// (FR-2); manage-brand only. Validates the kit belongs to the workspace.
func (s *Service) AssignDesignBrand(ctx context.Context, designID, userID, brandKitID string) (ResolvedBrand, error) {
	workspaceID, err := s.store.GetWorkspaceID(ctx, designID)
	if err != nil {
		return ResolvedBrand{}, ErrNotFound
	}
	if err := s.assertCanManageDesign(ctx, designID, workspaceID, userID); err != nil {
		return ResolvedBrand{}, err
	}
	if brandKitID != "" {
		kit, err := s.requireKit(ctx, brandKitID)
		if err != nil {
			return ResolvedBrand{}, err
		}
		if kit.WorkspaceID != workspaceID {
			return ResolvedBrand{}, ErrBadRequest
		}
	}
	if err := s.store.SetActiveBrandKit(ctx, designID, workspaceID, brandKitID, &userID); err != nil {
		return ResolvedBrand{}, err
	}
	return s.ResolveDesignBrand(ctx, designID, userID)
}

// ResolveDesignBrand returns the design's active resolved brand (FR-11),
// membership-gated; the kit is resolved as-of any pinned version.
func (s *Service) ResolveDesignBrand(ctx context.Context, designID, userID string) (ResolvedBrand, error) {
	workspaceID, err := s.store.GetWorkspaceID(ctx, designID)
	if err != nil {
		return ResolvedBrand{}, ErrNotFound
	}
	if err := s.assertMember(ctx, userID, workspaceID); err != nil {
		return ResolvedBrand{}, err
	}
	canManage := s.canManageBrandForDesign(ctx, designID, userID)

	row, err := s.resolveKitRow(ctx, designID, workspaceID)
	if err != nil {
		return ResolvedBrand{}, err
	}
	var kit *BrandKit
	if row != nil {
		v := view(*row)
		kit = &v
	}
	pinned, err := s.store.GetActiveBrandKitVersion(ctx, designID, workspaceID)
	if err != nil {
		return ResolvedBrand{}, err
	}
	if kit != nil && pinned >= 0 && pinned != kit.Version {
		if snap, err := s.getVersion(ctx, kit.ID, pinned); err == nil {
			var pinnedKit BrandKit
			if json.Unmarshal(snap.Snapshot, &pinnedKit) == nil {
				kit = &pinnedKit
			}
		}
	}
	locked, err := s.store.GetLockedRegions(ctx, designID, workspaceID)
	if err != nil {
		return ResolvedBrand{}, err
	}
	fields, err := s.store.GetEditableFields(ctx, designID, workspaceID)
	if err != nil {
		return ResolvedBrand{}, err
	}
	var pinnedPtr *int
	if pinned >= 0 {
		p := pinned
		pinnedPtr = &p
	}
	return ResolvedBrand{Kit: kit, CanManage: canManage, PinnedVersion: pinnedPtr, LockedRegions: locked, EditableFields: fields}, nil
}

// SetDesignBrandVersion pins a design to a kit version, or clears the pin to
// track latest (version < 0); manage-brand only. Validates the version exists.
func (s *Service) SetDesignBrandVersion(ctx context.Context, designID, userID string, version int) (ResolvedBrand, error) {
	workspaceID, err := s.store.GetWorkspaceID(ctx, designID)
	if err != nil {
		return ResolvedBrand{}, ErrNotFound
	}
	if err := s.assertCanManageDesign(ctx, designID, workspaceID, userID); err != nil {
		return ResolvedBrand{}, err
	}
	if version >= 0 {
		row, err := s.resolveKitRow(ctx, designID, workspaceID)
		if err != nil {
			return ResolvedBrand{}, err
		}
		if row == nil {
			return ResolvedBrand{}, ErrBadRequest
		}
		if _, err := s.getVersion(ctx, row.ID, version); err != nil {
			return ResolvedBrand{}, err
		}
	}
	if err := s.store.SetActiveBrandKitVersion(ctx, designID, workspaceID, version, &userID); err != nil {
		return ResolvedBrand{}, err
	}
	return s.ResolveDesignBrand(ctx, designID, userID)
}

// MarkBrandReviewed records that a tracking design reviewed the kit's current
// latest version (FR-10); manage-brand only. No-op when no active kit.
func (s *Service) MarkBrandReviewed(ctx context.Context, designID, userID string) (ResolvedBrand, error) {
	workspaceID, err := s.store.GetWorkspaceID(ctx, designID)
	if err != nil {
		return ResolvedBrand{}, ErrNotFound
	}
	if err := s.assertCanManageDesign(ctx, designID, workspaceID, userID); err != nil {
		return ResolvedBrand{}, err
	}
	row, err := s.resolveKitRow(ctx, designID, workspaceID)
	if err != nil {
		return ResolvedBrand{}, err
	}
	if row != nil {
		if err := s.store.SetBrandReviewedVersion(ctx, designID, workspaceID, row.Version, &userID); err != nil {
			return ResolvedBrand{}, err
		}
	}
	return s.ResolveDesignBrand(ctx, designID, userID)
}

// SetDesignLockedRegions replaces the design's brand locked-region node ids and
// (when provided) editable fields (FR-6, AC-4); manage-brand only.
func (s *Service) SetDesignLockedRegions(ctx context.Context, designID, userID string, nodeIDs []string, editableFields []persistence.BrandEditableField, editableSet bool) (ResolvedBrand, error) {
	workspaceID, err := s.store.GetWorkspaceID(ctx, designID)
	if err != nil {
		return ResolvedBrand{}, ErrNotFound
	}
	if err := s.assertCanManageDesign(ctx, designID, workspaceID, userID); err != nil {
		return ResolvedBrand{}, err
	}
	if _, err := s.store.SetLockedRegions(ctx, designID, workspaceID, nodeIDs, &userID); err != nil {
		return ResolvedBrand{}, err
	}
	if editableSet {
		if _, err := s.store.SetEditableFields(ctx, designID, workspaceID, editableFields, &userID); err != nil {
			return ResolvedBrand{}, err
		}
	}
	return s.ResolveDesignBrand(ctx, designID, userID)
}

// BrandUpdates reports whether a tracked kit advanced past the design's reviewed
// version, with a human-readable diff (FR-10); membership-gated. A pinned design
// never reports an update.
func (s *Service) BrandUpdates(ctx context.Context, designID, userID string) (BrandUpdateSummary, error) {
	workspaceID, err := s.store.GetWorkspaceID(ctx, designID)
	if err != nil {
		return BrandUpdateSummary{}, ErrNotFound
	}
	if err := s.assertMember(ctx, userID, workspaceID); err != nil {
		return BrandUpdateSummary{}, err
	}
	row, err := s.resolveKitRow(ctx, designID, workspaceID)
	if err != nil {
		return BrandUpdateSummary{}, err
	}
	if row == nil {
		return BrandUpdateSummary{HasUpdate: false, LatestVersion: 0, Changes: []string{}}, nil
	}
	latest := row.Version
	pinned, err := s.store.GetActiveBrandKitVersion(ctx, designID, workspaceID)
	if err != nil {
		return BrandUpdateSummary{}, err
	}
	if pinned >= 0 {
		p := pinned
		return BrandUpdateSummary{HasUpdate: false, DesignVersion: &p, LatestVersion: latest, Pinned: true, Changes: []string{}}, nil
	}
	versions, err := s.listVersions(ctx, row.ID)
	if err != nil {
		return BrandUpdateSummary{}, err
	}
	if len(versions) < 2 {
		return BrandUpdateSummary{HasUpdate: false, DesignVersion: &latest, LatestVersion: latest, Changes: []string{}}, nil
	}
	reviewed, err := s.store.GetBrandReviewedVersion(ctx, designID, workspaceID)
	if err != nil {
		return BrandUpdateSummary{}, err
	}
	baseline := reviewed
	if baseline < 0 {
		baseline = versions[1].Version // version immediately before latest
	}
	if baseline >= latest {
		return BrandUpdateSummary{HasUpdate: false, DesignVersion: &baseline, LatestVersion: latest, Changes: []string{}}, nil
	}
	current := snapshotKit(versions[0])
	var baselineKit BrandKit
	found := false
	for _, v := range versions {
		if v.Version == baseline {
			baselineKit = snapshotKit(v)
			found = true
			break
		}
	}
	if !found {
		baselineKit = snapshotKit(versions[1])
	}
	changes := diffKits(baselineKit, current)
	return BrandUpdateSummary{HasUpdate: len(changes) > 0, DesignVersion: &baseline, LatestVersion: latest, Pinned: false, Changes: changes}, nil
}

func snapshotKit(v BrandKitVersion) BrandKit {
	var k BrandKit
	_ = json.Unmarshal(v.Snapshot, &k)
	return k
}

// diffKits is a pragmatic human-readable diff of two kit snapshots (FR-10).
func diffKits(prev, next BrandKit) []string {
	out := []string{}
	if countColors(prev.Palettes) != countColors(next.Palettes) {
		out = append(out, "palette colors changed")
	}
	prevFonts := fontFamilies(prev.Fonts)
	nextFonts := fontFamilies(next.Fonts)
	if !sameStringSet(prevFonts, nextFonts) {
		out = append(out, "fonts changed")
	}
	if countItems(prev.Logos) != countItems(next.Logos) {
		out = append(out, "logos changed")
	}
	if prev.Name != next.Name && next.Name != "" {
		out = append(out, `renamed to "`+next.Name+`"`)
	}
	pc, _ := json.Marshal(prev.Controls)
	nc, _ := json.Marshal(next.Controls)
	if string(pc) != string(nc) {
		out = append(out, "brand controls changed")
	}
	return out
}

func countColors(palettes json.RawMessage) int {
	var ps []map[string]any
	if json.Unmarshal(palettes, &ps) != nil {
		return 0
	}
	total := 0
	for _, p := range ps {
		if colors, ok := p["colors"].([]any); ok {
			total += len(colors)
		}
	}
	return total
}

func countItems(raw json.RawMessage) int {
	var xs []any
	if json.Unmarshal(raw, &xs) != nil {
		return 0
	}
	return len(xs)
}

func fontFamilies(raw json.RawMessage) map[string]bool {
	out := map[string]bool{}
	var fs []map[string]any
	if json.Unmarshal(raw, &fs) != nil {
		return out
	}
	for _, f := range fs {
		if ff, ok := f["fontFamily"].(string); ok {
			out[ff] = true
		}
	}
	return out
}

func sameStringSet(a, b map[string]bool) bool {
	if len(a) != len(b) {
		return false
	}
	for k := range a {
		if !b[k] {
			return false
		}
	}
	return true
}
