package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

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
	// The chunked form of the same leg. A CDN in front of the instance caps a
	// single request body (Cloudflare: 100 MB), so a large file arrives as a
	// sequence of appends instead. GET reports how much the server holds, which
	// is what lets an interrupted upload resume rather than start over.
	api.Patch("/uploads/direct/{id}", directChunkHandler(up))
	api.Get("/uploads/direct/{id}/offset", directOffsetHandler(up))
	// Public content delivery (local/mock); the bytes are served to any caller.
	// HEAD is mounted alongside GET (chi routes methods separately) so clients
	// can probe existence/size without downloading; ServeContent handles both.
	api.Get("/assets/{id}/content", assetContentHandler(up))
	api.Head("/assets/{id}/content", assetContentHandler(up))
	// Preview proxy (540p) for heavy videos; 404 when none exists.
	api.Get("/assets/{id}/proxy", assetProxyHandler(up))
	api.Head("/assets/{id}/proxy", assetProxyHandler(up))
}

func uploadsProblem(w http.ResponseWriter, r *http.Request, err error) {
	// Each branch carries a stable `code` so the frontend can translate the
	// failure (F38 FR-9); the English detail stays as the fallback wording.
	switch {
	case errors.Is(err, uploads.ErrForbidden):
		problemWithCode(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace", "upload_forbidden")
	case errors.Is(err, uploads.ErrNotFound):
		problemWithCode(w, r, http.StatusNotFound, "Not Found", "not found", "upload_not_found")
	case errors.Is(err, uploads.ErrBadRequest):
		problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid upload request", "upload_invalid")
	case errors.Is(err, uploads.ErrQuota):
		// The detail distinguishes the workspace quota from the global
		// per-user limit so clients can word the error accordingly.
		problemWithCode(w, r, http.StatusRequestEntityTooLarge, "Payload Too Large", err.Error(), "workspace_storage_full")
	case errors.Is(err, uploads.ErrUserQuota):
		problemWithCode(w, r, http.StatusRequestEntityTooLarge, "Payload Too Large", err.Error(), "account_storage_full")
	case errors.Is(err, uploads.ErrFileTooLarge):
		problemWithCode(w, r, http.StatusRequestEntityTooLarge, "Payload Too Large", "the file exceeds the maximum upload size", "upload_file_too_large")
	case errors.Is(err, uploads.ErrImportSize):
		problemWithCode(w, r, http.StatusRequestEntityTooLarge, "Payload Too Large", err.Error(), "import_too_large")
	case errors.Is(err, uploads.ErrUploadIncomplete):
		// Complete arrived before the bytes did; the client can retry.
		problemWithCode(w, r, http.StatusConflict, "Conflict", err.Error(), "upload_incomplete")
	default:
		problemWithCode(w, r, http.StatusInternalServerError, "Internal Server Error", "request failed", "upload_failed")
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
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "missing dataBase64", "missing_database64")
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
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "missing url", "missing_url")
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
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
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
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
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
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
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

func assetProxyHandler(up *uploads.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, ok := up.ProxyContent(r.Context(), chi.URLParam(r, "id"))
		if !ok {
			problemWithCode(w, r, http.StatusNotFound, "Not Found", "no proxy for this asset", "no_proxy_for_this_asset")
			return
		}
		w.Header().Set("Content-Type", "video/mp4")
		http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(data))
	}
}

func assetContentHandler(up *uploads.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Streamed, not buffered: a <video> element issues many Range requests
		// while loading and seeking, and reading the whole object per request
		// meant a 300 MB video re-downloaded 300 MB every time. On S3 that
		// exceeded the per-operation timeout, so large videos failed to play at
		// all while small ones were fine.
		rc, _, mime, err := up.OpenContent(r.Context(), chi.URLParam(r, "id"))
		if err != nil {
			uploadsProblem(w, r, err)
			return
		}
		defer func() { _ = rc.Close() }()
		w.Header().Set("Content-Type", mime)
		// ServeContent adds Accept-Ranges/206 partial responses. Browsers treat
		// media without Range support as UNSEEKABLE (currentTime snaps to 0),
		// which broke video scrubbing, filmstrips, and scene detection; it also
		// lets <video> fetch only the parts it needs of large files.
		http.ServeContent(w, r, "", time.Time{}, rc)
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
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "missing or invalid byteSize", "upload_bad_size")
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
				problemWithCode(w, r, http.StatusRequestEntityTooLarge, "Payload Too Large", "upload exceeds the maximum file size", "upload_too_large")
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

// directChunkHandler appends one chunk of a direct upload at the offset the
// client claims, and answers with the offset the server now holds.
//
// An offset mismatch is a 409 carrying the server's real offset, not a failure:
// a client whose connection dropped mid-chunk re-reads the offset and continues
// from there, so a 300 MB upload never restarts from zero.
func directChunkHandler(up *uploads.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		offset, err := strconv.ParseInt(r.Header.Get("Upload-Offset"), 10, 64)
		if err != nil || offset < 0 {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "missing or invalid Upload-Offset", "upload_bad_offset")
			return
		}
		// Bound one chunk well below any CDN body cap; the whole-file ceiling is
		// enforced separately against the grant's declared size.
		body := http.MaxBytesReader(w, r.Body, uploads.MaxChunkBytes())
		received, err := up.ReceiveDirectUploadChunk(r.Context(), chi.URLParam(r, "id"), r.URL.Query().Get("token"), offset, body)
		if err != nil {
			var mismatch *uploads.ErrChunkOffset
			if errors.As(err, &mismatch) {
				w.Header().Set("Upload-Offset", strconv.FormatInt(mismatch.Expected, 10))
				problemWithCode(w, r, http.StatusConflict, "Conflict", mismatch.Error(), "upload_offset_mismatch")
				return
			}
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				problemWithCode(w, r, http.StatusRequestEntityTooLarge, "Payload Too Large", "chunk exceeds the maximum chunk size", "upload_chunk_too_large")
				return
			}
			uploadsProblem(w, r, err)
			return
		}
		w.Header().Set("Upload-Offset", strconv.FormatInt(received, 10))
		writeJSON(w, http.StatusOK, map[string]int64{"receivedBytes": received})
	}
}

// directOffsetHandler reports how many bytes of an upload the server holds, so
// a client can resume after an interruption.
func directOffsetHandler(up *uploads.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		received, err := up.DirectUploadOffset(r.Context(), chi.URLParam(r, "id"), r.URL.Query().Get("token"))
		if err != nil {
			uploadsProblem(w, r, err)
			return
		}
		w.Header().Set("Upload-Offset", strconv.FormatInt(received, 10))
		writeJSON(w, http.StatusOK, map[string]int64{"receivedBytes": received})
	}
}
