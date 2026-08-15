package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/bulkcreate"
)

// mountBulkCreate attaches the data-merge routes (doc 27): bulk-create from a
// template or design, a design's fillable fields, and single-design autofill.
func mountBulkCreate(api chi.Router, svc *bulkcreate.Service, acct *accounts.Service) {
	api.With(requireAuth(acct)).Post("/designs/bulk-create", bulkCreateHandler(svc))
	api.With(requireAuth(acct)).Get("/designs/{id}/fillable-fields", designFieldsHandler(svc))
	api.With(requireAuth(acct)).Post("/designs/{id}/autofill", autofillHandler(svc))
}

func bulkCreateHandler(svc *bulkcreate.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in bulkcreate.Input
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		u := userFrom(r.Context())
		res, err := svc.BulkCreate(r.Context(), u.ID, in)
		if err != nil {
			bulkProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, res)
	}
}

func designFieldsHandler(svc *bulkcreate.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		fields, err := svc.DesignFields(r.Context(), u.ID, chi.URLParam(r, "id"))
		if err != nil {
			bulkProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, fields)
	}
}

func autofillHandler(svc *bulkcreate.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Values bulkcreate.FillValues `json:"values"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		id := chi.URLParam(r, "id")
		u := userFrom(r.Context())
		if err := svc.Autofill(r.Context(), u.ID, id, body.Values); err != nil {
			bulkProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"designId": id})
	}
}

// bulkProblem maps service errors: bad-request inputs to 400, missing access to
// 403, everything else to 500.
func bulkProblem(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, bulkcreate.ErrBadRequest):
		problemWithCode(w, r, http.StatusBadRequest, "Bad Request", err.Error(), "bulk_create_failed")
	case errors.Is(err, accounts.ErrForbidden):
		problemWithCode(w, r, http.StatusForbidden, "Forbidden", "not permitted", "not_permitted")
	default:
		problemWithCode(w, r, http.StatusInternalServerError, "Internal Server Error", "request failed", "request_failed")
	}
}
