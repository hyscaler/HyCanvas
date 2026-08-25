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

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/aistudio"
	"hycanvas/backend/internal/apikeys"
	"hycanvas/backend/internal/jobs"
)

// End-to-end MCP coverage (F40 E07/E08): initialize + tools/list over the
// streamable-HTTP transport, per-tool scope enforcement, the tenancy guard on
// design-scoped tools, the generation flow against a refusing provider (the
// inline wait surfaces the failure as a tool error), and the audit trail
// (rows written for tool calls, listable by an admin session, refused for a
// key). DB-gated like the other integration tests.
func TestMCPSurface_DB(t *testing.T) {
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
	_, ws, tokens, err := acct.Signup(ctx, "mcp+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	keys := apikeys.NewService(tx)
	reg := jobs.NewRegistry()
	studio := aistudio.NewService(tx, failingTextGen{})

	prevAuth, prevWS := apiKeyAuth, apiKeyDesignWS
	apiKeyAuth = keys
	designWS := map[string]string{"design-in-ws": ws.ID, "design-elsewhere": "other-workspace"}
	apiKeyDesignWS = func(_ context.Context, id string) (string, error) { return designWS[id], nil }
	defer func() { apiKeyAuth, apiKeyDesignWS = prevAuth, prevWS }()

	// The MCP deps use a persistence stub only for GetWorkspaceID via
	// mcpDesignInWorkspace; wire the same map through a tiny adapter by
	// overriding with a nil persistence service and calling tools that do not
	// need LoadFile. (export_design's tenancy check IS GetWorkspaceID, so the
	// nil-persistence route is exercised through d.p; instead, skip the
	// design-file tool here and cover tenancy via export_design with a real
	// guard function.)
	d := mcpDeps{keys: keys, acct: acct, ai: studio, p: nil, reg: reg, share: nil}
	// mcpDesignInWorkspace consults d.p; substitute by mounting the handler
	// with the stubbed guard: patch through a wrapper router.
	r := chi.NewRouter()
	r.Post("/mcp", d.handle)
	r.Route("/api/v1", func(api chi.Router) {
		mountAPIKeys(api, keys, acct)
	})
	srv := httptest.NewServer(r)
	defer srv.Close()

	// Keys: one full-power, one read-only.
	fullRaw, _, err := keys.Mint(ctx, ws.ID, mustUserID(t, acct, ctx, tokens.Access), "mcp-full", []string{"generate", "read", "export"})
	if err != nil {
		t.Fatalf("mint full: %v", err)
	}
	readRaw, _, err := keys.Mint(ctx, ws.ID, mustUserID(t, acct, ctx, tokens.Access), "mcp-read", []string{"read"})
	if err != nil {
		t.Fatalf("mint read: %v", err)
	}

	rpc := func(key string, body string) (int, map[string]any) {
		req, _ := http.NewRequest("POST", srv.URL+"/mcp", bytes.NewReader([]byte(body)))
		if key != "" {
			req.Header.Set("Authorization", "Bearer "+key)
		}
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("mcp call: %v", err)
		}
		defer res.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}

	// No key -> 401; a session token is NOT accepted on /mcp.
	code, _ := rpc("", `{"jsonrpc":"2.0","id":1,"method":"ping"}`)
	if code != http.StatusUnauthorized {
		t.Fatalf("no key: want 401, got %d", code)
	}
	code, _ = rpc(tokens.Access, `{"jsonrpc":"2.0","id":1,"method":"ping"}`)
	if code != http.StatusUnauthorized {
		t.Fatalf("session token on /mcp: want 401, got %d", code)
	}

	// initialize negotiates a known protocol version and advertises tools.
	code, out := rpc(fullRaw, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}`)
	if code != 200 {
		t.Fatalf("initialize: %d", code)
	}
	res, _ := out["result"].(map[string]any)
	if res["protocolVersion"] != "2025-06-18" {
		t.Fatalf("protocolVersion wrong: %v", res["protocolVersion"])
	}

	// Notifications are accepted with 202 and no body.
	code, _ = rpc(fullRaw, `{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	if code != http.StatusAccepted {
		t.Fatalf("notification: want 202, got %d", code)
	}

	// tools/list names the seven tools (list_themes E12, list_templates E14).
	_, out = rpc(fullRaw, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	res, _ = out["result"].(map[string]any)
	tools, _ := res["tools"].([]any)
	if len(tools) != 7 {
		t.Fatalf("want 7 tools, got %d", len(tools))
	}

	// list_themes answers the embedded catalog for any valid key.
	_, out = rpc(readRaw, `{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"list_themes","arguments":{}}}`)
	res, _ = out["result"].(map[string]any)
	if res == nil || res["isError"] != false || !strings.Contains(toolText(res), "theme-slate") {
		t.Fatalf("list_themes: want catalog, got %v", out)
	}

	// Batching was removed in 2025-06-18: refuse arrays.
	_, out = rpc(fullRaw, `[{"jsonrpc":"2.0","id":9,"method":"ping"}]`)
	if out["error"] == nil {
		t.Fatal("batch must be refused")
	}

	// Scope enforcement: a read-only key cannot generate; the refusal is a
	// TOOL error (isError), not a protocol error, so the model can see it.
	_, out = rpc(readRaw, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"generate_presentation","arguments":{"prompt":"a deck"}}}`)
	res, _ = out["result"].(map[string]any)
	if res == nil || res["isError"] != true {
		t.Fatalf("read-only generate: want tool error, got %v", out)
	}
	if !strings.Contains(toolText(res), "generate") {
		t.Fatalf("scope error text unhelpful: %q", toolText(res))
	}

	// Scope first: a read-only key on an export tool is refused.
	_, out = rpc(readRaw, `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"export_design","arguments":{"designId":"design-elsewhere"}}}`)
	res, _ = out["result"].(map[string]any)
	if res == nil || res["isError"] != true {
		t.Fatalf("read key on export: want tool error (scope), got %v", out)
	}

	// Tenancy: a full key still cannot touch a design outside its workspace,
	// and an in-workspace design answers with the download URLs.
	_, out = rpc(fullRaw, `{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"export_design","arguments":{"designId":"design-elsewhere"}}}`)
	res, _ = out["result"].(map[string]any)
	if res == nil || res["isError"] != true || !strings.Contains(toolText(res), "not found") {
		t.Fatalf("cross-tenant export: want not-found tool error, got %v", out)
	}
	_, out = rpc(fullRaw, `{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"export_design","arguments":{"designId":"design-in-ws"}}}`)
	res, _ = out["result"].(map[string]any)
	if res == nil || res["isError"] != false || !strings.Contains(toolText(res), "render.pdf") {
		t.Fatalf("in-workspace export: want URLs, got %v", out)
	}

	// Full key + provider that refuses: the inline wait surfaces the failure
	// as a tool error mentioning the provider problem (auth + plan + job
	// plumbing all proven).
	_, out = rpc(fullRaw, `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"generate_presentation","arguments":{"prompt":"a 3-slide deck about tea"}}}`)
	res, _ = out["result"].(map[string]any)
	if res == nil || res["isError"] != true || !strings.Contains(toolText(res), "generation failed") {
		t.Fatalf("failing provider: want inline failure, got %v", out)
	}

	// get_job on an unknown id reads as not found (not an oracle).
	_, out = rpc(fullRaw, `{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"get_job","arguments":{"jobId":"nope"}}}`)
	res, _ = out["result"].(map[string]any)
	if res == nil || res["isError"] != true {
		t.Fatalf("unknown job: want tool error, got %v", out)
	}

	// E08 audit: the generate call above wrote a row; an ADMIN SESSION lists
	// it, while a key on the audit route is refused by the allowlist.
	req, _ := http.NewRequest("GET", srv.URL+"/api/v1/workspaces/"+ws.ID+"/api-keys/audit", nil)
	req.Header.Set("Authorization", "Bearer "+tokens.Access)
	ares, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("audit list: %v", err)
	}
	var entries []apikeys.AuditEntry
	_ = json.NewDecoder(ares.Body).Decode(&entries)
	ares.Body.Close()
	if ares.StatusCode != 200 || len(entries) == 0 {
		t.Fatalf("audit list: status %d entries %d", ares.StatusCode, len(entries))
	}
	found := false
	for _, e := range entries {
		if e.Surface == "mcp:generate_presentation" {
			found = true
		}
	}
	if !found {
		t.Fatalf("mcp:generate_presentation missing from audit: %+v", entries)
	}
	req, _ = http.NewRequest("GET", srv.URL+"/api/v1/workspaces/"+ws.ID+"/api-keys/audit", nil)
	req.Header.Set("Authorization", "Bearer "+fullRaw)
	ares, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("audit with key: %v", err)
	}
	ares.Body.Close()
	if ares.StatusCode != http.StatusForbidden {
		t.Fatalf("key on audit route: want 403, got %d", ares.StatusCode)
	}
}

// toolText digs the first text content out of a tools/call result.
func toolText(res map[string]any) string {
	content, _ := res["content"].([]any)
	if len(content) == 0 {
		return ""
	}
	first, _ := content[0].(map[string]any)
	s, _ := first["text"].(string)
	return s
}

// mustUserID resolves the signup token back to its user id (VerifyAccess).
func mustUserID(t *testing.T, acct *accounts.Service, ctx context.Context, access string) string {
	t.Helper()
	uid, _, err := acct.VerifyAccess(ctx, access)
	if err != nil {
		t.Fatalf("verify access: %v", err)
	}
	return uid
}
