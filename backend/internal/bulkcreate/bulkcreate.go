// Package bulkcreate ports the data-merge / bulk-create module (doc 27 FR-7..11):
// a dataset (rows) plus a base design or template that declares fillable fields
// produces many finished designs (one per row), and a single design can be
// autofilled from one row. Everything is membership-gated. The async/uncapped
// path (formerly BullMQ) is folded into the synchronous, capped path here; the
// Go backend runs work inline.
package bulkcreate

import (
	"context"
	"errors"
	"regexp"
	"strconv"
	"strings"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/persistence"
	"hycanvas/backend/internal/templates"
)

// RowCap is the largest batch processed in one bulk-create request; larger
// datasets are truncated and reported.
const RowCap = 200

// ErrBadRequest is returned for invalid input (mapped to 400 by the handler).
var ErrBadRequest = errors.New("bad request")

// Input is the bulk-create request (matches the SDK BulkCreateInput).
type Input struct {
	WorkspaceID      string              `json:"workspaceId"`
	SourceTemplateID string              `json:"sourceTemplateId"`
	SourceDesignID   string              `json:"sourceDesignId"`
	Rows             []map[string]string `json:"rows"`
	TitlePattern     string              `json:"titlePattern"`
}

// Result is the bulk-create outcome (matches the SDK BulkCreateResult).
type Result struct {
	Created       []CreatedDesign `json:"created"`
	Truncated     bool            `json:"truncated"`
	RequestedRows int             `json:"requestedRows"`
	Skipped       []SkippedRow    `json:"skipped"`
}

type CreatedDesign struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}
type SkippedRow struct {
	Row    int    `json:"row"`
	Reason string `json:"reason"`
}

// Service orchestrates fill + persistence + templates, membership-gated.
type Service struct {
	persist   *persistence.Service
	acct      *accounts.Service
	templates *templates.Service
}

func NewService(p *persistence.Service, a *accounts.Service, t *templates.Service) *Service {
	return &Service{persist: p, acct: a, templates: t}
}

// DesignFields returns a design's fillable fields (from meta.brandEditableFields).
func (s *Service) DesignFields(ctx context.Context, userID, designID string) ([]Field, error) {
	ws, err := s.persist.GetWorkspaceID(ctx, designID)
	if err != nil {
		return nil, err
	}
	if err := s.acct.AssertMember(ctx, userID, ws, "viewer"); err != nil {
		return nil, err
	}
	raw, err := s.persist.GetEditableFields(ctx, designID, ws)
	if err != nil {
		return nil, err
	}
	return fromEditableFields(raw), nil
}

// Autofill applies one row of values into an existing design, saving a snapshot.
func (s *Service) Autofill(ctx context.Context, userID, designID string, values FillValues) error {
	ws, err := s.persist.GetWorkspaceID(ctx, designID)
	if err != nil {
		return err
	}
	if err := s.acct.AssertMember(ctx, userID, ws, "member"); err != nil {
		return err
	}
	loaded, err := s.persist.LoadFile(ctx, designID, ws)
	if err != nil {
		return err
	}
	raw, err := s.persist.GetEditableFields(ctx, designID, ws)
	if err != nil {
		return err
	}
	if ok, reason := ValidateFillRow(fromEditableFields(raw), values); !ok {
		return errBad(reason)
	}
	filled := ApplyFill(loaded.File, values)
	label := "Autofilled from data"
	if _, err := s.persist.Snapshot(ctx, designID, ws, persistence.DesignFile(filled), persistence.KindCheckpoint, &label, &userID); err != nil {
		return err
	}
	return nil
}

// BulkCreate produces one design per row from a template or base design.
func (s *Service) BulkCreate(ctx context.Context, userID string, in Input) (*Result, error) {
	if len(in.Rows) == 0 {
		return nil, errBad("rows must be a non-empty array")
	}
	if err := s.acct.AssertMember(ctx, userID, in.WorkspaceID, "member"); err != nil {
		return nil, err
	}
	baseFile, fields, baseTitle, err := s.resolveBase(ctx, userID, in)
	if err != nil {
		return nil, err
	}

	requested := len(in.Rows)
	truncated := requested > RowCap
	rows := in.Rows
	if truncated {
		rows = rows[:RowCap]
	}

	res := &Result{Created: []CreatedDesign{}, Truncated: truncated, RequestedRows: requested, Skipped: []SkippedRow{}}
	for i, row := range rows {
		values := toFillValues(fields, row)
		if ok, reason := ValidateFillRow(fields, values); !ok {
			res.Skipped = append(res.Skipped, SkippedRow{Row: i, Reason: reason})
			continue
		}
		filled := ApplyFill(baseFile, values)
		copyFile := templates.DeepCopyForNew(filled)
		title := renderTitle(in.TitlePattern, fields, row, baseTitle, i)
		rec, err := s.persist.Create(ctx, in.WorkspaceID, title, persistence.DesignFile(copyFile), &userID)
		if err != nil {
			res.Skipped = append(res.Skipped, SkippedRow{Row: i, Reason: "create failed"})
			continue
		}
		res.Created = append(res.Created, CreatedDesign{ID: rec.ID, Title: title})
	}
	return res, nil
}

// resolveBase loads the base file + fields + base title from a template or design.
func (s *Service) resolveBase(ctx context.Context, userID string, in Input) (map[string]any, []Field, string, error) {
	if in.SourceTemplateID != "" && in.SourceDesignID != "" {
		return nil, nil, "", errBad("provide exactly one of sourceTemplateId or sourceDesignId")
	}
	if in.SourceTemplateID != "" {
		file, err := s.templates.GetFile(ctx, userID, in.SourceTemplateID)
		if err != nil {
			return nil, nil, "", err
		}
		ffRaw, err := s.templates.GetFillableFields(ctx, userID, in.SourceTemplateID)
		if err != nil {
			return nil, nil, "", err
		}
		tmpl, err := s.templates.Get(ctx, userID, in.SourceTemplateID)
		if err != nil {
			return nil, nil, "", err
		}
		return file, fromRawFields(ffRaw), tmpl.Title, nil
	}
	if in.SourceDesignID != "" {
		ws, err := s.persist.GetWorkspaceID(ctx, in.SourceDesignID)
		if err != nil {
			return nil, nil, "", err
		}
		if err := s.acct.AssertMember(ctx, userID, ws, "viewer"); err != nil {
			return nil, nil, "", err
		}
		loaded, err := s.persist.LoadFile(ctx, in.SourceDesignID, ws)
		if err != nil {
			return nil, nil, "", err
		}
		raw, err := s.persist.GetEditableFields(ctx, in.SourceDesignID, ws)
		if err != nil {
			return nil, nil, "", err
		}
		return loaded.File, fromEditableFields(raw), loaded.Record.Title, nil
	}
	return nil, nil, "", errBad("one of sourceTemplateId or sourceDesignId is required")
}

func errBad(reason string) error {
	if reason == "" {
		reason = "bad request"
	}
	return errors.Join(ErrBadRequest, errors.New(reason))
}

func fromEditableFields(raw []persistence.BrandEditableField) []Field {
	out := make([]Field, 0, len(raw))
	for _, f := range raw {
		kind := f.Kind
		if kind == "" {
			kind = "text"
		}
		out = append(out, Field{NodeID: f.NodeID, Kind: kind, Label: f.Label, Hint: f.Hint, Constraints: f.Constraints})
	}
	return out
}

func fromRawFields(raw []any) []Field {
	out := make([]Field, 0, len(raw))
	for _, r := range raw {
		m := asObj(r)
		if m == nil {
			continue
		}
		kind, _ := m["kind"].(string)
		if kind == "" {
			kind = "text"
		}
		nodeID, _ := m["nodeId"].(string)
		label, _ := m["label"].(string)
		hint, _ := m["hint"].(string)
		out = append(out, Field{NodeID: nodeID, Kind: kind, Label: label, Hint: hint, Constraints: asObj(m["constraints"])})
	}
	return out
}

// toFillValues maps a dataset row (keyed by field nodeId) to FillValues by kind.
func toFillValues(fields []Field, row map[string]string) FillValues {
	values := FillValues{}
	for _, field := range fields {
		raw, ok := row[field.NodeID]
		if !ok {
			continue
		}
		if field.Kind == "image" {
			values[field.NodeID] = FillValue{ImageURL: raw}
		} else {
			values[field.NodeID] = FillValue{Text: raw}
		}
	}
	return values
}

var placeholderRE = regexp.MustCompile(`\{([^}]+)\}`)

// renderTitle substitutes {field} placeholders (by nodeId or label) with the
// row's values, falling back to a numbered base title.
func renderTitle(pattern string, fields []Field, row map[string]string, baseTitle string, index int) string {
	numbered := func() string { return baseTitle + " " + strconv.Itoa(index+1) }
	if strings.TrimSpace(pattern) == "" {
		return numbered()
	}
	byLabel := map[string]string{}
	for _, f := range fields {
		byLabel[strings.ToLower(f.Label)] = f.NodeID
	}
	out := placeholderRE.ReplaceAllStringFunc(pattern, func(m string) string {
		key := strings.TrimSpace(m[1 : len(m)-1])
		nodeID := key
		if _, ok := row[key]; !ok {
			if id, ok := byLabel[strings.ToLower(key)]; ok {
				nodeID = id
			}
		}
		return row[nodeID]
	})
	if strings.TrimSpace(out) == "" {
		return numbered()
	}
	return out
}
