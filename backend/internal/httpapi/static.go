package httpapi

import (
	"net/http"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"
)

// mountStatic serves the statically-exported Next.js frontend from dir, so the
// single binary serves the whole product (UI + API + realtime) on one port,
// matching the NestJS bundle it replaces. It is wired as the router's NotFound
// handler, so it only runs for paths no API/realtime route claimed.
//
// Next's `output: "export"` (with `trailingSlash: true`) emits hashed immutable
// assets under /_next plus per-route directories holding index.html (e.g.
// /login/index.html, /dashboard/index.html). Resolution order for a GET:
//  1. exact file (assets, /_next/*, favicon, ...)
//  2. <path>.html (per-route export pages without trailingSlash)
//  3. <path>/index.html (per-route export pages with trailingSlash)
//  4. index.html (SPA fallback for client-routed paths)
//
// API and realtime namespaces never fall back to HTML: an unmatched /api/* or
// /realtime path returns a problem+json 404 so clients see an API error, not the
// app shell.
// mountStatic serves the frontend from a filesystem directory (PUBLIC_DIR).
func mountStatic(r chi.Router, dir string) {
	mountStaticFS(r, http.Dir(dir))
}

// mountStaticFS serves the exported frontend from any http.FileSystem, so the
// same resolution logic backs both the embedded UI (single-binary production)
// and a PUBLIC_DIR directory (fallback / custom deploys).
func mountStaticFS(r chi.Router, root http.FileSystem) {
	exists := func(rel string) bool {
		f, err := root.Open(rel)
		if err != nil {
			return false
		}
		defer f.Close()
		info, err := f.Stat()
		return err == nil && !info.IsDir()
	}
	r.NotFound(func(w http.ResponseWriter, req *http.Request) {
		p := req.URL.Path
		if req.Method != http.MethodGet && req.Method != http.MethodHead {
			Problem(w, req, http.StatusNotFound, "Not Found", "no route for "+req.Method+" "+p)
			return
		}
		if strings.HasPrefix(p, "/api/") || p == "/api" || strings.HasPrefix(p, "/realtime") {
			Problem(w, req, http.StatusNotFound, "Not Found", "no route for "+p)
			return
		}

		clean := filepath.Clean("/" + strings.TrimPrefix(p, "/"))
		if clean == "/" {
			serveFile(w, req, root, "/index.html")
			return
		}
		if exists(clean) {
			serveFile(w, req, root, clean)
			return
		}
		if !strings.HasSuffix(clean, ".html") && exists(clean+".html") {
			serveFile(w, req, root, clean+".html")
			return
		}
		// trailingSlash export: the page is <path>/index.html.
		if !strings.HasSuffix(clean, ".html") && exists(clean+"/index.html") {
			serveFile(w, req, root, clean+"/index.html")
			return
		}
		// Client-routed path with no exported page: serve the app shell.
		serveFile(w, req, root, "/index.html")
	})
}

// apiOnlyNotice is the page served for non-API GET routes when no frontend is
// available (no embedded UI and no PUBLIC_DIR). It points developers at the dev
// frontend and the production build instead of returning a bare JSON 404.
const apiOnlyNotice = `<!doctype html><html><head><meta charset="utf-8">` +
	`<title>HyCanvas (API only)</title></head>` +
	`<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5">` +
	`<h1>HyCanvas (API only)</h1>` +
	`<p>This binary is running without an embedded frontend.</p>` +
	`<ul>` +
	`<li><strong>Development:</strong> run <code>npm run dev</code> and open the Next.js dev server at <a href="http://localhost:3000">http://localhost:3000</a>.</li>` +
	`<li><strong>Production:</strong> build the single self-contained binary with <code>npm run build:dist</code> (frontend baked in via <code>-tags embed</code>), or point <code>PUBLIC_DIR</code> at an exported frontend.</li>` +
	`</ul>` +
	`<p>The API is live under <code>/api/v1</code>; health is at <code>/healthz</code>.</p>` +
	`</body></html>`

// mountAPIOnlyNotice serves a helpful page for non-API GET routes when there is
// no frontend to serve. API and realtime namespaces still return problem+json.
func mountAPIOnlyNotice(r chi.Router) {
	r.NotFound(func(w http.ResponseWriter, req *http.Request) {
		p := req.URL.Path
		if (req.Method == http.MethodGet || req.Method == http.MethodHead) &&
			!strings.HasPrefix(p, "/api/") && p != "/api" && !strings.HasPrefix(p, "/realtime") {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(apiOnlyNotice))
			return
		}
		Problem(w, req, http.StatusNotFound, "Not Found", "no route for "+req.Method+" "+p)
	})
}

func serveFile(w http.ResponseWriter, req *http.Request, root http.FileSystem, name string) {
	f, err := root.Open(name)
	if err != nil {
		Problem(w, req, http.StatusNotFound, "Not Found", "no route for "+req.URL.Path)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		Problem(w, req, http.StatusNotFound, "Not Found", "no route for "+req.URL.Path)
		return
	}
	// Hashed Next assets are content-addressed and safe to cache aggressively.
	if strings.HasPrefix(name, "/_next/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	http.ServeContent(w, req, info.Name(), info.ModTime(), f)
}
