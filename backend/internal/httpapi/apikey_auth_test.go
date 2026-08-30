package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/aistudio"
	"hycanvas/backend/internal/apikeys"
	"hycanvas/backend/internal/jobs"
)

// End-to-end coverage for the API-key surface (F40 E01/E02/E04): mint over
// HTTP as an admin session, then drive the allowlist, scope, tenancy, and
// generation-job paths with the raw key. DB-gated like the other integration
// tests; generation itself fails fast (no AI provider configured in the test
// workspace), which is the point: the AUTH and JOB plumbing is what this
// proves, not the model call.
func TestAPIKeySurface_DB(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping DB integration test")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, stripSchemaParam(dsn))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer conn.Close(ctx)
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	acct := accounts.NewService(tx, "test-jwt-secret")
	_, ws, tokens, err := acct.Signup(ctx, "apisurface+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	keys := apikeys.NewService(tx)
	reg := jobs.NewRegistry()
	// A provider that always refuses: generation jobs fail fast, proving the
	// auth + job plumbing without a model call.
	studio := aistudio.NewService(tx, failingTextGen{})

	// Wire the package-level key auth exactly like NewRouter does, with a stub
	// design->workspace lookup so the tenancy guard is testable without the
	// storage stack. Restore the globals after (other tests share the package).
	prevAuth, prevWS := apiKeyAuth, apiKeyDesignWS
	designWS := map[string]string{"design-in-ws": ws.ID, "design-elsewhere": "other-workspace"}
	apiKeyAuth = keys
	apiKeyDesignWS = func(_ context.Context, id string) (string, error) { return designWS[id], nil }
	defer func() { apiKeyAuth, apiKeyDesignWS = prevAuth, prevWS }()

	r := chi.NewRouter()
	r.Route("/api/v1", func(api chi.Router) {
		mountAPIKeys(api, keys, acct)
		mountGenerate(api, studio, acct, nil, reg, nil)
		mountJobs(api, reg, acct)
		// A design-scoped allowlisted route, minimal body, to test the tenancy
		// guard without the persistence/storage stack.
		api.With(requireAuth(acct)).Get("/designs/{id}/file", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		})
		// An export-scoped stub, so the scope gate is reachable (the middleware
		// only runs on mounted routes; chi 404s unmounted paths before it).
		api.With(requireAuth(acct)).Get("/designs/{id}/render.pdf", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		})
	})
	srv := httptest.NewServer(r)
	defer srv.Close()

	do := func(method, path, token string, body any) *http.Response {
		var rd *bytes.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		} else {
			rd = bytes.NewReader(nil)
		}
		req, _ := http.NewRequest(method, srv.URL+path, rd)
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		return res
	}

	// Mint over HTTP: admin session (signup's own tokens), generate+read scopes.
	res := do("POST", "/api/v1/workspaces/"+ws.ID+"/api-keys", tokens.Access, map[string]any{"label": "ci", "scopes": []string{"generate", "read"}})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("mint status %d", res.StatusCode)
	}
	var minted struct {
		Key  string          `json:"key"`
		View apikeys.KeyView `json:"view"`
	}
	_ = json.NewDecoder(res.Body).Decode(&minted)
	res.Body.Close()
	if !strings.HasPrefix(minted.Key, apikeys.Prefix) {
		t.Fatalf("raw key missing from mint response")
	}

	// A key cannot reach a non-allowlisted route (the mint route itself).
	res = do("GET", "/api/v1/workspaces/"+ws.ID+"/api-keys", minted.Key, nil)
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("key on non-allowlisted route: want 403, got %d", res.StatusCode)
	}
	res.Body.Close()

	// Tenancy guard: the key reads its own workspace's design, 404s elsewhere.
	res = do("GET", "/api/v1/designs/design-in-ws/file", minted.Key, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("in-workspace design read: want 200, got %d", res.StatusCode)
	}
	res.Body.Close()
	res = do("GET", "/api/v1/designs/design-elsewhere/file", minted.Key, nil)
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("cross-tenant design read: want 404, got %d", res.StatusCode)
	}
	res.Body.Close()

	// Scope gate: an export-scoped route with a generate+read key is refused.
	res = do("GET", "/api/v1/designs/design-in-ws/render.pdf", minted.Key, nil)
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("missing scope: want 403, got %d", res.StatusCode)
	}
	res.Body.Close()

	// Generate: 202 with a pollable job; the key's workspace is implicit. The
	// job then fails fast (no AI provider), proving the full job wiring.
	res = do("POST", "/api/v1/generate/presentation", minted.Key, map[string]any{"prompt": "a 3-slide deck about tea"})
	if res.StatusCode != http.StatusAccepted {
		t.Fatalf("generate: want 202, got %d", res.StatusCode)
	}
	var accepted struct {
		JobID string `json:"jobId"`
	}
	_ = json.NewDecoder(res.Body).Decode(&accepted)
	res.Body.Close()
	if accepted.JobID == "" {
		t.Fatal("no job id")
	}
	deadline := time.Now().Add(5 * time.Second)
	status := ""
	for time.Now().Before(deadline) {
		res = do("GET", "/api/v1/jobs/"+accepted.JobID, minted.Key, nil)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("job poll with key: want 200, got %d", res.StatusCode)
		}
		var job struct {
			Status string `json:"status"`
		}
		_ = json.NewDecoder(res.Body).Decode(&job)
		res.Body.Close()
		status = job.Status
		if status == "failed" || status == "completed" {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if status != "failed" {
		t.Fatalf("provider-less generation job should fail fast, got status %q", status)
	}

	// A mismatched workspaceId in the body is refused for a key.
	res = do("POST", "/api/v1/generate/presentation", minted.Key, map[string]any{"prompt": "x", "workspaceId": uuid.NewString()})
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("workspace mismatch: want 403, got %d", res.StatusCode)
	}
	res.Body.Close()

	// A key is HEADER-ONLY: the same key in the access cookie must never
	// authenticate (a cookie-borne key would be an ambient CSRF credential).
	{
		req, _ := http.NewRequest("POST", srv.URL+"/api/v1/generate/presentation", bytes.NewReader([]byte(`{"prompt":"x"}`)))
		req.AddCookie(&http.Cookie{Name: accessCookie, Value: minted.Key})
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("cookie-key request: %v", err)
		}
		if res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("cookie-borne key must not authenticate: want 401, got %d", res.StatusCode)
		}
		res.Body.Close()
	}

	// Revoked keys stop authenticating.
	if err := keys.Revoke(ctx, minted.View.ID, ws.ID); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	res = do("POST", "/api/v1/generate/presentation", minted.Key, map[string]any{"prompt": "x"})
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("revoked key: want 401, got %d", res.StatusCode)
	}
	res.Body.Close()
}

// failingTextGen is a TextGenerator that always refuses, so generation jobs
// exercise the failure path deterministically.
type failingTextGen struct{}

func (failingTextGen) Text(context.Context, string, string, string) (string, error) {
	return "", errAIUnavailableForTest
}
func (failingTextGen) TextStructured(context.Context, string, string, string, string) (string, error) {
	return "", errAIUnavailableForTest
}

var errAIUnavailableForTest = errTest("no AI provider configured for this test")

type errTest string

func (e errTest) Error() string { return string(e) }

func stripSchemaParam(dsn string) string {
	for _, sep := range []string{"?schema=", "&schema="} {
		if i := strings.Index(dsn, sep); i >= 0 {
			return dsn[:i]
		}
	}
	return dsn
}
