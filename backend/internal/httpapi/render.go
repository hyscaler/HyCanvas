package httpapi

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/persistence"
	"hycanvas/backend/internal/render"
	"hycanvas/backend/internal/uploads"
)

// mountRender attaches the server-side export surface (doc 11): the Go rendering
// engine serializes a design's page to a downloadable format. SVG is wired here;
// PDF/PNG/JPG/video follow as the engine grows. Membership-gated like the rest
// of the persistence surface.
func mountRender(api chi.Router, p *persistence.Service, acct *accounts.Service, up *uploads.Service) {
	api.With(requireAuth(acct)).Get("/designs/{id}/render.svg", renderSVGHandler(p, acct, up))
	api.With(requireAuth(acct)).Get("/designs/{id}/render.pdf", renderPDFHandler(p, acct, up))
	api.With(requireAuth(acct)).Get("/designs/{id}/render.png", renderRasterHandler(p, acct, up, "png"))
	api.With(requireAuth(acct)).Get("/designs/{id}/render.jpg", renderRasterHandler(p, acct, up, "jpg"))
	api.With(requireAuth(acct)).Get("/designs/{id}/render.mp4", renderVideoHandler(p, acct))
}

func renderVideoHandler(p *persistence.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ws, err := authorizeDesign(r, p, acct, id, "viewer")
		if err != nil {
			authProblem(w, r, err)
			return
		}
		q := r.URL.Query()
		page := atoiOr(q.Get("page"), 0)
		opts := render.VideoOptions{
			FPS:        atoiOr(q.Get("fps"), 30),
			DurationMs: atoiOr(q.Get("durationMs"), 3000),
			Scale:      1,
		}
		loaded, err := p.LoadFile(r.Context(), id, ws)
		if err != nil {
			persistenceProblem(w, r, err)
			return
		}
		mp4, err := render.ToVideo(r.Context(), render.Design(loaded.File), page, opts)
		if err != nil {
			if errors.Is(err, render.ErrNoFFmpeg) {
				problemWithCode(w, r, http.StatusServiceUnavailable, "Service Unavailable", "video encoding is unavailable (ffmpeg not installed)", "ffmpeg_unavailable")
				return
			}
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "could not render video", "could_not_render_video")
			return
		}
		w.Header().Set("Content-Type", "video/mp4")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(mp4)
	}
}

func atoiOr(s string, def int) int {
	if s == "" {
		return def
	}
	if n, err := strconv.Atoi(s); err == nil {
		return n
	}
	return def
}

func renderRasterHandler(p *persistence.Service, acct *accounts.Service, up *uploads.Service, format string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ws, err := authorizeDesign(r, p, acct, id, "viewer")
		if err != nil {
			authProblem(w, r, err)
			return
		}
		page := 0
		if v := r.URL.Query().Get("page"); v != "" {
			if n, err := strconv.Atoi(v); err == nil {
				page = n
			}
		}
		scale := 1.0
		if v := r.URL.Query().Get("scale"); v != "" {
			if f, err := strconv.ParseFloat(v, 64); err == nil && f > 0 && f <= 8 {
				scale = f
			}
		}
		loaded, err := p.LoadFile(r.Context(), id, ws)
		if err != nil {
			persistenceProblem(w, r, err)
			return
		}
		// Inline referenced image/pattern asset bytes so images render (the raster
		// exporter draws from embedded bytes, not workspace asset ids).
		var fetch assetContent
		if up != nil {
			fetch = func(aid string) ([]byte, string, error) { return up.ContentInWorkspace(r.Context(), ws, aid) }
		}
		file := embedDesignFileAssets(fetch, loaded.File)
		var out []byte
		var mime string
		if format == "jpg" {
			quality := 90
			if v := r.URL.Query().Get("quality"); v != "" {
				if n, err := strconv.Atoi(v); err == nil {
					quality = n
				}
			}
			out, err = render.ToJPEG(render.Design(file), page, scale, quality)
			mime = "image/jpeg"
		} else {
			out, err = render.ToPNG(render.Design(file), page, scale)
			mime = "image/png"
		}
		if err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "page index out of range", "page_index_out_of_range")
			return
		}
		w.Header().Set("Content-Type", mime)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(out)
	}
}

// pdfImageSource lets the PDF encoder embed an asset's pixels while `render`
// stays pure: it resolves an asset id to bytes through the uploads service. A
// nil service, or an asset that will not load, yields no pixels rather than an
// error, so one broken upload degrades a single image instead of failing the
// export.
func pdfImageSource(r *http.Request, up *uploads.Service, ws string) render.ImageSource {
	if up == nil {
		return nil
	}
	return func(assetID string) ([]byte, bool) {
		data, _, err := up.ContentInWorkspace(r.Context(), ws, assetID)
		if err != nil || len(data) == 0 {
			return nil, false
		}
		return data, true
	}
}

func renderPDFHandler(p *persistence.Service, acct *accounts.Service, up *uploads.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ws, err := authorizeDesign(r, p, acct, id, "viewer")
		if err != nil {
			authProblem(w, r, err)
			return
		}
		// `?page=all` exports the whole deck as one tagged document (doc 28
		// FR-22). Any other value keeps the original per-page behavior, so an
		// existing caller sees exactly what it saw before.
		deck := r.URL.Query().Get("page") == "all"
		page := 0
		if v := r.URL.Query().Get("page"); v != "" && !deck {
			if n, err := strconv.Atoi(v); err == nil {
				page = n
			}
		}
		loaded, err := p.LoadFile(r.Context(), id, ws)
		if err != nil {
			persistenceProblem(w, r, err)
			return
		}
		var pdf []byte
		src := pdfImageSource(r, up, ws)
		if deck {
			pdf, err = render.ToDeckPDF(render.Design(loaded.File), src)
		} else {
			pdf, err = render.ToPDF(render.Design(loaded.File), page, src)
		}
		if err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "page index out of range", "page_index_out_of_range")
			return
		}
		w.Header().Set("Content-Type", "application/pdf")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(pdf)
	}
}

func renderSVGHandler(p *persistence.Service, acct *accounts.Service, up *uploads.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		ws, err := authorizeDesign(r, p, acct, id, "viewer")
		if err != nil {
			authProblem(w, r, err)
			return
		}
		page := 0
		if v := r.URL.Query().Get("page"); v != "" {
			if n, err := strconv.Atoi(v); err == nil {
				page = n
			}
		}
		loaded, err := p.LoadFile(r.Context(), id, ws)
		if err != nil {
			persistenceProblem(w, r, err)
			return
		}
		var fetch assetContent
		if up != nil {
			fetch = func(aid string) ([]byte, string, error) { return up.ContentInWorkspace(r.Context(), ws, aid) }
		}
		svg, err := render.ToSVG(render.Design(embedDesignFileAssets(fetch, loaded.File)), page)
		if err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "page index out of range", "page_index_out_of_range")
			return
		}
		w.Header().Set("Content-Type", "image/svg+xml")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(svg))
	}
}
