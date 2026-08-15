package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
)

// mountWorkspaces attaches the workspace collection routes (doc 15 FR-10):
// GET /api/v1/workspaces (the caller's workspaces with role),
// POST /api/v1/workspaces (create a team/org/classroom), and
// DELETE /api/v1/workspaces/{id} (owner-only, cascades). All require auth.
// Membership/invitation sub-resources are handled elsewhere.
func mountWorkspaces(api chi.Router, svc *accounts.Service) {
	api.With(requireAuth(svc)).Get("/workspaces", listWorkspacesHandler(svc))
	api.With(requireAuth(svc)).Post("/workspaces", createWorkspaceHandler(svc))
	api.With(requireAuth(svc)).Delete("/workspaces/{id}", deleteWorkspaceHandler(svc))
}

func deleteWorkspaceHandler(svc *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		if err := svc.DeleteWorkspace(r.Context(), u.ID, chi.URLParam(r, "id")); err != nil {
			membersProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func listWorkspacesHandler(svc *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		list, err := svc.ListWorkspaces(r.Context(), u.ID)
		if err != nil {
			problemWithCode(w, r, http.StatusInternalServerError, "Internal Server Error", "could not list workspaces", "could_not_list_workspaces")
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
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		u := userFrom(r.Context())
		ws, err := svc.CreateWorkspace(r.Context(), u.ID, body.Name, body.Kind)
		if err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", err.Error(), "workspace_create_failed")
			return
		}
		writeJSON(w, http.StatusCreated, ws)
	}
}
