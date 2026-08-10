package httpapi

import (
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"
)

// Go's built-in mime table has no entry for .webmanifest, so ServeContent
// would fall back to sniffing (text/plain) and browsers would reject the PWA
// manifest the frontend links.
func init() {
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")
}

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
//  4. 404.html with a real 404 status for genuinely unknown paths (every real
//     route is statically exported, so an unmatched path is a true Not Found),
//     falling back to index.html if no 404 page was exported.
//
// API and realtime namespaces never fall back to HTML: an unmatched /api/* or
// /realtime path returns a problem+json 404 so clients see an API error, not the
// app shell.
// mountStatic serves the frontend from a filesystem directory (PUBLIC_DIR).
// gaID is an optional Google Analytics measurement id injected into HTML pages.
func mountStatic(r chi.Router, dir string, gaID string) {
	mountStaticFS(r, http.Dir(dir), gaID)
}

// MountStaticFS exposes the exported-frontend resolution to other servers in
// this module; the first-run setup wizard serves the same embedded UI. gaID is
// an optional Google Analytics measurement id (the setup wizard passes "").
func MountStaticFS(r chi.Router, root http.FileSystem, gaID string) {
	mountStaticFS(r, root, gaID)
}

// mountStaticFS serves the exported frontend from any http.FileSystem, so the
// same resolution logic backs both the embedded UI (single-binary production)
// and a PUBLIC_DIR directory (fallback / custom deploys).
func mountStaticFS(r chi.Router, root http.FileSystem, gaID string) {
	gaID = sanitizeGAID(gaID)
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
		serve := func(name string) { serveFile(w, req, root, name, gaID) }
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
			serve("/index.html")
			return
		}
		if exists(clean) {
			serve(clean)
			return
		}
		if !strings.HasSuffix(clean, ".html") && exists(clean+".html") {
			serve(clean + ".html")
			return
		}
		// trailingSlash export: the page is <path>/index.html.
		if !strings.HasSuffix(clean, ".html") && exists(clean+"/index.html") {
			serve(clean + "/index.html")
			return
		}
		// Pretty client-resolved dynamic routes: /editor/<id>, /shared/<token>,
		// and /present/<id> (the static export cannot emit per-value HTML for
		// user-created ids/tokens), so serve the exported page and let the
		// frontend read the value from the path. Single path segment only, and
		// never a file-looking name, so real assets and nested paths still 404
		// honestly.
		for _, route := range []string{"editor", "shared", "present"} {
			rest, ok := strings.CutPrefix(clean, "/"+route+"/")
			if !ok || rest == "" || strings.ContainsAny(rest, "/.") {
				continue
			}
			for _, cand := range []string{"/" + route + ".html", "/" + route + "/index.html"} {
				if exists(cand) {
					serve(cand)
					return
				}
			}
		}
		// Genuinely unknown path: serve the exported 404 page with a real 404
		// status; fall back to the app shell if no 404 page was exported.
		if serveNotFound(w, root, gaID) {
			return
		}
		serve("/index.html")
	})
}

// serveNotFound writes the exported 404.html with a 404 status. Returns false
// when no 404 page is available, so the caller can fall back to the app shell.
func serveNotFound(w http.ResponseWriter, root http.FileSystem, gaID string) bool {
	f, err := root.Open("/404.html")
	if err != nil {
		return false
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		return false
	}
	body, err := io.ReadAll(f)
	if err != nil {
		return false
	}
	body = injectGA(body, gaID)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusNotFound)
	_, _ = w.Write(body)
	return true
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

func serveFile(w http.ResponseWriter, req *http.Request, root http.FileSystem, name string, gaID string) {
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
	// HTML pages get the analytics snippet injected at serve time (when enabled),
	// so a self-hoster's tracking id is a runtime env setting, not baked into the
	// embedded build. The body changes length, so it is written directly rather
	// than via ServeContent (whose Range/If-Modified handling assumes the file on
	// disk); HTML pages are small and not range-requested.
	if gaID != "" && strings.HasSuffix(name, ".html") {
		body, rerr := io.ReadAll(f)
		if rerr == nil {
			body = injectGA(body, gaID)
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(body)
			return
		}
		// Read failed: fall through to ServeContent from the still-open file.
	}
	// Hashed Next assets are content-addressed and safe to cache aggressively.
	if strings.HasPrefix(name, "/_next/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	http.ServeContent(w, req, info.Name(), info.ModTime(), f)
}

// sanitizeGAID keeps only the characters a Google Analytics measurement id can
// contain (e.g. "G-XXXXXXXXXX"), so an operator-supplied value can never break
// out of the injected script attribute or add markup. An unexpected value is
// reduced to its safe characters; an all-invalid value becomes "" (disabled).
func sanitizeGAID(id string) string {
	id = strings.TrimSpace(id)
	if id == "" {
		return ""
	}
	var b strings.Builder
	for _, r := range id {
		if r == '-' || r == '_' || (r >= '0' && r <= '9') || (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// injectGA inserts the Google Analytics gtag.js snippet just before </head> in
// an HTML document. It is a no-op when gaID is empty or the document has no head
// (the app shell always does). gaID is assumed already sanitized.
func injectGA(html []byte, gaID string) []byte {
	if gaID == "" {
		return html
	}
	lower := strings.ToLower(string(html))
	idx := strings.Index(lower, "</head>")
	if idx < 0 {
		return html
	}
	snippet := `<script async src="https://www.googletagmanager.com/gtag/js?id=` + gaID + `"></script>` +
		`<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}` +
		`gtag('js',new Date());gtag('config','` + gaID + `');</script>`
	out := make([]byte, 0, len(html)+len(snippet))
	out = append(out, html[:idx]...)
	out = append(out, snippet...)
	out = append(out, html[idx:]...)
	return out
}

// localesOverlay serves /locales/<tag>.json from a directory on disk, falling
// back to whatever the build embedded.
//
// Translations are the one asset a self-hoster has to be able to add WITHOUT
// rebuilding. The production packaging is a single binary with the frontend
// baked in by go:embed, and the embedded filesystem takes precedence over
// PUBLIC_DIR, so without this a new language would mean recompiling the
// product. That is the opposite of the promise the catalog format makes, where
// a translator's contribution is one JSON file.
//
// The overlay is read-only, scoped to a single prefix, and only consulted when
// LOCALES_DIR names a real directory, so it cannot shadow the application.
type localesOverlay struct {
	base http.FileSystem
	dir  http.FileSystem
}

const localesPrefix = "/locales/"

func (o localesOverlay) Open(name string) (http.File, error) {
	clean := filepath.Clean("/" + strings.TrimPrefix(name, "/"))
	if o.dir != nil && strings.HasPrefix(clean, localesPrefix) && strings.HasSuffix(clean, ".json") {
		rel := strings.TrimPrefix(clean, localesPrefix)
		// Clean already removed any "..", so rel cannot escape the directory.
		if f, err := o.dir.Open("/" + rel); err == nil {
			return f, nil
		}
	}
	return o.base.Open(name)
}

// withLocalesDir wraps root so an operator-supplied translation directory wins
// over the embedded copy. An empty or missing dir returns root unchanged.
func withLocalesDir(root http.FileSystem, dir string) http.FileSystem {
	if dir == "" {
		return root
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return root
	}
	return localesOverlay{base: root, dir: http.Dir(dir)}
}
