package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/docexport"
	"hycanvas/backend/internal/jobs"
	"hycanvas/backend/internal/persistence"
	"hycanvas/backend/internal/render"
	"hycanvas/backend/internal/storage"
)

// mountExport attaches the async export surface (doc 29 video, doc 31 doc). The
// work runs inline: the POST renders + stores the artifact, records a completed
// job (the client polls GET /jobs/:id), and the matching download route streams
// the stored bytes after re-checking ownership and the design-scoped key.
func mountExport(api chi.Router, p *persistence.Service, store storage.Driver, reg *jobs.Registry, acct *accounts.Service) {
	api.With(requireAuth(acct)).Post("/designs/{id}/export/video", videoExportHandler(p, store, reg, acct))
	api.With(requireAuth(acct)).Get("/designs/{id}/export/video/{jobId}/download", exportDownloadHandler(p, store, reg, acct, "video-export"))
	api.With(requireAuth(acct)).Post("/designs/{id}/export/doc", docExportHandler(p, store, reg, acct))
	api.With(requireAuth(acct)).Get("/designs/{id}/export/doc/{jobId}/download", exportDownloadHandler(p, store, reg, acct, "doc-export"))
}

func videoExportHandler(p *persistence.Service, store storage.Driver, reg *jobs.Registry, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ws, err := authorizeDesign(r, p, acct, id, "viewer")
		if err != nil {
			authProblem(w, r, err)
			return
		}
		u := userFrom(r.Context())
		job := reg.Start(u.ID, "video-export")
		loaded, err := p.LoadFile(r.Context(), id, ws)
		if err != nil {
			reg.Fail(job.ID, "load failed")
			writeJSON(w, http.StatusOK, map[string]any{"jobId": job.ID})
			return
		}
		mp4, err := render.ToVideo(r.Context(), render.Design(loaded.File), 0,
			render.VideoOptions{FPS: 30, DurationMs: 3000, Scale: 1})
		if err != nil {
			reg.Fail(job.ID, "encode failed")
			writeJSON(w, http.StatusOK, map[string]any{"jobId": job.ID})
			return
		}
		key := "designs/" + id + "/exports/video-" + job.ID + ".mp4"
		if _, err := store.Put(key, mp4); err != nil {
			reg.Fail(job.ID, "store failed")
			writeJSON(w, http.StatusOK, map[string]any{"jobId": job.ID})
			return
		}
		reg.Complete(job.ID, map[string]any{"key": key, "format": "mp4"},
			&jobs.Blob{Key: key, ContentType: "video/mp4", Filename: "export-" + id + ".mp4"})
		writeJSON(w, http.StatusOK, map[string]any{"jobId": job.ID})
	}
}

func docExportHandler(p *persistence.Service, store storage.Driver, reg *jobs.Registry, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Format string `json:"format"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Format != "docx" && body.Format != "pdf" {
			Problem(w, r, http.StatusBadRequest, "Bad Request", `format must be "docx" or "pdf"`)
			return
		}
		id := chi.URLParam(r, "id")
		ws, err := authorizeDesign(r, p, acct, id, "viewer")
		if err != nil {
			authProblem(w, r, err)
			return
		}
		u := userFrom(r.Context())
		job := reg.Start(u.ID, "doc-export")
		loaded, err := p.LoadFile(r.Context(), id, ws)
		if err != nil {
			reg.Fail(job.ID, "load failed")
			writeJSON(w, http.StatusOK, map[string]any{"jobId": job.ID})
			return
		}
		blocks := docexport.ResolveBlocks(loaded.File)
		title, _ := loaded.File["title"].(string)
		if title == "" {
			title = "Document"
		}
		var bytesOut []byte
		var ctype, ext string
		if body.Format == "docx" {
			bytesOut, err = docexport.BuildDOCX(blocks, title)
			ctype = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
			ext = "docx"
		} else {
			bytesOut, err = docexport.BuildPDF(blocks, title)
			ctype = "application/pdf"
			ext = "pdf"
		}
		if err != nil {
			reg.Fail(job.ID, "render failed")
			writeJSON(w, http.StatusOK, map[string]any{"jobId": job.ID})
			return
		}
		key := "designs/" + id + "/exports/doc-" + job.ID + "." + ext
		if _, err := store.Put(key, bytesOut); err != nil {
			reg.Fail(job.ID, "store failed")
			writeJSON(w, http.StatusOK, map[string]any{"jobId": job.ID})
			return
		}
		reg.Complete(job.ID, map[string]any{"key": key, "format": body.Format},
			&jobs.Blob{Key: key, ContentType: ctype, Filename: "document-" + id + "." + ext})
		writeJSON(w, http.StatusOK, map[string]any{"jobId": job.ID})
	}
}

// exportDownloadHandler streams a completed export's stored bytes. It re-checks
// design access, that the job is the caller's, completed, of the expected kind,
// and that its stored key is scoped to this design (no cross-design read).
func exportDownloadHandler(p *persistence.Service, store storage.Driver, reg *jobs.Registry, acct *accounts.Service, jobName string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		if _, err := authorizeDesign(r, p, acct, id, "viewer"); err != nil {
			authProblem(w, r, err)
			return
		}
		u := userFrom(r.Context())
		job, ok := reg.Get(u.ID, chi.URLParam(r, "jobId"))
		if !ok || job.Name != jobName || job.Status != jobs.StatusCompleted || job.Blob == nil {
			Problem(w, r, http.StatusNotFound, "Not Found", "export not found")
			return
		}
		if !strings.HasPrefix(job.Blob.Key, "designs/"+id+"/") {
			Problem(w, r, http.StatusNotFound, "Not Found", "export not found")
			return
		}
		data, err := store.Get(job.Blob.Key)
		if err != nil || data == nil {
			Problem(w, r, http.StatusNotFound, "Not Found", "export not found")
			return
		}
		w.Header().Set("Content-Type", job.Blob.ContentType)
		w.Header().Set("Content-Disposition", `attachment; filename="`+job.Blob.Filename+`"`)
		w.Header().Set("Cache-Control", "private, max-age=3600")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}
}
