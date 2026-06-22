package convert

import (
	"context"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/persistence"
)

// Service converts a whiteboard design into a new deck design, membership-gated.
type Service struct {
	persist *persistence.Service
	acct    *accounts.Service
}

func NewService(p *persistence.Service, a *accounts.Service) *Service {
	return &Service{persist: p, acct: a}
}

// Result is the job result the client navigates from (result.designId).
type Result struct {
	DesignID string `json:"designId"`
	Slides   int    `json:"slides"`
}

// WhiteboardToDeck loads the source whiteboard, transforms it into a deck, and
// creates a new design in the same workspace. Requires member access.
func (s *Service) WhiteboardToDeck(ctx context.Context, userID, designID string) (*Result, error) {
	ws, err := s.persist.GetWorkspaceID(ctx, designID)
	if err != nil {
		return nil, err
	}
	if err := s.acct.AssertMember(ctx, userID, ws, "member"); err != nil {
		return nil, err
	}
	loaded, err := s.persist.LoadFile(ctx, designID, ws)
	if err != nil {
		return nil, err
	}
	deck, slides := WhiteboardToDeck(loaded.File)
	title, _ := deck["title"].(string)
	rec, err := s.persist.Create(ctx, ws, title, persistence.DesignFile(deck), &userID)
	if err != nil {
		return nil, err
	}
	return &Result{DesignID: rec.ID, Slides: slides}, nil
}
