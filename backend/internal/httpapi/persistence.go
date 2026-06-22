package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/persistence"
)

// mountPersistence attaches the design save/load lifecycle (doc 04), each route
// scoped to the design's workspace (membership enforced, mirroring the NestJS
// guard). The user-facing POST /designs/{id}/snapshots route is intentionally
// NOT mounted here: it gates on the brand-lock validateSnapshot check, which is
// not yet ported, so it stays on the Node service via the reverse proxy (no
// brand-lock regression).
func mountPersistence(api chi.Router, p *persistence.Service, acct *accounts.Service) {
	api.With(requireAuth(acct)).Post("/designs", createDesignHandler(p, acct))
	api.With(requireAuth(acct)).Get("/designs/{id}", getDesignHandler(p, acct))
	api.With(requireAuth(acct)).Patch("/designs/{id}", renameDesignHandler(p, acct))
	api.With(requireAuth(acct)).Delete("/designs/{id}", deleteDesignHandler(p, acct))
	api.With(requireAuth(acct)).Get("/designs/{id}/file", designFileHandler(p, acct))
	api.With(requireAuth(acct)).Get("/designs/{id}/versions", listVersionsHandler(p, acct))
	api.With(requireAuth(acct)).Get("/designs/{id}/versions/{vid}/file", versionFileHandler(p, acct))
	api.With(requireAuth(acct)).Get("/designs/{id}/versions/{vid}/diff", diffHandler(p, acct))
	api.With(requireAuth(acct)).Post("/designs/{id}/versions/{vid}/restore", restoreVersionHandler(p, acct))
	api.With(requireAuth(acct)).Get("/designs/{id}/branches", branchesHandler(p, acct))
	api.With(requireAuth(acct)).Post("/designs/{id}/versions/{vid}/branch", branchHandler(p, acct))
	api.With(requireAuth(acct)).Post("/designs/{id}/restore", restoreFromTrashHandler(p, acct))
	api.With(requireAuth(acct)).Get("/workspaces/{wid}/trash", trashHandler(p, acct))
	api.With(requireAuth(acct)).Get("/workspaces/{id}/designs", listWorkspaceDesignsHandler(p, acct))
}

func persistenceProblem(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, persistence.ErrNotFound):
		Problem(w, r, http.StatusNotFound, "Not Found", "design not found")
	case errors.Is(err, persistence.ErrNoStorage):
		Problem(w, r, http.StatusServiceUnavailable, "Service Unavailable", "storage is not configured")
	default:
		Problem(w, r, http.StatusInternalServerError, "Internal Server Error", "request failed")
	}
}

// authorizeDesign resolves a design's workspace and asserts membership at minRole.
func authorizeDesign(r *http.Request, p *persistence.Service, acct *accounts.Service, designID, minRole string) (string, error) {
	ws, err := p.GetWorkspaceID(r.Context(), designID)
	if err != nil {
		return "", persistence.ErrNotFound
	}
	u := userFrom(r.Context())
	if err := acct.AssertMember(r.Context(), u.ID, ws, minRole); err != nil {
		return "", errForbidden
	}
	return ws, nil
}

var errForbidden = errors.New("forbidden")

func createDesignHandler(p *persistence.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			WorkspaceID string                 `json:"workspaceId"`
			Title       string                 `json:"title"`
			From        persistence.DesignFile `json:"from"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.WorkspaceID == "" {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "missing workspaceId")
			return
		}
		u := userFrom(r.Context())
		if err := acct.AssertMember(r.Context(), u.ID, body.WorkspaceID, "member"); err != nil {
			Problem(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace")
			return
		}
		rec, err := p.Create(r.Context(), body.WorkspaceID, body.Title, body.From, &u.ID)
		if err != nil {
			persistenceProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, rec)
	}
}

func getDesignHandler(p *persistence.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ws, err := authorizeDesign(r, p, acct, id, "viewer")
		if err != nil {
			authProblem(w, r, err)
			return
		}
		loaded, err := p.LoadFile(r.Context(), id, ws)
		if err != nil {
			persistenceProblem(w, r, err)
			return
		}
		// Match the NestJS shape: the record fields plus `recovered`.
		out := map[string]any{
			"id": loaded.Record.ID, "workspaceId": loaded.Record.WorkspaceID, "title": loaded.Record.Title,
			"schemaVersion": loaded.Record.SchemaVersion, "docKind": loaded.Record.DocKind,
			"currentSnapshotId": loaded.Record.CurrentSnapshot, "createdAt": loaded.Record.CreatedAt,
			"updatedAt": loaded.Record.UpdatedAt, "deletedAt": loaded.Record.DeletedAt, "purgeAfter": loaded.Record.PurgeAfter,
			"sourceDesignId": loaded.Record.SourceDesignID, "sourceVersionId": loaded.Record.SourceVersionID,
			"recovered": loaded.Recovered,
		}
		writeJSON(w, http.StatusOK, out)
	}
}

func renameDesignHandler(p *persistence.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Title string `json:"title"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Title == "" {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "missing title")
			return
		}
		id := chi.URLParam(r, "id")
		ws, err := authorizeDesign(r, p, acct, id, "member")
		if err != nil {
			authProblem(w, r, err)
			return
		}
		rec, err := p.Rename(r.Context(), id, ws, body.Title)
		if err != nil {
			persistenceProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, rec)
	}
}

func designFileHandler(p *persistence.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ws, err := authorizeDesign(r, p, acct, id, "viewer")
		if err != nil {
			authProblem(w, r, err)
			return
		}
		loaded, err := p.LoadFile(r.Context(), id, ws)
		if err != nil {
			persistenceProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, loaded.File)
	}
}

func listVersionsHandler(p *persistence.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ws, err := authorizeDesign(r, p, acct, id, "viewer")
		if err != nil {
			authProblem(w, r, err)
			return
		}
		page, err := p.ListVersions(r.Context(), id, ws, r.URL.Query().Get("cursor"))
		if err != nil {
			persistenceProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, page)
	}
}

func versionFileHandler(p *persistence.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ws, err := authorizeDesign(r, p, acct, id, "viewer")
		if err != nil {
			authProblem(w, r, err)
			return
		}
		file, err := p.VersionFile(r.Context(), id, ws, chi.URLParam(r, "vid"))
		if err != nil {
			persistenceProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, file)
	}
}

func diffHandler(p *persistence.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ws, err := authorizeDesign(r, p, acct, id, "viewer")
		if err != nil {
			authProblem(w, r, err)
			return
		}
		summary, err := p.Diff(r.Context(), id, ws, chi.URLParam(r, "vid"), r.URL.Query().Get("to"))
		if err != nil {
			persistenceProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, summary)
	}
}

func restoreVersionHandler(p *persistence.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ws, err := authorizeDesign(r, p, acct, id, "member")
		if err != nil {
			authProblem(w, r, err)
			return
		}
		u := userFrom(r.Context())
		entry, err := p.Restore(r.Context(), id, ws, chi.URLParam(r, "vid"), &u.ID)
		if err != nil {
			persistenceProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, entry)
	}
}

func branchesHandler(p *persistence.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ws, err := authorizeDesign(r, p, acct, id, "viewer")
		if err != nil {
			authProblem(w, r, err)
			return
		}
		branches, err := p.ListBranches(r.Context(), id, ws)
		if err != nil {
			persistenceProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, branches)
	}
}

func branchHandler(p *persistence.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Title string `json:"title"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		id := chi.URLParam(r, "id")
		ws, err := authorizeDesign(r, p, acct, id, "member")
		if err != nil {
			authProblem(w, r, err)
			return
		}
		u := userFrom(r.Context())
		rec, err := p.Branch(r.Context(), id, ws, chi.URLParam(r, "vid"), body.Title, &u.ID)
		if err != nil {
			persistenceProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, rec)
	}
}

func deleteDesignHandler(p *persistence.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ws, err := authorizeDesign(r, p, acct, id, "member")
		if err != nil {
			authProblem(w, r, err)
			return
		}
		if r.URL.Query().Get("purge") == "true" {
			err = p.Purge(r.Context(), id, ws)
		} else {
			err = p.SoftDelete(r.Context(), id, ws)
		}
		if err != nil {
			persistenceProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func restoreFromTrashHandler(p *persistence.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ws, err := authorizeDesign(r, p, acct, id, "member")
		if err != nil {
			authProblem(w, r, err)
			return
		}
		if err := p.RestoreFromTrash(r.Context(), id, ws); err != nil {
			persistenceProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func trashHandler(p *persistence.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		wid := chi.URLParam(r, "wid")
		u := userFrom(r.Context())
		if err := acct.AssertMember(r.Context(), u.ID, wid, "viewer"); err != nil {
			Problem(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace")
			return
		}
		list, err := p.ListTrash(r.Context(), wid)
		if err != nil {
			persistenceProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

func listWorkspaceDesignsHandler(p *persistence.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ws := chi.URLParam(r, "id")
		u := userFrom(r.Context())
		if err := acct.AssertMember(r.Context(), u.ID, ws, "viewer"); err != nil {
			Problem(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace")
			return
		}
		list, err := p.ListByWorkspace(r.Context(), ws, 50)
		if err != nil {
			Problem(w, r, http.StatusInternalServerError, "Internal Server Error", "could not list designs")
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

// authProblem maps the authorize helper's errors.
func authProblem(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, errForbidden) {
		Problem(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace")
		return
	}
	persistenceProblem(w, r, err)
}
