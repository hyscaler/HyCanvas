package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/accounts"
)

func stripSchema(dsn string) string {
	for _, sep := range []string{"?schema=", "&schema="} {
		if i := strings.Index(dsn, sep); i >= 0 {
			return dsn[:i]
		}
	}
	return dsn
}

func TestIsSafeBaseURL(t *testing.T) {
	cases := []struct {
		url   string
		local bool
		want  bool
	}{
		{"https://api.openai.com/v1", false, true},
		{"http://api.openai.com/v1", false, false}, // http not allowed for public
		{"https://10.0.0.5/v1", false, false},      // RFC1918
		{"https://192.168.1.1", false, false},      // RFC1918
		{"https://169.254.1.1", false, false},      // link-local
		{"http://localhost:1234", false, false},    // localhost http disallowed in prod
		{"http://localhost:1234", true, true},      // allowed in dev
		{"https://evil.local", false, false},       // .local
		{"not a url", false, false},
	}
	for _, c := range cases {
		if got := isSafeBaseURL(c.url, c.local); got != c.want {
			t.Errorf("isSafeBaseURL(%q, %v) = %v, want %v", c.url, c.local, got, c.want)
		}
	}
}

func TestBuildAndParse(t *testing.T) {
	// OpenAI text request shape + system message ordering.
	req := buildTextRequest(CallConfig{Provider: ProviderOpenAI, APIKey: "k"}, "hi", "be brief")
	if !strings.HasSuffix(req.url, "/chat/completions") || req.headers["authorization"] != "Bearer k" {
		t.Fatalf("openai text request wrong: %+v", req)
	}
	// Anthropic uses x-api-key + /v1/messages.
	areq := buildTextRequest(CallConfig{Provider: ProviderAnthropic, APIKey: "k"}, "hi", "")
	if !strings.HasSuffix(areq.url, "/v1/messages") || areq.headers["x-api-key"] != "k" {
		t.Fatalf("anthropic text request wrong: %+v", areq)
	}
	// Parse both response shapes.
	if got := parseTextResponse(ProviderOpenAI, []byte(`{"choices":[{"message":{"content":" hello "}}]}`)); got != "hello" {
		t.Fatalf("openai parse = %q", got)
	}
	if got := parseTextResponse(ProviderAnthropic, []byte(`{"content":[{"text":" hi "}]}`)); got != "hi" {
		t.Fatalf("anthropic parse = %q", got)
	}
	// Image response: b64 -> data URL; url fallback.
	if got := parseImageResponse([]byte(`{"data":[{"b64_json":"QUJD"}]}`)); got != "data:image/png;base64,QUJD" {
		t.Fatalf("image b64 parse = %q", got)
	}
	if got := parseImageResponse([]byte(`{"data":[{"url":"https://x/y.png"}]}`)); got != "https://x/y.png" {
		t.Fatalf("image url parse = %q", got)
	}
}

func TestAI_DB(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping DB integration test")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, stripSchema(dsn))
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
	_, ws, _, err := acct.Signup(ctx, "ai-owner+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}

	// A stub OpenAI-compatible server for the generation path.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/chat/completions") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.Header.Get("authorization") != "Bearer sk-secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]any{"content": "generated text"}}},
		})
	}))
	defer server.Close()

	svc := NewService(tx, "test-ai-secret", true) // allowLocalHTTP for the 127.0.0.1 stub

	// No config yet.
	if cfg, err := svc.GetConfig(ctx, ws.ID); err != nil || cfg != nil {
		t.Fatalf("expected no config: %+v err=%v", cfg, err)
	}
	// Generation without config -> BadRequest.
	if _, err := svc.Text(ctx, ws.ID, "hi", ""); err != ErrBadRequest {
		t.Fatalf("text without config should be BadRequest, got %v", err)
	}

	// Set a custom provider pointing at the stub, with a key.
	cfg, err := svc.SetConfig(ctx, ws.ID, ConfigInput{Provider: "custom", BaseURL: server.URL, APIKey: "sk-secret"})
	if err != nil {
		t.Fatalf("SetConfig: %v", err)
	}
	if !cfg.HasKey || cfg.Provider != "custom" {
		t.Fatalf("config view wrong: %+v", cfg)
	}

	// The key is encrypted at rest: the stored cipher is not the plaintext.
	var storedCipher *string
	if err := tx.QueryRow(ctx, `SELECT "keyCipher" FROM "AiConfig" WHERE "workspaceId" = $1`, ws.ID).Scan(&storedCipher); err != nil {
		t.Fatalf("read cipher: %v", err)
	}
	if storedCipher == nil || strings.Contains(*storedCipher, "sk-secret") {
		t.Fatalf("key not encrypted at rest: %v", storedCipher)
	}

	// Full text path: decrypt -> POST stub -> parse.
	text, err := svc.Text(ctx, ws.ID, "hello", "")
	if err != nil {
		t.Fatalf("Text: %v", err)
	}
	if text != "generated text" {
		t.Fatalf("text = %q", text)
	}

	// Changing the provider WITHOUT a new key clears the stored key.
	cfg2, err := svc.SetConfig(ctx, ws.ID, ConfigInput{Provider: "anthropic"})
	if err != nil {
		t.Fatalf("SetConfig provider change: %v", err)
	}
	if cfg2.HasKey {
		t.Fatalf("changing provider should clear the key: %+v", cfg2)
	}
	// Now generation fails (no key) with BadRequest.
	if _, err := svc.Text(ctx, ws.ID, "hi", ""); err != ErrBadRequest {
		t.Fatalf("text after key cleared should be BadRequest, got %v", err)
	}

	// A custom provider with a private/SSRF base URL is rejected.
	if _, err := svc.SetConfig(ctx, ws.ID, ConfigInput{Provider: "custom", BaseURL: "https://10.0.0.1/v1"}); err != ErrBadRequest {
		t.Fatalf("private baseUrl should be BadRequest, got %v", err)
	}

	// Image generation on anthropic is rejected (no image endpoint). First give it
	// a key so callConfig passes, then assert the image-capable guard fires.
	if _, err := svc.SetConfig(ctx, ws.ID, ConfigInput{Provider: "anthropic", APIKey: "sk-ant"}); err != nil {
		t.Fatalf("set anthropic key: %v", err)
	}
	if _, err := svc.Image(ctx, ws.ID, "a cat", ""); err != ErrBadRequest {
		t.Fatalf("anthropic image should be BadRequest, got %v", err)
	}
}
