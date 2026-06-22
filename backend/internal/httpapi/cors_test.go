package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestCORS(t *testing.T) {
	allow := func(origin string) bool { return origin == "http://localhost:3000" }
	r := chi.NewRouter()
	r.Use(corsMiddleware(allow))
	r.Get("/x", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })
	srv := httptest.NewServer(r)
	defer srv.Close()

	do := func(method, path, origin string) *http.Response {
		req, _ := http.NewRequest(method, srv.URL+path, nil)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		if method == http.MethodOptions {
			req.Header.Set("Access-Control-Request-Method", "POST")
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}

	// Allowed origin: GET echoes the origin + credentials.
	resp := do("GET", "/x", "http://localhost:3000")
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "http://localhost:3000" {
		t.Fatalf("allowed origin not echoed: %q", got)
	}
	if resp.Header.Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatal("credentials header missing")
	}

	// Allowed preflight: 204 with methods/headers.
	resp = do("OPTIONS", "/x", "http://localhost:3000")
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("preflight status: %d", resp.StatusCode)
	}
	if resp.Header.Get("Access-Control-Allow-Methods") == "" {
		t.Fatal("preflight missing allow-methods")
	}

	// Disallowed origin: no CORS header (browser will block).
	resp = do("GET", "/x", "http://evil.example.com")
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("disallowed origin should not be echoed, got %q", got)
	}

	// Same-origin (no Origin header): untouched, request proceeds.
	resp = do("GET", "/x", "")
	if resp.StatusCode != 200 || resp.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("same-origin should pass through cleanly: %d", resp.StatusCode)
	}
}
