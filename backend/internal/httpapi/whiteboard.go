package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/whiteboard"
)

// mountWhiteboard attaches the server-authoritative whiteboard voting surface
// (F30 FR-19/FR-20), JWT-guarded; capability checks are delegated to the
// service (view to read a tally, comment to cast, edit to run a session).
func mountWhiteboard(api chi.Router, wb *whiteboard.Service, acct *accounts.Service) {
	api.Group(func(r chi.Router) {
		r.Use(requireAuth(acct))
		r.Post("/designs/{id}/whiteboard/sessions", wbOpenSessionHandler(wb))
		r.Post("/designs/{id}/whiteboard/sessions/{sid}/state", wbSessionStateHandler(wb))
		r.Get("/designs/{id}/whiteboard/sessions/{sid}", wbTallyHandler(wb))
		r.Post("/designs/{id}/whiteboard/votes", wbCastVoteHandler(wb))
	})
}

func wbProblem(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, whiteboard.ErrForbidden):
		Problem(w, r, http.StatusForbidden, "Forbidden", "you do not have permission for this action")
	case errors.Is(err, whiteboard.ErrNotFound):
		Problem(w, r, http.StatusNotFound, "Not Found", "not found")
	case errors.Is(err, whiteboard.ErrBadRequest):
		Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid request")
	case errors.Is(err, whiteboard.ErrConflict):
		Problem(w, r, http.StatusConflict, "Conflict", "the vote session is closed or you are out of votes")
	default:
		Problem(w, r, http.StatusInternalServerError, "Internal Server Error", "request failed")
	}
}

func wbOpenSessionHandler(wb *whiteboard.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			BudgetPerUser int  `json:"budgetPerUser"`
			Anonymous     bool `json:"anonymous"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		u := userFrom(r.Context())
		v, err := wb.OpenSession(r.Context(), chi.URLParam(r, "id"), u.ID, body.BudgetPerUser, body.Anonymous)
		if err != nil {
			wbProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, v)
	}
}

func wbSessionStateHandler(wb *whiteboard.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Open     bool `json:"open"`
			Revealed bool `json:"revealed"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		u := userFrom(r.Context())
		v, err := wb.SetSessionState(r.Context(), chi.URLParam(r, "id"), chi.URLParam(r, "sid"), u.ID, body.Open, body.Revealed)
		if err != nil {
			wbProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, v)
	}
}

func wbTallyHandler(wb *whiteboard.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		v, err := wb.Tally(r.Context(), chi.URLParam(r, "id"), chi.URLParam(r, "sid"), u.ID)
		if err != nil {
			wbProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, v)
	}
}

func wbCastVoteHandler(wb *whiteboard.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			SessionID string `json:"sessionId"`
			NodeID    string `json:"nodeId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		u := userFrom(r.Context())
		v, err := wb.CastVote(r.Context(), chi.URLParam(r, "id"), body.SessionID, body.NodeID, u.ID)
		if err != nil {
			wbProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, v)
	}
}
