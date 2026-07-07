package setup

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func testServer(t *testing.T) (*server, http.Handler) {
	t.Helper()
	webFS := fstest.MapFS{
		"index.html":                     {Data: []byte("<html>app</html>")},
		"installation/step-1/index.html": {Data: []byte("<html>wizard step 1</html>")},
	}
	s := &server{
		opts: Options{
			Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
			Port:   "8005",
			Secret: "test-secret",
			WebFS:  http.FS(webFS),
		},
		phase: phaseCollecting,
		done:  make(chan struct{}),
	}
	return s, s.router()
}

func postJSON(t *testing.T, h http.Handler, path, secret string, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	if secret != "" {
		req.Header.Set("X-Setup-Secret", secret)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestGenerateToken(t *testing.T) {
	a, b := GenerateToken(), GenerateToken()
	if len(a) != 64 || a == b {
		t.Fatalf("weak token generation: %q %q", a, b)
	}
}

func TestEnvLineQuoting(t *testing.T) {
	if got := envLine("A", "plain"); got != "A=plain\n" {
		t.Errorf("plain value: %q", got)
	}
	if got := envLine("A", "has space"); got != "A=\"has space\"\n" {
		t.Errorf("spaced value: %q", got)
	}
	if got := envLine("A", `say "hi" #1`); got != "A=\"say \\\"hi\\\" #1\"\n" {
		t.Errorf("quoted value: %q", got)
	}
}

func TestDSNBuilding(t *testing.T) {
	d := dbRequest{Host: "db.example.com", User: "hy", Password: "p@ss/w:rd", Name: "hycanvas"}
	dsn, err := d.dsn()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(dsn, "postgresql://hy:") || !strings.HasSuffix(dsn, "@db.example.com:5432/hycanvas") {
		t.Errorf("dsn = %q", dsn)
	}
	if strings.Contains(dsn, "p@ss/w:rd") {
		t.Errorf("password not escaped: %q", dsn)
	}

	if _, err := (dbRequest{}).dsn(); err == nil {
		t.Error("empty request must error")
	}
	if dsn, _ := (dbRequest{URL: " postgres://x "}).dsn(); dsn != "postgres://x" {
		t.Errorf("explicit URL should win, trimmed: %q", dsn)
	}
}

func TestRenderEnv(t *testing.T) {
	var body completeRequest
	body.AppURL = "http://canvas.example.com/"
	body.Port = "9000"
	body.Storage.Driver = "local"
	body.Storage.LocalPath = "/srv/hycanvas/storage"
	body.SMTP.Enabled = true
	body.SMTP.Host = "smtp.example.com"
	body.SMTP.Username = "mailer"
	body.SMTP.Password = "hunter two" // needs quoting

	env := renderEnv(body, "postgresql://hy:pw@db:5432/hycanvas", "jwt123", "ai456")
	for _, want := range []string{
		"NODE_ENV=production",
		"PORT=9000",
		"APP_URL=http://canvas.example.com",
		"COOKIE_SECURE=false", // plain-http APP_URL
		"DATABASE_URL=postgresql://hy:pw@db:5432/hycanvas",
		"JWT_SECRET=jwt123",
		"AI_SECRET=ai456",
		"STORAGE_DRIVER=local",
		"LOCAL_STORAGE_PATH=/srv/hycanvas/storage",
		"SMTP_HOST=smtp.example.com",
		"SMTP_PASSWORD=\"hunter two\"",
	} {
		if !strings.Contains(env, want) {
			t.Errorf("env missing %q:\n%s", want, env)
		}
	}

	body.AppURL = "https://canvas.example.com"
	env = renderEnv(body, "d", "j", "a")
	if strings.Contains(env, "COOKIE_SECURE") {
		t.Error("https APP_URL must not force COOKIE_SECURE=false")
	}

	body.SMTP.Enabled = false
	env = renderEnv(body, "d", "j", "a")
	if strings.Contains(env, "SMTP_") {
		t.Error("disabled SMTP must not be written")
	}

	body.Storage.Driver = "s3"
	body.Storage.S3 = s3Request{Endpoint: "minio:9000", Bucket: "hy", AccessKey: "k", SecretKey: "s", ForcePathStyle: true}
	env = renderEnv(body, "d", "j", "a")
	for _, want := range []string{"STORAGE_DRIVER=s3", "S3_ENDPOINT=minio:9000", "S3_FORCE_PATH_STYLE=true"} {
		if !strings.Contains(env, want) {
			t.Errorf("s3 env missing %q:\n%s", want, env)
		}
	}
}

func TestWriteEnvFile(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, ".env")
	if err := writeEnvFile(dest, "A=1\n"); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(dest)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("perms = %o, want 600", info.Mode().Perm())
	}
	if _, err := os.Stat(dest + ".tmp"); !os.IsNotExist(err) {
		t.Error("tmp file left behind")
	}
}

func TestRedirectAndWizardServing(t *testing.T) {
	_, h := testServer(t)

	for _, p := range []string{"/", "/login", "/dashboard"} {
		req := httptest.NewRequest(http.MethodGet, p, nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusFound || rec.Header().Get("Location") != "/installation/step-1/" {
			t.Errorf("GET %s = %d -> %q, want 302 -> /installation/step-1/", p, rec.Code, rec.Header().Get("Location"))
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/installation/step-1", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "wizard step 1") {
		t.Errorf("wizard page: %d %q", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "\"setup\"") {
		t.Errorf("healthz in setup mode: %d %q", rec.Code, rec.Body.String())
	}
}

func TestVerifyAndRateLimit(t *testing.T) {
	_, h := testServer(t)

	if rec := postJSON(t, h, "/api/setup/verify", "", map[string]string{"secret": "test-secret"}); rec.Code != http.StatusOK {
		t.Fatalf("right secret rejected: %d %s", rec.Code, rec.Body.String())
	}

	for i := 0; i < 5; i++ {
		if rec := postJSON(t, h, "/api/setup/verify", "", map[string]string{"secret": "nope"}); rec.Code != http.StatusForbidden {
			t.Fatalf("wrong secret attempt %d: %d", i, rec.Code)
		}
	}
	if rec := postJSON(t, h, "/api/setup/verify", "", map[string]string{"secret": "nope"}); rec.Code != http.StatusTooManyRequests {
		t.Errorf("6th wrong attempt should rate limit: %d", rec.Code)
	}
	// Even the right secret is locked out during the cooldown window.
	if rec := postJSON(t, h, "/api/setup/verify", "", map[string]string{"secret": "test-secret"}); rec.Code != http.StatusTooManyRequests {
		t.Errorf("lockout must apply to all attempts: %d", rec.Code)
	}
}

func TestMutatingEndpointsRequireSecret(t *testing.T) {
	_, h := testServer(t)
	for _, p := range []string{"/api/setup/answers", "/api/setup/db/test", "/api/setup/smtp/test", "/api/setup/s3/test", "/api/setup/complete"} {
		if rec := postJSON(t, h, p, "", map[string]string{}); rec.Code != http.StatusForbidden {
			t.Errorf("POST %s without secret = %d, want 403", p, rec.Code)
		}
		if rec := postJSON(t, h, p, "wrong", map[string]string{}); rec.Code != http.StatusForbidden {
			t.Errorf("POST %s with wrong secret = %d, want 403", p, rec.Code)
		}
	}
	// The answers payload echoes credentials, so reading it is gated too.
	req := httptest.NewRequest(http.MethodGet, "/api/setup/answers", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("GET /api/setup/answers without secret = %d, want 403", rec.Code)
	}
}

func TestAnswersAccumulateServerSide(t *testing.T) {
	_, h := testServer(t)

	if rec := postJSON(t, h, "/api/setup/answers", "test-secret", map[string]any{
		"appUrl": "http://canvas.local", "port": "9001",
	}); rec.Code != http.StatusOK {
		t.Fatalf("app answers = %d: %s", rec.Code, rec.Body.String())
	}
	if rec := postJSON(t, h, "/api/setup/answers", "test-secret", map[string]any{
		"db": dbRequest{Host: "dbhost", User: "hy", Name: "hycanvas"},
	}); rec.Code != http.StatusOK {
		t.Fatalf("db answers = %d", rec.Code)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/setup/answers", nil)
	req.Header.Set("X-Setup-Secret", "test-secret")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var got completeRequest
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	// Sections submitted separately must both survive (merge, not replace).
	if got.AppURL != "http://canvas.local" || got.Port != "9001" || got.DB.Host != "dbhost" {
		t.Errorf("answers did not accumulate: %+v", got)
	}
}

func TestCompleteWithoutDatabaseAnswers(t *testing.T) {
	_, h := testServer(t)
	rec := postJSON(t, h, "/api/setup/complete", "test-secret", map[string]any{})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("complete with no answers = %d, want 400", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "database step") {
		t.Errorf("problem body: %s", rec.Body.String())
	}
}

func TestDBTestUnreachable(t *testing.T) {
	_, h := testServer(t)
	rec := postJSON(t, h, "/api/setup/db/test", "test-secret", dbRequest{
		Host: "127.0.0.1", Port: "59998", User: "u", Password: "p", Name: "d",
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unreachable db = %d, want 400", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "Connection Failed") {
		t.Errorf("problem body: %s", rec.Body.String())
	}
}

func TestCompleteWithBadDBParksInError(t *testing.T) {
	s, h := testServer(t)
	if rec := postJSON(t, h, "/api/setup/answers", "test-secret", map[string]any{
		"db": dbRequest{Host: "127.0.0.1", Port: "59998", User: "u", Password: "p", Name: "d"},
	}); rec.Code != http.StatusOK {
		t.Fatalf("answers = %d", rec.Code)
	}
	if rec := postJSON(t, h, "/api/setup/complete", "test-secret", map[string]any{}); rec.Code != http.StatusAccepted {
		t.Fatalf("complete = %d", rec.Code)
	}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		phase, detail := s.phase, s.errDetail
		s.mu.Unlock()
		if phase == phaseError {
			if !strings.Contains(detail, "database validation") {
				t.Errorf("error detail = %q", detail)
			}
			// A retry must be allowed from the error phase.
			if rec := postJSON(t, h, "/api/setup/complete", "test-secret", map[string]any{}); rec.Code != http.StatusAccepted {
				t.Errorf("retry after error = %d, want 202", rec.Code)
			}
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("install never reached the error phase")
}

func TestStatusReportsPhase(t *testing.T) {
	s, h := testServer(t)
	s.mu.Lock()
	s.phase, s.errDetail = phaseError, "database validation: boom"
	s.mu.Unlock()
	req := httptest.NewRequest(http.MethodGet, "/api/setup/status", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["phase"] != phaseError || got["error"] != "database validation: boom" {
		t.Errorf("status = %v", got)
	}
}
