package httpapi

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/persistence"
	"hycanvas/backend/internal/render"
)

// mountRender attaches the server-side export surface (doc 11): the Go rendering
// engine serializes a design's page to a downloadable format. SVG is wired here;
// PDF/PNG/JPG/video follow as the engine grows. Membership-gated like the rest
// of the persistence surface.
func mountRender(api chi.Router, p *persistence.Service, acct *accounts.Service) {
	api.With(requireAuth(acct)).Get("/designs/{id}/render.svg", renderSVGHandler(p, acct))
	api.With(requireAuth(acct)).Get("/designs/{id}/render.pdf", renderPDFHandler(p, acct))
	api.With(requireAuth(acct)).Get("/designs/{id}/render.png", renderRasterHandler(p, acct, "png"))
	api.With(requireAuth(acct)).Get("/designs/{id}/render.jpg", renderRasterHandler(p, acct, "jpg"))
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
				Problem(w, r, http.StatusServiceUnavailable, "Service Unavailable", "video encoding is unavailable (ffmpeg not installed)")
				return
			}
			Problem(w, r, http.StatusBadRequest, "Bad Request", "could not render video")
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

func renderRasterHandler(p *persistence.Service, acct *accounts.Service, format string) http.HandlerFunc {
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
		var out []byte
		var mime string
		if format == "jpg" {
			quality := 90
			if v := r.URL.Query().Get("quality"); v != "" {
				if n, err := strconv.Atoi(v); err == nil {
					quality = n
				}
			}
			out, err = render.ToJPEG(render.Design(loaded.File), page, scale, quality)
			mime = "image/jpeg"
		} else {
			out, err = render.ToPNG(render.Design(loaded.File), page, scale)
			mime = "image/png"
		}
		if err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "page index out of range")
			return
		}
		w.Header().Set("Content-Type", mime)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(out)
	}
}

func renderPDFHandler(p *persistence.Service, acct *accounts.Service) http.HandlerFunc {
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
		pdf, err := render.ToPDF(render.Design(loaded.File), page)
		if err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "page index out of range")
			return
		}
		w.Header().Set("Content-Type", "application/pdf")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(pdf)
	}
}

func renderSVGHandler(p *persistence.Service, acct *accounts.Service) http.HandlerFunc {
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
		svg, err := render.ToSVG(render.Design(loaded.File), page)
		if err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "page index out of range")
			return
		}
		w.Header().Set("Content-Type", "image/svg+xml")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(svg))
	}
}
