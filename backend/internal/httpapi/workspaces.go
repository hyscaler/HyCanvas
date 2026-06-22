package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
)

// mountWorkspaces attaches the workspace collection routes (doc 15 FR-10):
// GET /api/v1/workspaces (the caller's workspaces with role) and
// POST /api/v1/workspaces (create a team/org/classroom). Both require auth.
// Membership/invitation sub-resources are handled elsewhere.
func mountWorkspaces(api chi.Router, svc *accounts.Service) {
	api.With(requireAuth(svc)).Get("/workspaces", listWorkspacesHandler(svc))
	api.With(requireAuth(svc)).Post("/workspaces", createWorkspaceHandler(svc))
}

func listWorkspacesHandler(svc *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		list, err := svc.ListWorkspaces(r.Context(), u.ID)
		if err != nil {
			Problem(w, r, http.StatusInternalServerError, "Internal Server Error", "could not list workspaces")
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

func createWorkspaceHandler(svc *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name string `json:"name"`
			Kind string `json:"kind"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		u := userFrom(r.Context())
		ws, err := svc.CreateWorkspace(r.Context(), u.ID, body.Name, body.Kind)
		if err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, ws)
	}
}
