// Web-search surface (F28 T16): per-workspace search-provider config (read
// viewer, write admin, key encrypted and never returned) and POST /ai/search,
// which writes ONE search-engine-style query from the caller's brief (a
// structured model call with a raw-prompt fallback), executes it through the
// configured provider behind the SSRF gate, and returns cleaned results the
// client must treat as UNTRUSTED reference material.

package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/ai"
	"hycanvas/backend/internal/aistudio"
)

func mountSearch(api chi.Router, svc *ai.Service, studio *aistudio.Service, acct *accounts.Service) {
	api.Group(func(r chi.Router) {
		r.Use(requireAuth(acct))
		r.Get("/workspaces/{id}/search-config", searchGetConfigHandler(svc, acct))
		r.Put("/workspaces/{id}/search-config", searchSetConfigHandler(svc, acct))
		r.Post("/ai/search", aiSearchHandler(svc, studio, acct))
	})
}

func searchGetConfigHandler(svc *ai.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		if !aiAssert(r, acct, id, "viewer") {
			problemWithCode(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace", "not_workspace_member")
			return
		}
		cfg, err := svc.GetSearchConfig(r.Context(), id)
		if err != nil {
			aiProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, cfg) // null when none configured
	}
}

func searchSetConfigHandler(svc *ai.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		if !aiAssert(r, acct, id, "admin") {
			problemWithCode(w, r, http.StatusForbidden, "Forbidden", "admin access required", "admin_access_required")
			return
		}
		var body struct {
			Provider string  `json:"provider"`
			BaseURL  *string `json:"baseUrl"`
			APIKey   string  `json:"apiKey"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		cfg, err := svc.SetSearchConfig(r.Context(), id, ai.SearchConfigInput{Provider: body.Provider, BaseURL: body.BaseURL, APIKey: body.APIKey})
		if err != nil {
			aiProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, cfg) // null after a clear
	}
}

func aiSearchHandler(svc *ai.Service, studio *aistudio.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			WorkspaceID string `json:"workspaceId"`
			Prompt      string `json:"prompt"`
			MaxResults  int    `json:"maxResults"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		if !aiAssert(r, acct, body.WorkspaceID, "member") {
			problemWithCode(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace", "not_workspace_member")
			return
		}
		// The query is AI-written from the brief (12 words / 200 chars, with
		// the truncated raw prompt as its own fallback inside).
		query := studio.WriteSearchQuery(r.Context(), body.WorkspaceID, body.Prompt)
		results, err := svc.Search(r.Context(), body.WorkspaceID, query, body.MaxResults)
		if err != nil {
			if errors.Is(err, ai.ErrSearchNotConfigured) {
				problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "web search is not configured for this workspace", "search_not_configured")
				return
			}
			aiProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"query": query, "results": results})
	}
}
