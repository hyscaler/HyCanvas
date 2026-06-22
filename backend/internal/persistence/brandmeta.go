// Brand-meta accessors (doc 18 FR-2/FR-6/FR-10): read/write the design's
// active brand assignment, pinned version, locked regions, editable fields, and
// reviewed version, all stored additively on DesignFile.meta (no scene-graph
// mutation, no schema migration). Each write records a checkpoint snapshot so
// the choice is durable + versioned. These back the design-scoped half of the
// brand module.
package persistence

import "context"

const (
	metaBrandKitID          = "brandKitId"
	metaBrandKitVersion     = "brandKitVersion"
	metaBrandReviewedVer    = "brandReviewedVersion"
	metaBrandLockedRegions  = "brandLockedRegions"
	metaBrandEditableFields = "brandEditableFields"
)

// BrandEditableField is a brand-template editable-field descriptor (doc 18 FR-6),
// stored on the design's meta. Storage-shaped; round-trips verbatim.
type BrandEditableField struct {
	NodeID      string         `json:"nodeId"`
	Kind        string         `json:"kind,omitempty"`
	Label       string         `json:"label"`
	Hint        string         `json:"hint,omitempty"`
	Constraints map[string]any `json:"constraints,omitempty"`
}

// writeMeta loads the file, applies mutate to a copy of its meta, and records a
// checkpoint snapshot.
func (s *Service) writeMeta(ctx context.Context, designID, workspaceID string, authorID *string, mutate func(meta map[string]any)) error {
	loaded, err := s.LoadFile(ctx, designID, workspaceID)
	if err != nil {
		return err
	}
	meta := metaOf(loaded.File)
	mutate(meta)
	next := withMeta(withID(loaded.File, designID), meta)
	_, _, err = s.writeSnapshot(ctx, designID, next, KindCheckpoint, nil, authorID)
	return err
}

// GetActiveBrandKitID returns meta.brandKitId or "" (doc 18 FR-2).
func (s *Service) GetActiveBrandKitID(ctx context.Context, designID, workspaceID string) (string, error) {
	loaded, err := s.LoadFile(ctx, designID, workspaceID)
	if err != nil {
		return "", err
	}
	if id, ok := metaOf(loaded.File)[metaBrandKitID].(string); ok {
		return id, nil
	}
	return "", nil
}

// SetActiveBrandKit assigns (or clears with "") the active brand kit, dropping
// any pin + reviewed marker (FR-2, FR-10).
func (s *Service) SetActiveBrandKit(ctx context.Context, designID, workspaceID, brandKitID string, authorID *string) error {
	return s.writeMeta(ctx, designID, workspaceID, authorID, func(meta map[string]any) {
		if brandKitID != "" {
			meta[metaBrandKitID] = brandKitID
		} else {
			delete(meta, metaBrandKitID)
		}
		delete(meta, metaBrandKitVersion)
		delete(meta, metaBrandReviewedVer)
	})
}

// GetActiveBrandKitVersion returns the pinned version or -1 when tracking latest.
func (s *Service) GetActiveBrandKitVersion(ctx context.Context, designID, workspaceID string) (int, error) {
	loaded, err := s.LoadFile(ctx, designID, workspaceID)
	if err != nil {
		return -1, err
	}
	if v, ok := metaOf(loaded.File)[metaBrandKitVersion].(float64); ok {
		return int(v), nil
	}
	return -1, nil
}

// SetActiveBrandKitVersion pins a version (>=0) or clears the pin (version < 0).
func (s *Service) SetActiveBrandKitVersion(ctx context.Context, designID, workspaceID string, version int, authorID *string) error {
	return s.writeMeta(ctx, designID, workspaceID, authorID, func(meta map[string]any) {
		if version >= 0 {
			meta[metaBrandKitVersion] = version
		} else {
			delete(meta, metaBrandKitVersion)
		}
	})
}

// GetBrandReviewedVersion returns the last-reviewed version or -1 when never.
func (s *Service) GetBrandReviewedVersion(ctx context.Context, designID, workspaceID string) (int, error) {
	loaded, err := s.LoadFile(ctx, designID, workspaceID)
	if err != nil {
		return -1, err
	}
	if v, ok := metaOf(loaded.File)[metaBrandReviewedVer].(float64); ok {
		return int(v), nil
	}
	return -1, nil
}

// SetBrandReviewedVersion records the reviewed version (>=0) or clears it.
func (s *Service) SetBrandReviewedVersion(ctx context.Context, designID, workspaceID string, version int, authorID *string) error {
	return s.writeMeta(ctx, designID, workspaceID, authorID, func(meta map[string]any) {
		if version >= 0 {
			meta[metaBrandReviewedVer] = version
		} else {
			delete(meta, metaBrandReviewedVer)
		}
	})
}

// GetLockedRegions returns meta.brandLockedRegions (doc 18 FR-6), or [].
func (s *Service) GetLockedRegions(ctx context.Context, designID, workspaceID string) ([]string, error) {
	loaded, err := s.LoadFile(ctx, designID, workspaceID)
	if err != nil {
		return nil, err
	}
	return readStringArray(metaOf(loaded.File), metaBrandLockedRegions), nil
}

// SetLockedRegions replaces the locked-region ids (empty clears the marker).
func (s *Service) SetLockedRegions(ctx context.Context, designID, workspaceID string, nodeIDs []string, authorID *string) ([]string, error) {
	if err := s.writeMeta(ctx, designID, workspaceID, authorID, func(meta map[string]any) {
		if len(nodeIDs) > 0 {
			arr := make([]any, len(nodeIDs))
			for i, id := range nodeIDs {
				arr[i] = id
			}
			meta[metaBrandLockedRegions] = arr
		} else {
			delete(meta, metaBrandLockedRegions)
		}
	}); err != nil {
		return nil, err
	}
	return nodeIDs, nil
}

// GetEditableFields returns meta.brandEditableFields (doc 18 FR-6), or [].
func (s *Service) GetEditableFields(ctx context.Context, designID, workspaceID string) ([]BrandEditableField, error) {
	loaded, err := s.LoadFile(ctx, designID, workspaceID)
	if err != nil {
		return nil, err
	}
	raw, _ := metaOf(loaded.File)[metaBrandEditableFields].([]any)
	out := []BrandEditableField{}
	for _, x := range raw {
		m, _ := x.(map[string]any)
		if m == nil {
			continue
		}
		nodeID, _ := m["nodeId"].(string)
		label, _ := m["label"].(string)
		if nodeID == "" || label == "" {
			continue
		}
		f := BrandEditableField{NodeID: nodeID, Label: label}
		if k, ok := m["kind"].(string); ok {
			f.Kind = k
		}
		if h, ok := m["hint"].(string); ok {
			f.Hint = h
		}
		if c, ok := m["constraints"].(map[string]any); ok {
			f.Constraints = c
		}
		out = append(out, f)
	}
	return out, nil
}

// SetEditableFields replaces the editable-field descriptors (empty clears them).
func (s *Service) SetEditableFields(ctx context.Context, designID, workspaceID string, fields []BrandEditableField, authorID *string) ([]BrandEditableField, error) {
	if err := s.writeMeta(ctx, designID, workspaceID, authorID, func(meta map[string]any) {
		if len(fields) > 0 {
			arr := make([]any, len(fields))
			for i, f := range fields {
				m := map[string]any{"nodeId": f.NodeID, "label": f.Label}
				if f.Kind != "" {
					m["kind"] = f.Kind
				}
				if f.Hint != "" {
					m["hint"] = f.Hint
				}
				if f.Constraints != nil {
					m["constraints"] = f.Constraints
				}
				arr[i] = m
			}
			meta[metaBrandEditableFields] = arr
		} else {
			delete(meta, metaBrandEditableFields)
		}
	}); err != nil {
		return nil, err
	}
	return s.GetEditableFields(ctx, designID, workspaceID)
}

// FileFor returns the design's current file, workspace-scoped (for the brand
// lint gate).
func (s *Service) FileFor(ctx context.Context, designID, workspaceID string) (DesignFile, error) {
	loaded, err := s.LoadFile(ctx, designID, workspaceID)
	if err != nil {
		return nil, err
	}
	return loaded.File, nil
}

func readStringArray(meta map[string]any, key string) []string {
	raw, _ := meta[key].([]any)
	out := []string{}
	for _, x := range raw {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}
