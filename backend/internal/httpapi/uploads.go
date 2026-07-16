package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/uploads"
)

// mountUploads attaches the uploads + asset organization surface (doc 12). All
// routes are JWT-guarded except the public content-delivery route, which serves
// asset bytes for local/mock delivery (membership is enforced on every mutating
// and listing route).
func mountUploads(api chi.Router, up *uploads.Service, acct *accounts.Service) {
	api.Group(func(r chi.Router) {
		r.Use(requireAuth(acct))
		r.Post("/workspaces/{id}/assets", uploadHandler(up))
		r.Post("/workspaces/{id}/assets/from-url", importURLHandler(up))
		r.Get("/workspaces/{id}/assets", listAssetsHandler(up))
		r.Get("/workspaces/{id}/assets/usage", usageHandler(up))
		r.Patch("/assets/{id}", updateAssetHandler(up))
		r.Delete("/assets/{id}", removeAssetHandler(up))
		r.Get("/workspaces/{id}/asset-folders", listFoldersHandler(up))
		r.Post("/workspaces/{id}/asset-folders", createFolderHandler(up))
		r.Patch("/asset-folders/{id}", renameFolderHandler(up))
		r.Delete("/asset-folders/{id}", deleteFolderHandler(up))
		// Direct (presigned) uploads: init the handshake, then complete once the
		// bytes are in storage.
		r.Post("/workspaces/{id}/uploads/direct", directInitHandler(up))
		r.Post("/uploads/direct/{id}/complete", directCompleteHandler(up))
	})
	// The api-put leg of a direct upload: raw bytes, authenticated by the
	// grant's one-time token (presigned semantics: no session cookie needed).
	api.Put("/uploads/direct/{id}", directReceiveHandler(up))
	// Public content delivery (local/mock); the bytes are served to any caller.
	api.Get("/assets/{id}/content", assetContentHandler(up))
}

func uploadsProblem(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, uploads.ErrForbidden):
		Problem(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace")
	case errors.Is(err, uploads.ErrNotFound):
		Problem(w, r, http.StatusNotFound, "Not Found", "not found")
	case errors.Is(err, uploads.ErrBadRequest):
		Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid upload request")
	case errors.Is(err, uploads.ErrQuota), errors.Is(err, uploads.ErrUserQuota), errors.Is(err, uploads.ErrImportSize):
		// The detail distinguishes the workspace quota from the global
		// per-user limit so clients can word the error accordingly.
		Problem(w, r, http.StatusRequestEntityTooLarge, "Payload Too Large", err.Error())
	case errors.Is(err, uploads.ErrUploadIncomplete):
		// Complete arrived before the bytes did; the client can retry.
		Problem(w, r, http.StatusConflict, "Conflict", err.Error())
	default:
		Problem(w, r, http.StatusInternalServerError, "Internal Server Error", "request failed")
	}
}

func uploadHandler(up *uploads.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Filename   string  `json:"filename"`
			DataBase64 string  `json:"dataBase64"`
			FolderID   *string `json:"folderId"`
			Thumbnail  string  `json:"thumbnail"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.DataBase64 == "" {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "missing dataBase64")
			return
		}
		u := userFrom(r.Context())
		a, err := up.Upload(r.Context(), u.ID, chi.URLParam(r, "id"), body.Filename, body.DataBase64, body.FolderID, body.Thumbnail)
		if err != nil {
			uploadsProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, a)
	}
}

func importURLHandler(up *uploads.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			URL      string  `json:"url"`
			FolderID *string `json:"folderId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.URL == "" {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "missing url")
			return
		}
		u := userFrom(r.Context())
		a, err := up.ImportFromURL(r.Context(), u.ID, chi.URLParam(r, "id"), body.URL, body.FolderID)
		if err != nil {
			uploadsProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, a)
	}
}

func listAssetsHandler(up *uploads.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		q := r.URL.Query()
		var folderID *string
		folderSet := false
		if q.Has("folderId") {
			folderSet = true
			v := q.Get("folderId")
			if v != "" && v != "root" {
				folderID = &v
			}
		}
		assets, err := up.List(r.Context(), u.ID, chi.URLParam(r, "id"), folderID, folderSet, q.Get("tag"), q.Get("q"))
		if err != nil {
			uploadsProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, assets)
	}
}

func usageHandler(up *uploads.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		usage, err := up.UsageView(r.Context(), u.ID, chi.URLParam(r, "id"))
		if err != nil {
			uploadsProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, usage)
	}
}

func updateAssetHandler(up *uploads.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var raw map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		var filename *string
		if v, ok := raw["filename"]; ok {
			_ = json.Unmarshal(v, &filename)
		}
		var folderID *string
		_, folderSet := raw["folderId"]
		if folderSet {
			_ = json.Unmarshal(raw["folderId"], &folderID)
		}
		var tags *[]string
		if v, ok := raw["tags"]; ok {
			var t []string
			if json.Unmarshal(v, &t) == nil {
				tags = &t
			}
		}
		u := userFrom(r.Context())
		a, err := up.UpdateAsset(r.Context(), u.ID, chi.URLParam(r, "id"), filename, folderID, folderSet, tags)
		if err != nil {
			uploadsProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, a)
	}
}

func removeAssetHandler(up *uploads.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		if err := up.Remove(r.Context(), u.ID, chi.URLParam(r, "id")); err != nil {
			uploadsProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func listFoldersHandler(up *uploads.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		folders, err := up.ListFolders(r.Context(), u.ID, chi.URLParam(r, "id"))
		if err != nil {
			uploadsProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, folders)
	}
}

func createFolderHandler(up *uploads.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name     string  `json:"name"`
			ParentID *string `json:"parentId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		u := userFrom(r.Context())
		f, err := up.CreateFolder(r.Context(), u.ID, chi.URLParam(r, "id"), body.Name, body.ParentID)
		if err != nil {
			uploadsProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, f)
	}
}

func renameFolderHandler(up *uploads.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		u := userFrom(r.Context())
		f, err := up.RenameFolder(r.Context(), u.ID, chi.URLParam(r, "id"), body.Name)
		if err != nil {
			uploadsProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, f)
	}
}

func deleteFolderHandler(up *uploads.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		if err := up.DeleteFolder(r.Context(), u.ID, chi.URLParam(r, "id")); err != nil {
			uploadsProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func assetContentHandler(up *uploads.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		bytes, mime, err := up.Content(r.Context(), chi.URLParam(r, "id"))
		if err != nil {
			uploadsProblem(w, r, err)
			return
		}
		w.Header().Set("Content-Type", mime)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(bytes)
	}
}

// directInitHandler starts a direct upload: quota-gates the declared size and
// returns the upload grant (presigned S3 POST or the API's streaming PUT).
func directInitHandler(up *uploads.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Filename string  `json:"filename"`
			ByteSize int64   `json:"byteSize"`
			FolderID *string `json:"folderId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ByteSize <= 0 {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "missing or invalid byteSize")
			return
		}
		u := userFrom(r.Context())
		grant, err := up.InitDirectUpload(r.Context(), u.ID, chi.URLParam(r, "id"), body.Filename, body.ByteSize, body.FolderID)
		if err != nil {
			uploadsProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, grant)
	}
}

// directReceiveHandler streams the raw body into storage for an api-put grant.
// MaxBytesReader caps the read at the ceiling a grant can carry, so an
// oversized body fails fast instead of filling the disk; the exact per-grant
// declared size is enforced at complete.
func directReceiveHandler(up *uploads.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body := http.MaxBytesReader(w, r.Body, uploads.MaxDirectUploadBytes())
		err := up.ReceiveDirectUpload(r.Context(), chi.URLParam(r, "id"), r.URL.Query().Get("token"), body)
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				Problem(w, r, http.StatusRequestEntityTooLarge, "Payload Too Large", "upload exceeds the maximum file size")
				return
			}
			uploadsProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// directCompleteHandler validates the stored object and promotes it to an
// asset, returning the same UploadedAsset shape as the legacy JSON upload.
func directCompleteHandler(up *uploads.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Thumbnail string `json:"thumbnail"`
		}
		// The body is optional (thumbnail only), so a decode error is not fatal.
		_ = json.NewDecoder(r.Body).Decode(&body)
		u := userFrom(r.Context())
		asset, err := up.CompleteDirectUpload(r.Context(), u.ID, chi.URLParam(r, "id"), body.Thumbnail)
		if err != nil {
			uploadsProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, asset)
	}
}
