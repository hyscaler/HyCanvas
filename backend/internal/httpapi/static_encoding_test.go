package httpapi

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestAcceptsEncoding(t *testing.T) {
	cases := []struct {
		header, token string
		want          bool
	}{
		{"br, gzip", "br", true},
		{"br, gzip", "gzip", true},
		{"gzip, deflate", "br", false},
		{"gzip;q=0, br", "gzip", false},
		{"GZIP", "gzip", true},
		{"br;q=0.5", "br", true},
		{"*", "br", true},
		{"*;q=0", "gzip", false},
		{"gzip;q=0, *", "gzip", false},
		{"br;q=0, *", "gzip", true},
		{"identity", "gzip", false},
		{"br;q=abc", "br", false},
		{"", "br", false},
	}
	for _, c := range cases {
		if got := acceptsEncoding(c.header, c.token); got != c.want {
			t.Errorf("acceptsEncoding(%q, %q) = %v, want %v", c.header, c.token, got, c.want)
		}
	}
}

// staticTree writes files under a temp dir and returns a server mounting it.
func staticEncodingServer(t *testing.T, files map[string][]byte, localesDir string) *httptest.Server {
	t.Helper()
	dir := t.TempDir()
	for rel, body := range files {
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, body, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	r := chi.NewRouter()
	mountStaticFS(r, withLocalesDir(http.FS(os.DirFS(dir)), localesDir), "")
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return srv
}

func gz(t *testing.T, b []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	_, _ = zw.Write(b)
	_ = zw.Close()
	return buf.Bytes()
}

// rawRequest sends a request without Go's transparent gzip handling, so the
// test sees exactly the bytes and headers the server wrote.
func rawRequest(t *testing.T, method, url string, headers map[string]string) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(method, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	tr := &http.Transport{DisableCompression: true}
	resp, err := (&http.Client{Transport: tr}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp, body
}

func TestStaticServesPrecompressedSiblings(t *testing.T) {
	js := []byte(strings.Repeat("console.log('hycanvas');\n", 200))
	jsGz := gz(t, js)
	// Larger than net/http's response buffer, so Content-Length must come from
	// the handler rather than from buffering a small body.
	jsBr := []byte(strings.Repeat("pretend-brotli-bytes", 4000))
	srv := staticEncodingServer(t, map[string][]byte{
		"index.html":                    []byte("<html>shell</html>"),
		"_next/static/chunks/a.js":      js,
		"_next/static/chunks/a.js.gz":   jsGz,
		"_next/static/chunks/a.js.br":   jsBr,
		"_next/static/chunks/b.js":      js,
		"_next/static/chunks/b.js.gz":   jsGz,
		"_next/static/media/f.woff2":    []byte("font"),
		"_next/static/media/f.woff2.gz": []byte("never-served"),
	}, "")

	t.Run("brotli preferred", func(t *testing.T) {
		resp, body := rawRequest(t, http.MethodGet, srv.URL+"/_next/static/chunks/a.js", map[string]string{"Accept-Encoding": "gzip, deflate, br"})
		if resp.StatusCode != 200 || resp.Header.Get("Content-Encoding") != "br" || !bytes.Equal(body, jsBr) {
			t.Fatalf("got %d enc=%q body=%q", resp.StatusCode, resp.Header.Get("Content-Encoding"), body)
		}
		if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") {
			t.Fatalf("content-type %q", ct)
		}
		if cl := resp.Header.Get("Content-Length"); cl != strconv.Itoa(len(jsBr)) {
			t.Fatalf("content-length %q want %d", cl, len(jsBr))
		}
		if cc := resp.Header.Get("Cache-Control"); cc != "public, max-age=31536000, immutable" {
			t.Fatalf("cache-control %q", cc)
		}
		if v := resp.Header.Get("Vary"); v != "Accept-Encoding" {
			t.Fatalf("vary %q", v)
		}
	})

	t.Run("gzip when brotli refused or missing", func(t *testing.T) {
		resp, body := rawRequest(t, http.MethodGet, srv.URL+"/_next/static/chunks/a.js", map[string]string{"Accept-Encoding": "gzip, br;q=0"})
		if resp.Header.Get("Content-Encoding") != "gzip" || !bytes.Equal(body, jsGz) {
			t.Fatalf("enc=%q", resp.Header.Get("Content-Encoding"))
		}
		resp, body = rawRequest(t, http.MethodGet, srv.URL+"/_next/static/chunks/b.js", map[string]string{"Accept-Encoding": "br, gzip"})
		if resp.Header.Get("Content-Encoding") != "gzip" || !bytes.Equal(body, jsGz) {
			t.Fatalf("b.js enc=%q", resp.Header.Get("Content-Encoding"))
		}
		zr, err := gzip.NewReader(bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		plain, _ := io.ReadAll(zr)
		if !bytes.Equal(plain, js) {
			t.Fatal("gzip sibling does not decode to the original")
		}
	})

	t.Run("original without accept-encoding", func(t *testing.T) {
		resp, body := rawRequest(t, http.MethodGet, srv.URL+"/_next/static/chunks/a.js", nil)
		if resp.Header.Get("Content-Encoding") != "" || !bytes.Equal(body, js) {
			t.Fatalf("enc=%q len=%d", resp.Header.Get("Content-Encoding"), len(body))
		}
		if resp.Header.Get("Vary") != "Accept-Encoding" {
			t.Fatalf("vary missing on identity response")
		}
		resp, body = rawRequest(t, http.MethodGet, srv.URL+"/_next/static/chunks/a.js", map[string]string{"Accept-Encoding": "identity"})
		if resp.Header.Get("Content-Encoding") != "" || !bytes.Equal(body, js) {
			t.Fatalf("identity enc=%q", resp.Header.Get("Content-Encoding"))
		}
	})

	t.Run("non-compressible types never use siblings", func(t *testing.T) {
		resp, body := rawRequest(t, http.MethodGet, srv.URL+"/_next/static/media/f.woff2", map[string]string{"Accept-Encoding": "gzip"})
		if resp.Header.Get("Content-Encoding") != "" || string(body) != "font" || resp.Header.Get("Vary") != "" {
			t.Fatalf("woff2 enc=%q vary=%q body=%q", resp.Header.Get("Content-Encoding"), resp.Header.Get("Vary"), body)
		}
	})

	t.Run("head", func(t *testing.T) {
		resp, body := rawRequest(t, http.MethodHead, srv.URL+"/_next/static/chunks/a.js", map[string]string{"Accept-Encoding": "br"})
		if resp.StatusCode != 200 || len(body) != 0 || resp.Header.Get("Content-Encoding") != "br" ||
			resp.Header.Get("Content-Length") != strconv.Itoa(len(jsBr)) {
			t.Fatalf("head %d enc=%q cl=%q", resp.StatusCode, resp.Header.Get("Content-Encoding"), resp.Header.Get("Content-Length"))
		}
	})

	t.Run("range requests get original bytes", func(t *testing.T) {
		resp, body := rawRequest(t, http.MethodGet, srv.URL+"/_next/static/chunks/a.js", map[string]string{"Accept-Encoding": "br", "Range": "bytes=0-6"})
		if resp.StatusCode != http.StatusPartialContent || string(body) != string(js[:7]) || resp.Header.Get("Content-Encoding") != "" {
			t.Fatalf("range %d %q enc=%q", resp.StatusCode, body, resp.Header.Get("Content-Encoding"))
		}
		if resp.Header.Get("Content-Length") != "7" {
			t.Fatalf("range content-length %q", resp.Header.Get("Content-Length"))
		}
		resp, body = rawRequest(t, http.MethodGet, srv.URL+"/_next/static/chunks/a.js", map[string]string{"Range": "bytes=0-6"})
		if resp.StatusCode != http.StatusPartialContent || string(body) != string(js[:7]) {
			t.Fatalf("identity range %d %q", resp.StatusCode, body)
		}
	})

	t.Run("html route without sibling stays raw", func(t *testing.T) {
		resp, body := rawRequest(t, http.MethodGet, srv.URL+"/", map[string]string{"Accept-Encoding": "br, gzip"})
		if resp.StatusCode != 200 || string(body) != "<html>shell</html>" || resp.Header.Get("Content-Encoding") != "" {
			t.Fatalf("index %d %q", resp.StatusCode, body)
		}
	})
}

// A route page resolved through <path>/index.html uses that file's sibling, and
// the GA injection path (which rewrites the body) never serves a stale sibling.
func TestStaticPrecompressedHTMLAndGA(t *testing.T) {
	page := []byte("<html><head></head><body>" + strings.Repeat("dashboard ", 300) + "</body></html>")
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "dashboard"), 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(dir, "dashboard", "index.html"), page, 0o644)
	_ = os.WriteFile(filepath.Join(dir, "dashboard", "index.html.gz"), gz(t, page), 0o644)

	for _, ga := range []string{"", "G-TEST123"} {
		r := chi.NewRouter()
		mountStaticFS(r, http.FS(os.DirFS(dir)), ga)
		srv := httptest.NewServer(r)
		resp, body := rawRequest(t, http.MethodGet, srv.URL+"/dashboard/", map[string]string{"Accept-Encoding": "gzip"})
		srv.Close()
		if ga == "" {
			if resp.Header.Get("Content-Encoding") != "gzip" || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/html") {
				t.Fatalf("no GA: enc=%q ct=%q", resp.Header.Get("Content-Encoding"), resp.Header.Get("Content-Type"))
			}
			continue
		}
		if resp.Header.Get("Content-Encoding") != "" || !strings.Contains(string(body), "G-TEST123") {
			t.Fatalf("GA: enc=%q injected=%v", resp.Header.Get("Content-Encoding"), strings.Contains(string(body), "G-TEST123"))
		}
	}
}

// A translation overridden through LOCALES_DIR must win over the embedded
// copy's precompressed sibling.
func TestLocalesOverrideBeatsPrecompressedSibling(t *testing.T) {
	embedded := []byte(`{"hello":"` + strings.Repeat("old ", 400) + `"}`)
	override := t.TempDir()
	newText := []byte(`{"hello":"new"}`)
	if err := os.WriteFile(filepath.Join(override, "fr.json"), newText, 0o644); err != nil {
		t.Fatal(err)
	}
	srv := staticEncodingServer(t, map[string][]byte{
		"index.html":         []byte("<html>shell</html>"),
		"locales/fr.json":    embedded,
		"locales/fr.json.gz": gz(t, embedded),
		"locales/de.json":    embedded,
		"locales/de.json.gz": gz(t, embedded),
	}, override)

	resp, body := rawRequest(t, http.MethodGet, srv.URL+"/locales/fr.json", map[string]string{"Accept-Encoding": "gzip"})
	if resp.Header.Get("Content-Encoding") != "" || !bytes.Equal(body, newText) {
		t.Fatalf("override: enc=%q body=%q", resp.Header.Get("Content-Encoding"), body)
	}
	// A language with no override still gets its compressed embedded copy.
	resp, _ = rawRequest(t, http.MethodGet, srv.URL+"/locales/de.json", map[string]string{"Accept-Encoding": "gzip"})
	if resp.Header.Get("Content-Encoding") != "gzip" {
		t.Fatalf("embedded de: enc=%q", resp.Header.Get("Content-Encoding"))
	}
}
