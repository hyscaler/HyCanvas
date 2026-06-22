package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/approvals"
)

// mountApprovals attaches the approval-workflow surface (doc 17 slice C), all
// JWT-guarded. Capability checks are delegated to the service.
func mountApprovals(api chi.Router, ap *approvals.Service, acct *accounts.Service) {
	api.Group(func(r chi.Router) {
		r.Use(requireAuth(acct))
		r.Get("/designs/{id}/approval", approvalGetHandler(ap))
		r.Post("/designs/{id}/approvals", approvalRequestHandler(ap))
		r.Post("/approvals/{aid}/decide", approvalDecideHandler(ap))
		r.Post("/approvals/{aid}/reopen", approvalReopenHandler(ap))
	})
}

func approvalProblem(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, approvals.ErrForbidden):
		Problem(w, r, http.StatusForbidden, "Forbidden", "you do not have permission for this action")
	case errors.Is(err, approvals.ErrNotFound):
		Problem(w, r, http.StatusNotFound, "Not Found", "approval not found")
	case errors.Is(err, approvals.ErrConflict):
		Problem(w, r, http.StatusConflict, "Conflict", "the approval is not in a valid state for this action")
	case errors.Is(err, approvals.ErrBadRequest):
		Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid request")
	default:
		Problem(w, r, http.StatusInternalServerError, "Internal Server Error", "request failed")
	}
}

func approvalGetHandler(ap *approvals.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		v, err := ap.GetForDesign(r.Context(), chi.URLParam(r, "id"), u.ID)
		if err != nil {
			approvalProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, v)
	}
}

func approvalRequestHandler(ap *approvals.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ApproverIDs []string `json:"approverIds"`
			Policy      string   `json:"policy"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		u := userFrom(r.Context())
		v, err := ap.Request(r.Context(), chi.URLParam(r, "id"), u.ID, approvals.RequestInput{ApproverIDs: body.ApproverIDs, Policy: body.Policy})
		if err != nil {
			approvalProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, v)
	}
}

func approvalDecideHandler(ap *approvals.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Decision string  `json:"decision"`
			Note     *string `json:"note"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		u := userFrom(r.Context())
		v, err := ap.Decide(r.Context(), chi.URLParam(r, "aid"), u.ID, approvals.DecideInput{Decision: body.Decision, Note: body.Note})
		if err != nil {
			approvalProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, v)
	}
}

func approvalReopenHandler(ap *approvals.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		v, err := ap.Reopen(r.Context(), chi.URLParam(r, "aid"), u.ID)
		if err != nil {
			approvalProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, v)
	}
}
