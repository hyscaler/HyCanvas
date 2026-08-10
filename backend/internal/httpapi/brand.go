package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/brand"
	"hycanvas/backend/internal/persistence"
)

// mountBrand attaches the brand kit-management surface (doc 18 slice A), all
// JWT-guarded. Reads need workspace membership; writes need manage-brand. The
// design-scoped brand routes (assign/resolve/lint/gate/pin/reviewed/locked-
// regions) stay on the Node service until persistence snapshot writes are ported.
func mountBrand(api chi.Router, br *brand.Service, acct *accounts.Service) {
	api.Group(func(r chi.Router) {
		r.Use(requireAuth(acct))
		r.Get("/workspaces/{wid}/brand-kits", brandListHandler(br))
		r.Post("/workspaces/{wid}/brand-kits", brandCreateHandler(br))
		r.Get("/brand-kits/{id}", brandGetHandler(br))
		r.Patch("/brand-kits/{id}", brandUpdateHandler(br))
		r.Delete("/brand-kits/{id}", brandDeleteHandler(br))
		r.Post("/brand-kits/{id}/default", brandSetDefaultHandler(br))
		r.Get("/brand-kits/{id}/versions", brandVersionsHandler(br))
		r.Post("/brand-kits/{id}/restore", brandRestoreHandler(br))
		// Design-scoped brand (FR-2, FR-6, FR-10, FR-11). The brand-lint + gate
		// routes stay on the Node service (they need the @hc/brandkit linter).
		r.Get("/designs/{id}/brand", brandResolveHandler(br))
		r.Post("/designs/{id}/brand", brandAssignHandler(br))
		r.Post("/designs/{id}/brand-version", brandVersionPinHandler(br))
		r.Post("/designs/{id}/brand-reviewed", brandReviewedHandler(br))
		r.Post("/designs/{id}/brand-locked-regions", brandLockedRegionsHandler(br))
		r.Get("/designs/{id}/brand-updates", brandUpdatesHandler(br))
		// Lint + pre-export gate (FR-7, FR-8).
		r.Get("/designs/{id}/brand-lint", brandLintHandler(br))
		r.Get("/designs/{id}/brand-lint/gate", brandLintGateHandler(br))
	})
}

func brandLintHandler(br *brand.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		violations, err := br.LintDesign(r.Context(), chi.URLParam(r, "id"), u.ID)
		if err != nil {
			brandProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, violations)
	}
}

func brandLintGateHandler(br *brand.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		result, err := br.LintGate(r.Context(), chi.URLParam(r, "id"), u.ID)
		if err != nil {
			brandProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	}
}

func brandProblem(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, brand.ErrForbidden):
		problemWithCode(w, r, http.StatusForbidden, "Forbidden", "you do not have permission to manage brand kits", "brand_kit_forbidden")
	case errors.Is(err, brand.ErrNotFound):
		problemWithCode(w, r, http.StatusNotFound, "Not Found", "brand kit not found", "brand_kit_not_found")
	case errors.Is(err, brand.ErrBadRequest):
		problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid request", "invalid_request")
	default:
		problemWithCode(w, r, http.StatusInternalServerError, "Internal Server Error", "request failed", "request_failed")
	}
}

func brandListHandler(br *brand.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		kits, err := br.ListKits(r.Context(), chi.URLParam(r, "wid"), u.ID)
		if err != nil {
			brandProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, kits)
	}
}

func brandCreateHandler(br *brand.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name      string `json:"name"`
			IsDefault *bool  `json:"isDefault"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		u := userFrom(r.Context())
		kit, err := br.CreateKit(r.Context(), chi.URLParam(r, "wid"), u.ID, body.Name, body.IsDefault)
		if err != nil {
			brandProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, kit)
	}
}

func brandGetHandler(br *brand.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		kit, err := br.GetKit(r.Context(), chi.URLParam(r, "id"), u.ID)
		if err != nil {
			brandProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, kit)
	}
}

func brandUpdateHandler(br *brand.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var raw map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		in := brand.UpdateInput{}
		if v, ok := raw["name"]; ok {
			_ = json.Unmarshal(v, &in.Name)
		}
		if v, ok := raw["isDefault"]; ok {
			_ = json.Unmarshal(v, &in.IsDefault)
		}
		if v, ok := raw["palettes"]; ok {
			in.Palettes = v
		}
		if v, ok := raw["fonts"]; ok {
			in.Fonts = v
		}
		if v, ok := raw["logos"]; ok {
			in.Logos = v
		}
		if v, ok := raw["voice"]; ok {
			in.VoiceSet = true
			in.Voice = v
		}
		if v, ok := raw["collections"]; ok {
			in.Collections = v
		}
		if v, ok := raw["controls"]; ok {
			in.ControlsRaw = v
		}
		u := userFrom(r.Context())
		kit, err := br.UpdateKit(r.Context(), chi.URLParam(r, "id"), u.ID, in)
		if err != nil {
			brandProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, kit)
	}
}

func brandDeleteHandler(br *brand.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		if err := br.DeleteKit(r.Context(), chi.URLParam(r, "id"), u.ID); err != nil {
			brandProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func brandSetDefaultHandler(br *brand.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		kit, err := br.SetDefault(r.Context(), chi.URLParam(r, "id"), u.ID)
		if err != nil {
			brandProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, kit)
	}
}

func brandVersionsHandler(br *brand.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		versions, err := br.ListVersions(r.Context(), chi.URLParam(r, "id"), u.ID)
		if err != nil {
			brandProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, versions)
	}
}

func brandRestoreHandler(br *brand.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Version int `json:"version"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		u := userFrom(r.Context())
		kit, err := br.RestoreVersion(r.Context(), chi.URLParam(r, "id"), u.ID, body.Version)
		if err != nil {
			brandProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, kit)
	}
}

func brandResolveHandler(br *brand.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		rb, err := br.ResolveDesignBrand(r.Context(), chi.URLParam(r, "id"), u.ID)
		if err != nil {
			brandProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, rb)
	}
}

func brandAssignHandler(br *brand.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			BrandKitID *string `json:"brandKitId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		id := ""
		if body.BrandKitID != nil {
			id = *body.BrandKitID
		}
		u := userFrom(r.Context())
		rb, err := br.AssignDesignBrand(r.Context(), chi.URLParam(r, "id"), u.ID, id)
		if err != nil {
			brandProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, rb)
	}
}

func brandVersionPinHandler(br *brand.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Version *int `json:"version"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		// null / omitted -> track latest (-1).
		version := -1
		if body.Version != nil {
			version = *body.Version
		}
		u := userFrom(r.Context())
		rb, err := br.SetDesignBrandVersion(r.Context(), chi.URLParam(r, "id"), u.ID, version)
		if err != nil {
			brandProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, rb)
	}
}

func brandReviewedHandler(br *brand.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		rb, err := br.MarkBrandReviewed(r.Context(), chi.URLParam(r, "id"), u.ID)
		if err != nil {
			brandProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, rb)
	}
}

func brandLockedRegionsHandler(br *brand.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var raw map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		var nodeIDs []string
		if v, ok := raw["nodeIds"]; ok {
			_ = json.Unmarshal(v, &nodeIDs)
		}
		var fields []persistence.BrandEditableField
		_, editableSet := raw["editableFields"]
		if editableSet {
			_ = json.Unmarshal(raw["editableFields"], &fields)
		}
		u := userFrom(r.Context())
		rb, err := br.SetDesignLockedRegions(r.Context(), chi.URLParam(r, "id"), u.ID, nodeIDs, fields, editableSet)
		if err != nil {
			brandProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, rb)
	}
}

func brandUpdatesHandler(br *brand.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		summary, err := br.BrandUpdates(r.Context(), chi.URLParam(r, "id"), u.ID)
		if err != nil {
			brandProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, summary)
	}
}
