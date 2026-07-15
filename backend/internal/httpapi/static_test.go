package httpapi

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

// TestStaticServingFS exercises the embedded-frontend path: the same resolution
// over an http.FS (as go:embed uses) rather than an http.Dir directory, so the
// single-binary build serves index.html, per-route pages, and /_next assets.
func TestStaticServingFS(t *testing.T) {
	dir := t.TempDir()
	write := func(rel, body string) {
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("index.html", "<html>shell</html>")
	write("editor/index.html", "<html>editor</html>")
	write("404.html", "<html>notfound</html>")
	write("_next/static/app.js", "console.log(1)")

	r := chi.NewRouter()
	mountStaticFS(r, http.FS(os.DirFS(dir)), "")
	srv := httptest.NewServer(r)
	defer srv.Close()
	get := func(path string) (int, string) {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		buf := make([]byte, 64)
		n, _ := resp.Body.Read(buf)
		return resp.StatusCode, string(buf[:n])
	}
	if code, body := get("/"); code != 200 || body != "<html>shell</html>" {
		t.Fatalf("fs root: %d %q", code, body)
	}
	if code, body := get("/editor"); code != 200 || body != "<html>editor</html>" {
		t.Fatalf("fs /editor: %d %q", code, body)
	}
	if code, _ := get("/_next/static/app.js"); code != 200 {
		t.Fatalf("fs /_next asset: %d", code)
	}
	if code, body := get("/unknown/route"); code != 404 || body != "<html>notfound</html>" {
		t.Fatalf("fs 404 fallback: %d %q", code, body)
	}
	// Pretty editor URLs: a single id segment serves the editor page; nested
	// paths and file-looking names still 404.
	if code, body := get("/editor/b2599ed3-d4bd-4226-82cd-9a20e5888596"); code != 200 || body != "<html>editor</html>" {
		t.Fatalf("fs /editor/<id>: %d %q", code, body)
	}
	if code, body := get("/editor/b2599ed3-d4bd-4226-82cd-9a20e5888596/"); code != 200 || body != "<html>editor</html>" {
		t.Fatalf("fs /editor/<id>/: %d %q", code, body)
	}
	if code, _ := get("/editor/a/b"); code != 404 {
		t.Fatalf("fs /editor nested should 404: %d", code)
	}
	if code, _ := get("/editor/evil.html"); code != 404 {
		t.Fatalf("fs /editor file-looking should 404: %d", code)
	}
	// The audience display uses the same rewrite: /present/<designId>.
	write("present/index.html", "<html>present</html>")
	if code, body := get("/present/abc-123"); code != 200 || body != "<html>present</html>" {
		t.Fatalf("fs /present/<id>: %d %q", code, body)
	}
	// Share links use the same pretty-URL rewrite: /shared/<token>.
	write("shared/index.html", "<html>shared</html>")
	if code, body := get("/shared/DkGjFpCEs3hDOsY1NwK4YddjgTcYPuRK"); code != 200 || body != "<html>shared</html>" {
		t.Fatalf("fs /shared/<token>: %d %q", code, body)
	}
	if code, _ := get("/shared/a/b"); code != 404 {
		t.Fatalf("fs /shared nested should 404: %d", code)
	}
}

// TestAPIOnlyNotice covers the no-frontend fallback: non-API GET routes get a
// friendly HTML page, while API/realtime paths still return a JSON 404.
func TestAPIOnlyNotice(t *testing.T) {
	r := chi.NewRouter()
	r.Get("/api/v1/ping", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })
	mountAPIOnlyNotice(r)
	srv := httptest.NewServer(r)
	defer srv.Close()
	get := func(path string) (int, string) {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		buf := make([]byte, 256)
		n, _ := resp.Body.Read(buf)
		return resp.StatusCode, string(buf[:n])
	}
	// A client-routed page gets the friendly notice (200 HTML), not a JSON 404.
	if code, body := get("/dashboard"); code != 200 || !strings.Contains(body, "API only") {
		t.Fatalf("notice page: %d %q", code, body)
	}
	// Unmatched API path stays a JSON 404, never the HTML notice.
	if code, body := get("/api/v1/missing"); code != 404 || strings.Contains(body, "API only") {
		t.Fatalf("api 404 should not serve notice: %d %q", code, body)
	}
	// A matched API route still works.
	if code, _ := get("/api/v1/ping"); code != 200 {
		t.Fatalf("api ping: %d", code)
	}
}

func TestStaticServing(t *testing.T) {
	dir := t.TempDir()
	must := func(rel, body string) {
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	must("index.html", "<html>shell</html>")
	must("dashboard.html", "<html>dashboard</html>")
	must("editor/index.html", "<html>editor</html>") // trailingSlash export
	must("404.html", "<html>notfound</html>")
	must("_next/static/app.js", "console.log(1)")

	r := chi.NewRouter()
	// A real API route so the guard's namespace check is meaningful.
	r.Get("/api/v1/ping", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })
	mountStatic(r, dir, "")
	srv := httptest.NewServer(r)
	defer srv.Close()

	get := func(path string) (int, string, string) {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		buf := make([]byte, 64)
		n, _ := resp.Body.Read(buf)
		return resp.StatusCode, string(buf[:n]), resp.Header.Get("Cache-Control")
	}

	// Root serves the shell.
	if code, body, _ := get("/"); code != 200 || body != "<html>shell</html>" {
		t.Fatalf("root: %d %q", code, body)
	}
	// Per-route exported page resolves via <path>.html.
	if code, body, _ := get("/dashboard"); code != 200 || body != "<html>dashboard</html>" {
		t.Fatalf("/dashboard: %d %q", code, body)
	}
	// trailingSlash export: <path>/index.html, served for both /editor/ and /editor.
	if code, body, _ := get("/editor/"); code != 200 || body != "<html>editor</html>" {
		t.Fatalf("/editor/: %d %q", code, body)
	}
	if code, body, _ := get("/editor"); code != 200 || body != "<html>editor</html>" {
		t.Fatalf("/editor: %d %q", code, body)
	}
	// Hashed asset served with immutable caching.
	if code, _, cc := get("/_next/static/app.js"); code != 200 || cc == "" {
		t.Fatalf("/_next asset: %d cache=%q", code, cc)
	}
	// Pretty editor URL: /editor/<id> serves the editor page (the id is
	// client-resolved; the export cannot emit per-design HTML).
	if code, body, _ := get("/editor/abc123"); code != 200 || body != "<html>editor</html>" {
		t.Fatalf("/editor/<id>: %d %q", code, body)
	}
	// Genuinely unknown path serves the exported 404 page with a 404 status.
	if code, body, _ := get("/no-such-page"); code != 404 || body != "<html>notfound</html>" {
		t.Fatalf("404 fallback: %d %q", code, body)
	}
	// Unmatched API path is a JSON 404, never the shell.
	if code, body, _ := get("/api/v1/does-not-exist"); code != 404 || body == "<html>shell</html>" {
		t.Fatalf("api 404 should not serve shell: %d %q", code, body)
	}
	// A matched API route still works.
	if code, _, _ := get("/api/v1/ping"); code != 200 {
		t.Fatalf("api ping: %d", code)
	}
}

// TestStaticGAInjection verifies the Google Analytics snippet is injected into
// served HTML pages (only) when a measurement id is configured, kept out
// otherwise, and that an operator id is sanitized so it can't inject markup.
func TestStaticGAInjection(t *testing.T) {
	dir := t.TempDir()
	writeFile := func(rel, body string) {
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	writeFile("index.html", "<html><head><title>x</title></head><body>hi</body></html>")
	writeFile("_next/static/app.js", "console.log(1)")

	body := func(r chi.Router, path string) string {
		srv := httptest.NewServer(r)
		defer srv.Close()
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return string(b)
	}

	// Enabled: HTML gets the snippet, assets do not.
	rOn := chi.NewRouter()
	mountStaticFS(rOn, http.FS(os.DirFS(dir)), "G-ABC12345")
	html := body(rOn, "/")
	if !strings.Contains(html, "googletagmanager.com/gtag/js?id=G-ABC12345") ||
		!strings.Contains(html, "gtag('config','G-ABC12345')") {
		t.Fatalf("html missing GA snippet: %q", html)
	}
	if !strings.Contains(html, "</head>") || strings.Index(html, "gtag") > strings.Index(html, "</head>") {
		t.Fatalf("GA snippet not injected before </head>: %q", html)
	}
	if js := body(rOn, "/_next/static/app.js"); strings.Contains(js, "gtag") {
		t.Fatalf("asset should not be injected: %q", js)
	}

	// Disabled: no snippet.
	rOff := chi.NewRouter()
	mountStaticFS(rOff, http.FS(os.DirFS(dir)), "")
	if strings.Contains(body(rOff, "/"), "gtag") {
		t.Fatal("GA snippet present when disabled")
	}

	// Sanitized: quotes/brackets stripped, so no markup can escape the script.
	if got := sanitizeGAID(`G-X"><script>evil</script>`); strings.ContainsAny(got, `"<>'`) {
		t.Fatalf("sanitizeGAID left unsafe chars: %q", got)
	}
	if sanitizeGAID("  G-ABC_123  ") != "G-ABC_123" {
		t.Fatalf("sanitizeGAID mangled a valid id")
	}
}
