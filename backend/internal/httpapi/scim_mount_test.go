package httpapi

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"hycanvas/backend/internal/scim"
)

const scimTestToken = "0123456789abcdef0123456789abcdef"

func scimRouter(t *testing.T, h http.Handler) http.Handler {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>app shell</html>"), 0o600); err != nil {
		t.Fatal(err)
	}
	return NewRouter(Deps{Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), PublicDir: dir, SCIM: h})
}

func get(h http.Handler, path string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", "Bearer "+scimTestToken)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// With SCIM off, /scim/v2 must answer 404, not the frontend's app shell: a 200
// HTML page reads to an identity provider as "SCIM is here".
func TestSCIMMountedEvenWhenDisabled(t *testing.T) {
	// Control: without the mount, the frontend's catch-all answers. This is the
	// failure the mount exists to prevent; if it stops reproducing, the
	// assertion below proves nothing.
	if rec := get(scimRouter(t, nil), "/scim/v2/Users"); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "app shell") {
		t.Fatalf("control: unmounted /scim/v2/Users got %d %q, expected the app shell", rec.Code, rec.Body.String())
	}

	off := scim.NewServer(nil, nil, "secret", nil, slog.Default()).Handler()
	rec := get(scimRouter(t, off), "/scim/v2/Users")
	if rec.Code != http.StatusNotFound || !strings.HasPrefix(rec.Header().Get("Content-Type"), "application/scim+json") {
		t.Fatalf("SCIM off: %d %q %q, want a SCIM 404", rec.Code, rec.Header().Get("Content-Type"), rec.Body.String())
	}
}

func TestSCIMMountPath(t *testing.T) {
	on := scim.NewServer(&scim.Config{Token: scimTestToken}, nil, "secret", nil, slog.Default()).Handler()
	if rec := get(scimRouter(t, on), "/scim/v2/ServiceProviderConfig"); rec.Code != http.StatusOK {
		t.Fatalf("enabled SCIM at /scim/v2/ServiceProviderConfig: %d %s", rec.Code, rec.Body.String())
	}
}
