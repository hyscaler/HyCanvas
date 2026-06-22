package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/templates"
)

// mountTemplates attaches the templates catalog + apply + collections (doc 14).
// All JWT-guarded; visibility scope is enforced in the service. Static segments
// (collections) are registered before the {id} param routes.
func mountTemplates(api chi.Router, tm *templates.Service, acct *accounts.Service) {
	api.Group(func(r chi.Router) {
		r.Use(requireAuth(acct))
		r.Get("/templates", templatesListHandler(tm))
		r.Post("/templates", templatesSaveHandler(tm))
		r.Get("/templates/collections", templatesListCollectionsHandler(tm))
		r.Post("/templates/collections", templatesCreateCollectionHandler(tm))
		r.Delete("/templates/collections/{id}", templatesDeleteCollectionHandler(tm))
		r.Get("/templates/{id}", templatesGetHandler(tm))
		r.Get("/templates/{id}/file", templatesFileHandler(tm))
		r.Get("/templates/{id}/fillable-fields", templatesFillableHandler(tm))
		r.Post("/templates/{id}/apply", templatesApplyHandler(tm))
		r.Post("/templates/{id}/collection", templatesAssignCollectionHandler(tm))
	})
}

func templatesProblem(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, templates.ErrForbidden):
		Problem(w, r, http.StatusForbidden, "Forbidden", "you do not have permission for this action")
	case errors.Is(err, templates.ErrNotFound):
		Problem(w, r, http.StatusNotFound, "Not Found", "template not found")
	case errors.Is(err, templates.ErrBadRequest):
		Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid request")
	default:
		Problem(w, r, http.StatusInternalServerError, "Internal Server Error", "request failed")
	}
}

func templatesListHandler(tm *templates.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		query := templates.TemplateQuery{Text: q.Get("q"), Color: q.Get("color")}
		if c := q.Get("category"); c != "" {
			query.Categories = strings.Split(c, ",")
		}
		u := userFrom(r.Context())
		list, err := tm.List(r.Context(), u.ID, query, q.Get("workspaceId"), q.Get("collection"))
		if err != nil {
			templatesProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

func templatesSaveHandler(tm *templates.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			WorkspaceID  string         `json:"workspaceId"`
			DesignID     string         `json:"designId"`
			File         map[string]any `json:"file"`
			Title        string         `json:"title"`
			Category     string         `json:"category"`
			Tags         []string       `json:"tags"`
			Thumbnail    string         `json:"thumbnail"`
			Visibility   string         `json:"visibility"`
			CollectionID string         `json:"collectionId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		u := userFrom(r.Context())
		t, err := tm.SaveAsTemplate(r.Context(), u.ID, templates.SaveInput{
			WorkspaceID: body.WorkspaceID, DesignID: body.DesignID, File: body.File, Title: body.Title,
			Category: body.Category, Tags: body.Tags, Thumbnail: body.Thumbnail,
			Visibility: body.Visibility, CollectionID: body.CollectionID,
		})
		if err != nil {
			templatesProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, t)
	}
}

func templatesGetHandler(tm *templates.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		t, err := tm.Get(r.Context(), u.ID, chi.URLParam(r, "id"))
		if err != nil {
			templatesProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, t)
	}
}

func templatesFileHandler(tm *templates.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		f, err := tm.GetFile(r.Context(), u.ID, chi.URLParam(r, "id"))
		if err != nil {
			templatesProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, f)
	}
}

func templatesFillableHandler(tm *templates.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		fields, err := tm.GetFillableFields(r.Context(), u.ID, chi.URLParam(r, "id"))
		if err != nil {
			templatesProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, fields)
	}
}

func templatesApplyHandler(tm *templates.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			WorkspaceID string `json:"workspaceId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.WorkspaceID == "" {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "missing workspaceId")
			return
		}
		u := userFrom(r.Context())
		designID, err := tm.Apply(r.Context(), u.ID, chi.URLParam(r, "id"), body.WorkspaceID)
		if err != nil {
			templatesProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]string{"designId": designID})
	}
}

func templatesListCollectionsHandler(tm *templates.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		cols, err := tm.ListCollections(r.Context(), u.ID, r.URL.Query().Get("workspaceId"))
		if err != nil {
			templatesProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, cols)
	}
}

func templatesCreateCollectionHandler(tm *templates.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			WorkspaceID string `json:"workspaceId"`
			Name        string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		u := userFrom(r.Context())
		col, err := tm.CreateCollection(r.Context(), u.ID, body.WorkspaceID, body.Name)
		if err != nil {
			templatesProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, col)
	}
}

func templatesDeleteCollectionHandler(tm *templates.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		if err := tm.DeleteCollection(r.Context(), u.ID, chi.URLParam(r, "id")); err != nil {
			templatesProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func templatesAssignCollectionHandler(tm *templates.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			CollectionID string `json:"collectionId"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		u := userFrom(r.Context())
		t, err := tm.AssignCollection(r.Context(), u.ID, chi.URLParam(r, "id"), body.CollectionID)
		if err != nil {
			templatesProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, t)
	}
}
