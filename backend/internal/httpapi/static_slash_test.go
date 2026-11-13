package httpapi

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"testing/fstest"

	"github.com/go-chi/chi/v5"
)

// recordingFS remembers every name the static handler asks for.
type recordingFS struct {
	http.FileSystem
	mu    sync.Mutex
	names []string
}

func (r *recordingFS) Open(name string) (http.File, error) {
	r.mu.Lock()
	r.names = append(r.names, name)
	r.mu.Unlock()
	return r.FileSystem.Open(name)
}

// TestStaticOpensSlashPaths guards the Windows build: the embedded frontend
// only accepts "/"-separated names, so a backslash anywhere (filepath.Clean on
// Windows) made every page and asset 404, starting with the setup wizard.
func TestStaticOpensSlashPaths(t *testing.T) {
	mapfs := fstest.MapFS{
		"index.html":                     {Data: []byte("<html>shell</html>")},
		"404.html":                       {Data: []byte("<html>notfound</html>")},
		"installation/step-1/index.html": {Data: []byte("<html>step1</html>")},
		"_next/static/css/app.css":       {Data: []byte("body{}")},
		"locales/en.json":                {Data: []byte("{}")},
	}
	rec := &recordingFS{FileSystem: http.FS(mapfs)}
	r := chi.NewRouter()
	mountStaticFS(r, withLocalesDir(rec, t.TempDir()), "")
	srv := httptest.NewServer(r)
	defer srv.Close()

	for p, want := range map[string]string{
		"/":                         "shell",
		"/installation/step-1/":     "step1",
		"/installation/step-1":      "step1",
		"/_next/static/css/app.css": "body{}",
		"/locales/en.json":          "{}",
	} {
		resp, err := http.Get(srv.URL + p)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK || !strings.Contains(string(body), want) {
			t.Errorf("GET %s = %d %q, want 200 containing %q", p, resp.StatusCode, body, want)
		}
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	for _, n := range rec.names {
		if strings.Contains(n, `\`) || !strings.HasPrefix(n, "/") {
			t.Errorf("static handler opened %q; names must be rooted and use only /", n)
		}
	}
}
