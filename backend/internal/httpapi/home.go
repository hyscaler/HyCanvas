package httpapi

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/home"
)

func mountHome(api chi.Router, h *home.Service, acct *accounts.Service) {
	api.With(requireAuth(acct)).Get("/workspaces/{id}/home", homeSectionHandler(h))
	api.With(requireAuth(acct)).Get("/search", searchHandler(h))
	api.With(requireAuth(acct)).Post("/designs/{id}/favorite", favoriteHandler(h, true))
	api.With(requireAuth(acct)).Delete("/designs/{id}/favorite", favoriteHandler(h, false))
}

func homeSectionHandler(h *home.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ws := chi.URLParam(r, "id")
		section := r.URL.Query().Get("section")
		if section == "" {
			section = "recent"
		}
		u := userFrom(r.Context())
		items, err := h.Section(r.Context(), u.ID, ws, section)
		if err != nil {
			problemWithCode(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace", "not_workspace_member")
			return
		}
		writeJSON(w, http.StatusOK, items)
	}
}

func searchHandler(h *home.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		ws := q.Get("workspaceId")
		if ws == "" {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "workspaceId is required", "workspaceid_is_required")
			return
		}
		var types []string
		if t := q.Get("type"); t != "" {
			types = strings.Split(t, ",")
		}
		u := userFrom(r.Context())
		items, err := h.Search(r.Context(), u.ID, ws, q.Get("q"), types)
		if err != nil {
			problemWithCode(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace", "not_workspace_member")
			return
		}
		writeJSON(w, http.StatusOK, items)
	}
}

func favoriteHandler(h *home.Service, on bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		u := userFrom(r.Context())
		starred, err := h.SetFavorite(r.Context(), u.ID, id, on)
		if err != nil {
			problemWithCode(w, r, http.StatusForbidden, "Forbidden", "cannot favorite this design", "cannot_favorite_this_design")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"starred": starred})
	}
}
