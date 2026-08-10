package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/authz"
	"hycanvas/backend/internal/brand"
	"hycanvas/backend/internal/persistence"
	"hycanvas/backend/internal/sharing"
)

// mountPersistence attaches the design save/load lifecycle (doc 04), each route
// scoped to the design's workspace (membership enforced, mirroring the NestJS
// guard). The user-facing POST /designs/{id}/snapshots route is intentionally
// NOT mounted here: it gates on the brand-lock validateSnapshot check, which is
// not yet ported, so it stays on the Node service via the reverse proxy (no
// brand-lock regression).
func mountPersistence(api chi.Router, p *persistence.Service, acct *accounts.Service, sh *sharing.Service, br *brand.Service) {
	api.With(requireAuth(acct)).Post("/designs", createDesignHandler(p, acct))
	api.With(requireAuth(acct)).Get("/designs/{id}", getDesignHandler(p, acct, sh))
	api.With(requireAuth(acct)).Patch("/designs/{id}", renameDesignHandler(p, acct))
	api.With(requireAuth(acct)).Delete("/designs/{id}", deleteDesignHandler(p, acct))
	api.With(requireAuth(acct)).Get("/designs/{id}/file", designFileHandler(p, acct, sh))
	api.With(requireAuth(acct)).Get("/designs/{id}/versions", listVersionsHandler(p, acct, sh))
	api.With(requireAuth(acct)).Get("/designs/{id}/versions/{vid}/file", versionFileHandler(p, acct, sh))
	api.With(requireAuth(acct)).Get("/designs/{id}/versions/{vid}/diff", diffHandler(p, acct, sh))
	api.With(requireAuth(acct)).Get("/designs/{id}/updates", updateLogHandler(p, acct, sh))
	api.With(requireAuth(acct)).Post("/designs/{id}/updates/checkpoint", checkpointUpdateLogHandler(p, acct))
	api.With(requireAuth(acct)).Post("/designs/{id}/versions/{vid}/restore", restoreVersionHandler(p, acct, br))
	api.With(requireAuth(acct)).Get("/designs/{id}/branches", branchesHandler(p, acct, sh))
	api.With(requireAuth(acct)).Post("/designs/{id}/versions/{vid}/branch", branchHandler(p, acct))
	api.With(requireAuth(acct)).Get("/designs/{id}/crdt-branches", listCrdtBranchesHandler(p, acct, sh))
	api.With(requireAuth(acct)).Post("/designs/{id}/crdt-branches", createCrdtBranchHandler(p, acct))
	api.With(requireAuth(acct)).Post("/designs/{id}/restore", restoreFromTrashHandler(p, acct))
	api.With(requireAuth(acct)).Get("/workspaces/{wid}/trash", trashHandler(p, acct))
	api.With(requireAuth(acct)).Get("/workspaces/{id}/designs", listWorkspaceDesignsHandler(p, acct))
}

func persistenceProblem(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, persistence.ErrNotFound):
		problemWithCode(w, r, http.StatusNotFound, "Not Found", "design not found", "design_not_found")
	case errors.Is(err, persistence.ErrNoStorage):
		problemWithCode(w, r, http.StatusServiceUnavailable, "Service Unavailable", "storage is not configured", "storage_is_not_configured")
	case errors.Is(err, persistence.ErrInvalidFile):
		// Surface the specific violated invariant (e.g. `duplicate node id "x"`).
		// The reasons carry only ids/types, never design content, and the saver
		// already holds the full file, so this leaks nothing and turns an opaque
		// 422 into a diagnosable one.
		slog.Warn("design file rejected", "path", r.URL.Path, "reason", err.Error())
		problemWithCode(w, r, http.StatusUnprocessableEntity, "Unprocessable Entity", "the design file is structurally invalid: "+err.Error(), "design_file_invalid")
	case errors.Is(err, persistence.ErrInvalidBranch):
		problemWithCode(w, r, http.StatusUnprocessableEntity, "Unprocessable Entity", err.Error(), "design_file_rejected")
	default:
		problemWithCode(w, r, http.StatusInternalServerError, "Internal Server Error", "request failed", "request_failed")
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

// authorizeDesignRead authorizes a viewer-level read of a design. Workspace
// members pass via the membership fast path; a non-member is allowed only if a
// per-design grant (or an active link session recorded as a grant) resolves to
// at least view access. This is what lets an external recipient open a design
// shared with them: the membership-only path would reject them. Write paths stay
// membership-only (authorizeDesign). sh may be nil (sharing disabled), in which
// case this degrades to membership-only.
func authorizeDesignRead(r *http.Request, p *persistence.Service, acct *accounts.Service, sh *sharing.Service, designID string) (string, error) {
	ws, err := p.GetWorkspaceID(r.Context(), designID)
	if err != nil {
		return "", persistence.ErrNotFound
	}
	u := userFrom(r.Context())
	if err := acct.AssertMember(r.Context(), u.ID, ws, "viewer"); err == nil {
		return ws, nil
	}
	if sh != nil {
		if access, aerr := sh.GetAccess(r.Context(), designID, u.ID); aerr == nil {
			for _, c := range access.Capabilities {
				if c == authz.CapView {
					return ws, nil
				}
			}
		}
	}
	return "", errForbidden
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
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "missing workspaceId", "missing_workspaceid")
			return
		}
		u := userFrom(r.Context())
		if err := acct.AssertMember(r.Context(), u.ID, body.WorkspaceID, "member"); err != nil {
			problemWithCode(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace", "not_workspace_member")
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

func getDesignHandler(p *persistence.Service, acct *accounts.Service, sh *sharing.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ws, err := authorizeDesignRead(r, p, acct, sh, id)
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
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "missing title", "missing_title")
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

func designFileHandler(p *persistence.Service, acct *accounts.Service, sh *sharing.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ws, err := authorizeDesignRead(r, p, acct, sh, id)
		if err != nil {
			authProblem(w, r, err)
			return
		}
		// ?trashed=1 lets WORKSPACE MEMBERS preview a design that sits in the
		// trash (the dashboard Trash cards need a real thumbnail to decide what
		// to restore). Share-grant visitors fall through to the normal load,
		// which keeps trashed designs NotFound for them until restored.
		load := p.LoadFile
		if r.URL.Query().Get("trashed") == "1" {
			u := userFrom(r.Context())
			if acct.AssertMember(r.Context(), u.ID, ws, "viewer") == nil {
				load = p.LoadFileIncludingTrashed
			}
		}
		loaded, err := load(r.Context(), id, ws)
		if err != nil {
			persistenceProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, loaded.File)
	}
}

func listVersionsHandler(p *persistence.Service, acct *accounts.Service, sh *sharing.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ws, err := authorizeDesignRead(r, p, acct, sh, id)
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

func versionFileHandler(p *persistence.Service, acct *accounts.Service, sh *sharing.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ws, err := authorizeDesignRead(r, p, acct, sh, id)
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

func diffHandler(p *persistence.Service, acct *accounts.Service, sh *sharing.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ws, err := authorizeDesignRead(r, p, acct, sh, id)
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

// updateLogHandler serves the append-only CRDT update log in seq order so the
// client can fold frames into an ephemeral Y.Doc and scrub history (FR-9).
// ?afterSeq= pages forward (0 = start); ?limit= caps the page (server-capped).
func updateLogHandler(p *persistence.Service, acct *accounts.Service, sh *sharing.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ws, err := authorizeDesignRead(r, p, acct, sh, id)
		if err != nil {
			authProblem(w, r, err)
			return
		}
		afterSeq, _ := strconv.ParseInt(r.URL.Query().Get("afterSeq"), 10, 64)
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		// ?branch= selects an in-CRDT branch lineage (FR-10): the parent prefix up
		// to the fork plus the branch's own rows, one ascending seq stream. Empty =
		// the main lineage, exactly as before.
		page, err := p.ListBranchUpdates(r.Context(), id, ws, r.URL.Query().Get("branch"), afterSeq, limit)
		if err != nil {
			persistenceProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, page)
	}
}

// checkpointUpdateLogHandler journals a client-produced CRDT full-state update as
// a checkpoint and compacts the log (FR-11). The body is a base64 y-protocols
// update frame (the same format the realtime hub journals), produced from the
// live Y.Doc via encodeStateAsUpdate.
func checkpointUpdateLogHandler(p *persistence.Service, acct *accounts.Service) http.HandlerFunc {
	const maxCheckpointBytes = 20 << 20 // mirror the realtime update size cap
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		if _, err := authorizeDesign(r, p, acct, id, "member"); err != nil {
			authProblem(w, r, err)
			return
		}
		var body struct {
			Update string `json:"update"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Update == "" {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "missing update", "missing_update")
			return
		}
		raw, err := base64.StdEncoding.DecodeString(body.Update)
		if err != nil || len(raw) == 0 || len(raw) > maxCheckpointBytes {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid or oversized update", "invalid_or_oversized_update")
			return
		}
		// Mirror the realtime hub's guard: only a y-protocols UPDATE frame (type 2)
		// may become a checkpoint. Compaction deletes all prior history, so a frame
		// the scrubber can't fold as a full-state base must never be accepted.
		if raw[0] != 2 {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "update is not a y-protocols update frame", "crdt_update_malformed")
			return
		}
		u := userFrom(r.Context())
		// ?branch= scopes the checkpoint (and its compaction) to that in-CRDT
		// branch's lineage; empty = main. An unknown branch must 404 rather than
		// silently journaling into a dead scope.
		branch := r.URL.Query().Get("branch")
		if branch != "" && !p.BranchBelongsToDesign(r.Context(), id, branch) {
			problemWithCode(w, r, http.StatusNotFound, "Not Found", "unknown branch", "unknown_branch")
			return
		}
		if err := p.AppendCheckpoint(r.Context(), id, branch, raw, u.ID); err != nil {
			persistenceProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func restoreVersionHandler(p *persistence.Service, acct *accounts.Service, br *brand.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ws, err := authorizeDesign(r, p, acct, id, "member")
		if err != nil {
			authProblem(w, r, err)
			return
		}
		u := userFrom(r.Context())
		vid := chi.URLParam(r, "vid")
		// Restore persists the historical file as the current version, so it is
		// a save and must pass the same brand-lock gate as the snapshot route:
		// a non-manage-brand member must not resurrect off-kit content while a
		// lock is on. br is nil when brand kits are disabled.
		if br != nil {
			file, ferr := p.VersionFile(r.Context(), id, ws, vid)
			if ferr != nil {
				persistenceProblem(w, r, ferr)
				return
			}
			if berr := br.ValidateSnapshot(r.Context(), id, ws, u.ID, file); berr != nil {
				if errors.Is(berr, brand.ErrBrandLocked) {
					problemWithCode(w, r, http.StatusBadRequest, "Bad Request", berr.Error(), "restore_failed")
					return
				}
				problemWithCode(w, r, http.StatusInternalServerError, "Internal Server Error", "brand validation failed", "brand_validation_failed")
				return
			}
		}
		entry, err := p.Restore(r.Context(), id, ws, vid, &u.ID)
		if err != nil {
			persistenceProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, entry)
	}
}

// listCrdtBranchesHandler serves the design's in-CRDT named branches (FR-10),
// distinct from the fork-model /branches (designs copied from a version).
func listCrdtBranchesHandler(p *persistence.Service, acct *accounts.Service, sh *sharing.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ws, err := authorizeDesignRead(r, p, acct, sh, id)
		if err != nil {
			authProblem(w, r, err)
			return
		}
		branches, err := p.ListCrdtBranches(r.Context(), id, ws)
		if err != nil {
			persistenceProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, branches)
	}
}

// createCrdtBranchHandler forks a named in-CRDT branch from a history point
// (FR-10): {name, forkedFromSeq, parentBranchId?}. Member-gated like other
// design mutations; never touches existing history (purely additive).
func createCrdtBranchHandler(p *persistence.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ws, err := authorizeDesign(r, p, acct, id, "member")
		if err != nil {
			authProblem(w, r, err)
			return
		}
		var body struct {
			Name           string  `json:"name"`
			ForkedFromSeq  int64   `json:"forkedFromSeq"`
			ParentBranchID *string `json:"parentBranchId"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		u := userFrom(r.Context())
		branch, err := p.CreateCrdtBranch(r.Context(), id, ws, body.Name, body.ForkedFromSeq, body.ParentBranchID, &u.ID)
		if err != nil {
			persistenceProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, branch)
	}
}

func branchesHandler(p *persistence.Service, acct *accounts.Service, sh *sharing.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ws, err := authorizeDesignRead(r, p, acct, sh, id)
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
			problemWithCode(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace", "not_workspace_member")
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
			problemWithCode(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace", "not_workspace_member")
			return
		}
		list, err := p.ListByWorkspace(r.Context(), ws, 50)
		if err != nil {
			problemWithCode(w, r, http.StatusInternalServerError, "Internal Server Error", "could not list designs", "could_not_list_designs")
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

// authProblem maps the authorize helper's errors.
func authProblem(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, errForbidden) {
		problemWithCode(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace", "not_workspace_member")
		return
	}
	persistenceProblem(w, r, err)
}
