// Workspace API-key management (F40 E01): mint, list, revoke. Session-only on
// purpose (the allowlist in apikeyauth.go does not include these routes, so a
// key can never mint or revoke keys), and admin-gated: keys grant programmatic
// access to workspace content, which is an administration decision.
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/apikeys"
)

func mountAPIKeys(api chi.Router, keys *apikeys.Service, acct *accounts.Service) {
	api.With(requireAuth(acct)).Post("/workspaces/{id}/api-keys", mintAPIKeyHandler(keys, acct))
	api.With(requireAuth(acct)).Get("/workspaces/{id}/api-keys", listAPIKeysHandler(keys, acct))
	api.With(requireAuth(acct)).Delete("/workspaces/{id}/api-keys/{keyId}", revokeAPIKeyHandler(keys, acct))
}

func apiKeysAssertAdmin(w http.ResponseWriter, r *http.Request, acct *accounts.Service, workspaceID string) bool {
	u := userFrom(r.Context())
	if apiKeyFrom(r.Context()) != nil {
		// Defense in depth: the allowlist already excludes these routes.
		problemWithCode(w, r, http.StatusForbidden, "Forbidden", "this endpoint is not available to API keys", "api_key_route_not_allowed")
		return false
	}
	if err := acct.AssertMember(r.Context(), u.ID, workspaceID, "admin"); err != nil {
		problemWithCode(w, r, http.StatusForbidden, "Forbidden", "admin access required", "admin_access_required")
		return false
	}
	return true
}

func mintAPIKeyHandler(keys *apikeys.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ws := chi.URLParam(r, "id")
		if !apiKeysAssertAdmin(w, r, acct, ws) {
			return
		}
		var body struct {
			Label  string   `json:"label"`
			Scopes []string `json:"scopes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		u := userFrom(r.Context())
		raw, view, err := keys.Mint(r.Context(), ws, u.ID, body.Label, body.Scopes)
		if errors.Is(err, apikeys.ErrBadRequest) {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "a label and at least one valid scope (generate, read, export) are required", "api_key_invalid_input")
			return
		}
		if err != nil {
			problemWithCode(w, r, http.StatusInternalServerError, "Internal Server Error", "could not create the API key", "api_key_create_failed")
			return
		}
		// The ONLY response that ever carries the raw key.
		writeJSON(w, http.StatusCreated, map[string]any{"key": raw, "view": view})
	}
}

func listAPIKeysHandler(keys *apikeys.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ws := chi.URLParam(r, "id")
		if !apiKeysAssertAdmin(w, r, acct, ws) {
			return
		}
		out, err := keys.List(r.Context(), ws)
		if err != nil {
			problemWithCode(w, r, http.StatusInternalServerError, "Internal Server Error", "could not list API keys", "api_key_list_failed")
			return
		}
		writeJSON(w, http.StatusOK, out)
	}
}

func revokeAPIKeyHandler(keys *apikeys.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ws := chi.URLParam(r, "id")
		if !apiKeysAssertAdmin(w, r, acct, ws) {
			return
		}
		err := keys.Revoke(r.Context(), chi.URLParam(r, "keyId"), ws)
		if errors.Is(err, apikeys.ErrNotFound) {
			problemWithCode(w, r, http.StatusNotFound, "Not Found", "API key not found", "api_key_not_found")
			return
		}
		if err != nil {
			problemWithCode(w, r, http.StatusInternalServerError, "Internal Server Error", "could not revoke the API key", "api_key_revoke_failed")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
