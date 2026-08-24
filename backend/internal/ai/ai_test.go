package ai

import (
	"context"
	"encoding/json"
	"io"
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

// strp builds the pointer form ConfigInput.BaseURL takes (PATCH semantics).
func strp(s string) *string { return &s }

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
	cfg, err := svc.SetConfig(ctx, ws.ID, ConfigInput{Provider: "custom", BaseURL: strp(server.URL), APIKey: "sk-secret"})
	if err != nil {
		t.Fatalf("SetConfig: %v", err)
	}
	if !cfg.HasKey || cfg.Provider != "custom" {
		t.Fatalf("config view wrong: %+v", cfg)
	}

	// The key is encrypted at rest: the stored cipher is not the plaintext.
	var storedCipher *string
	if err := tx.QueryRow(ctx, `SELECT "key_cipher" FROM "ai_configs" WHERE "workspace_id" = $1`, ws.ID).Scan(&storedCipher); err != nil {
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

	// PATCH semantics: a same-provider save that omits baseUrl (nil) keeps the
	// stored URL - the exact save an API key rotation makes.
	cfgKeep, err := svc.SetConfig(ctx, ws.ID, ConfigInput{Provider: "custom", APIKey: "sk-secret"})
	if err != nil {
		t.Fatalf("SetConfig key rotation: %v", err)
	}
	if cfgKeep.BaseURL == nil || *cfgKeep.BaseURL != server.URL {
		t.Fatalf("omitted baseUrl must preserve the stored URL, got %+v", cfgKeep.BaseURL)
	}
	// An explicit empty string clears - but custom REQUIRES a URL, so the
	// clear is rejected at the boundary rather than persisting a dead config.
	if _, err := svc.SetConfig(ctx, ws.ID, ConfigInput{Provider: "custom", BaseURL: strp("")}); err != ErrBaseURLRequired {
		t.Fatalf("clearing a required baseUrl = %v, want ErrBaseURLRequired", err)
	}

	// Changing the provider WITHOUT a new key is rejected: the stored key is
	// neither silently destroyed nor carried to another vendor.
	if _, err := svc.SetConfig(ctx, ws.ID, ConfigInput{Provider: "anthropic"}); err != ErrKeyRequiredForProviderChange {
		t.Fatalf("keyless provider change = %v, want ErrKeyRequiredForProviderChange", err)
	}
	// With the new provider's key it succeeds, and the stale base URL does not
	// follow the new provider.
	cfg2, err := svc.SetConfig(ctx, ws.ID, ConfigInput{Provider: "anthropic", APIKey: "sk-ant-1"})
	if err != nil {
		t.Fatalf("SetConfig provider change: %v", err)
	}
	if !cfg2.HasKey || cfg2.Provider != "anthropic" || cfg2.BaseURL != nil {
		t.Fatalf("provider change wrong: %+v", cfg2)
	}

	// A custom provider with a private/SSRF base URL is rejected.
	if _, err := svc.SetConfig(ctx, ws.ID, ConfigInput{Provider: "custom", BaseURL: strp("https://10.0.0.1/v1"), APIKey: "sk-x"}); err != ErrBadRequest {
		t.Fatalf("private baseUrl should be BadRequest, got %v", err)
	}

	// Image generation on a text-only provider is rejected with a specific error
	// (so the API can tell the user their provider can't do images, not that the
	// request is malformed). First give it a key so callConfig passes, then assert
	// the image-capable guard fires. anthropic and deepseek are both text-only.
	if _, err := svc.SetConfig(ctx, ws.ID, ConfigInput{Provider: "anthropic", APIKey: "sk-ant"}); err != nil {
		t.Fatalf("set anthropic key: %v", err)
	}
	if _, err := svc.Image(ctx, ws.ID, "a cat", ""); err != ErrImageUnsupported {
		t.Fatalf("anthropic image should be ErrImageUnsupported, got %v", err)
	}
	if _, err := svc.SetConfig(ctx, ws.ID, ConfigInput{Provider: "deepseek", APIKey: "sk-deepseek"}); err != nil {
		t.Fatalf("set deepseek key: %v", err)
	}
	if _, err := svc.Image(ctx, ws.ID, "a cat", ""); err != ErrImageUnsupported {
		t.Fatalf("deepseek image should be ErrImageUnsupported, got %v", err)
	}
}

// The Azure OpenAI dialect: deployment-scoped paths with an api-version query,
// authenticated by an api-key header (never a bearer token). Asserted both on
// the pure builders and over a real round trip through a mock server.
func TestAzureOpenAIDialect(t *testing.T) {
	cfg := CallConfig{Provider: ProviderAzureOpenAI, APIKey: "sek", BaseURL: "https://res.openai.azure.example/", Model: "gpt-4o-mini", ImageModel: "dall-e-3"}

	req := buildTextRequest(cfg, "hi", "sys")
	wantText := "https://res.openai.azure.example/openai/deployments/gpt-4o-mini/chat/completions?api-version=" + azureAPIVersion
	if req.url != wantText {
		t.Fatalf("azure text url = %q, want %q", req.url, wantText)
	}
	if req.headers["api-key"] != "sek" || req.headers["authorization"] != "" {
		t.Fatalf("azure text headers wrong: %+v", req.headers)
	}

	ireq := buildImageRequest(cfg, "a cat", "")
	wantImage := "https://res.openai.azure.example/openai/deployments/dall-e-3/images/generations?api-version=" + azureAPIVersion
	if ireq.url != wantImage {
		t.Fatalf("azure image url = %q, want %q", ireq.url, wantImage)
	}
	if ireq.headers["api-key"] != "sek" || ireq.headers["authorization"] != "" {
		t.Fatalf("azure image headers wrong: %+v", ireq.headers)
	}

	dreq := buildDescribeImageRequest(cfg, DescribeImageInput{ImageBase64: "QUJD", Instruction: "alt"})
	if dreq.url != wantText || dreq.headers["api-key"] != "sek" {
		t.Fatalf("azure describe request wrong: url=%q headers=%+v", dreq.url, dreq.headers)
	}

	// A deployment name with a space must be path-escaped, not break the URL.
	esc := buildTextRequest(CallConfig{Provider: ProviderAzureOpenAI, APIKey: "k", BaseURL: "https://r.example", Model: "my deploy"}, "x", "")
	if !strings.Contains(esc.url, "/openai/deployments/my%20deploy/") {
		t.Fatalf("deployment not escaped: %q", esc.url)
	}

	// Round trip: the mock server sees the exact path, query, and header.
	var gotPath, gotQuery, gotAPIKey, gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotQuery = r.URL.Path, r.URL.RawQuery
		gotAPIKey, gotAuth = r.Header.Get("api-key"), r.Header.Get("authorization")
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"pong"}}]}`))
	}))
	defer server.Close()
	svc := &Service{client: server.Client()}
	out, err := svc.generateText(CallConfig{Provider: ProviderAzureOpenAI, APIKey: "sek", BaseURL: server.URL, Model: "gpt-4o-mini"}, "ping", "")
	if err != nil || out != "pong" {
		t.Fatalf("azure round trip: out=%q err=%v", out, err)
	}
	if gotPath != "/openai/deployments/gpt-4o-mini/chat/completions" {
		t.Errorf("server saw path %q", gotPath)
	}
	if gotQuery != "api-version="+azureAPIVersion {
		t.Errorf("server saw query %q", gotQuery)
	}
	if gotAPIKey != "sek" || gotAuth != "" {
		t.Errorf("server saw api-key=%q authorization=%q", gotAPIKey, gotAuth)
	}
}

// Providers that route by a user-supplied endpoint are rejected at the write
// boundary when saved without one, instead of failing every later call as an
// opaque 502 against a host-less URL. The check runs before any DB access.
func TestSetConfigRequiresBaseURLForEndpointProviders(t *testing.T) {
	svc := NewService(nil, "test-secret", true)
	// Derive the set from the registry so a future NeedsBaseURL preset is
	// covered automatically instead of silently skipped by a hardcoded list.
	covered := 0
	for _, p := range PRESETS {
		if !p.NeedsBaseURL {
			continue
		}
		covered++
		// An explicit empty URL is rejected before any DB access (this service
		// has no DB); a whitespace-only URL is trimmed at the boundary and must
		// hit the same field-specific rejection, not read as present-but-unsafe.
		// (The omitted-URL case needs stored state and lives in TestAI_DB.)
		if _, err := svc.SetConfig(context.Background(), "ws", ConfigInput{Provider: p.ID, BaseURL: strp(""), APIKey: "k"}); err != ErrBaseURLRequired {
			t.Errorf("SetConfig(%s, empty baseUrl) = %v, want ErrBaseURLRequired", p.ID, err)
		}
		if _, err := svc.SetConfig(context.Background(), "ws", ConfigInput{Provider: p.ID, BaseURL: strp("   "), APIKey: "k"}); err != ErrBaseURLRequired {
			t.Errorf("SetConfig(%s, blank baseUrl) = %v, want ErrBaseURLRequired", p.ID, err)
		}
	}
	if covered == 0 {
		t.Fatal("no NeedsBaseURL presets in the registry; test covers nothing")
	}
}

// EditImage must gate on the EDIT capability, not the broader image one: a
// provider that generates but cannot edit (azure-openai, zhipu) is rejected
// with the capability error instead of reaching the provider and 502ing.
func TestEditImageGatesOnEditCapability(t *testing.T) {
	if err := assertEditImageCapable(CallConfig{Provider: ProviderAzureOpenAI}); err != ErrEditImageUnsupported {
		t.Errorf("azure-openai edit = %v, want ErrEditImageUnsupported", err)
	}
	if err := assertEditImageCapable(CallConfig{Provider: ProviderZhipu}); err != ErrEditImageUnsupported {
		t.Errorf("zhipu edit = %v, want ErrEditImageUnsupported", err)
	}
	if err := assertEditImageCapable(CallConfig{Provider: ProviderOpenAI}); err != nil {
		t.Errorf("openai edit = %v, want nil", err)
	}
	// Generation stays allowed where only editing is missing.
	if err := assertImageCapable(CallConfig{Provider: ProviderAzureOpenAI}); err != nil {
		t.Errorf("azure-openai generate = %v, want nil", err)
	}
}

// T06 acceptance: the OpenAI-compatible dialect carries response_format with
// the schema; a provider that rejects the parameter still succeeds via ONE
// plain-text retry (the prompt-embedded schema remains the constraint).
func TestTextStructuredTransport(t *testing.T) {
	schema := `{"type":"object","required":["a"],"properties":{"a":{"type":"number"}}}`

	// 1. Happy path: the request body carries response_format json_schema.
	var bodies [][]byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		bodies = append(bodies, b)
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"a\":1}"}}]}`))
	}))
	defer server.Close()
	svc := &Service{client: server.Client()}
	cfg := CallConfig{Provider: ProviderCustom, APIKey: "k", BaseURL: server.URL, Model: "m"}
	out, err := svc.generateStructuredText(cfg, "p", "s", schema)
	if err != nil || out != `{"a":1}` {
		t.Fatalf("structured call: out=%q err=%v", out, err)
	}
	if len(bodies) != 1 {
		t.Fatalf("want 1 request, got %d", len(bodies))
	}
	var sent map[string]any
	_ = json.Unmarshal(bodies[0], &sent)
	rf, _ := sent["response_format"].(map[string]any)
	if rf == nil || rf["type"] != "json_schema" {
		t.Fatalf("request missing response_format json_schema: %s", bodies[0])
	}
	js, _ := rf["json_schema"].(map[string]any)
	if js == nil || js["strict"] != false || js["schema"] == nil {
		t.Fatalf("json_schema envelope wrong: %v", rf)
	}

	// 2. Rejecting provider: 400 on response_format, success without it.
	bodies = nil
	reject := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		bodies = append(bodies, b)
		if strings.Contains(string(b), "response_format") {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"a\":2}"}}]}`))
	}))
	defer reject.Close()
	svc2 := &Service{client: reject.Client()}
	cfg2 := CallConfig{Provider: ProviderCustom, APIKey: "k", BaseURL: reject.URL, Model: "m"}
	out, err = svc2.generateStructuredText(cfg2, "p", "s", schema)
	if err != nil || out != `{"a":2}` {
		t.Fatalf("fallback call: out=%q err=%v", out, err)
	}
	if len(bodies) != 2 || strings.Contains(string(bodies[1]), "response_format") {
		t.Fatalf("want structured-then-plain, got %d requests (last: %s)", len(bodies), bodies[len(bodies)-1])
	}

	// 3. Auth failures are NOT negotiable: no blind retry against a 401.
	calls := 0
	authFail := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer authFail.Close()
	svc3 := &Service{client: authFail.Client()}
	if _, err := (svc3).generateStructuredText(CallConfig{Provider: ProviderCustom, APIKey: "k", BaseURL: authFail.URL, Model: "m"}, "p", "s", schema); err == nil {
		t.Fatal("401 must fail")
	}
	if calls != 1 {
		t.Fatalf("401 must not retry, got %d calls", calls)
	}
}

// The Anthropic structured dialect: one forced tool whose input schema is the
// target schema; the reply's tool_use input is the structured payload.
func TestStructuredAnthropicDialect(t *testing.T) {
	schema := `{"type":"object","properties":{"a":{"type":"number"}}}`
	req := buildStructuredTextRequest(CallConfig{Provider: ProviderAnthropic, APIKey: "k"}, "p", "s", schema)
	body, _ := json.Marshal(req.body)
	if !strings.Contains(string(body), `"tool_choice"`) || !strings.Contains(string(body), structuredToolName) || !strings.Contains(string(body), `"input_schema"`) {
		t.Fatalf("anthropic structured body missing forced tool: %s", body)
	}
	// tool_use input is extracted and re-serialized.
	raw := []byte(`{"content":[{"type":"tool_use","name":"emit_result","input":{"a":3}}]}`)
	if got := parseStructuredResponse(ProviderAnthropic, raw); got != `{"a":3}` {
		t.Fatalf("tool_use parse = %q", got)
	}
	// Text-block fallback when the model answered in prose.
	raw = []byte(`{"content":[{"type":"text","text":"{\"a\":4}"}]}`)
	if got := parseStructuredResponse(ProviderAnthropic, raw); got != `{"a":4}` {
		t.Fatalf("text fallback parse = %q", got)
	}
	// An unparseable schema degrades to the PLAIN request, never an error.
	plain := buildStructuredTextRequest(CallConfig{Provider: ProviderAnthropic, APIKey: "k"}, "p", "s", "{not json")
	pbody, _ := json.Marshal(plain.body)
	if strings.Contains(string(pbody), "tool_choice") {
		t.Fatalf("invalid schema must fall back to a plain request: %s", pbody)
	}
}

// T16: search transports. Cleaned results, caps, and the SearXNG SSRF gate.
func TestSearchTransports(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		if r.Method == http.MethodPost { // hosted-API shape
			_, _ = w.Write([]byte(`{"results":[{"title":"A","url":"https://a","content":" first "},{"title":"","url":"","content":""},{"title":"B","url":"https://b","content":"second"}]}`))
			return
		}
		// metasearch shape
		if r.URL.Query().Get("format") != "json" || r.URL.Query().Get("q") == "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		_, _ = w.Write([]byte(`{"results":[{"title":"S","url":"https://s","content":"meta"}]}`))
	}))
	defer server.Close()
	svc := &Service{client: server.Client(), allowLocal: true}

	hits, err := svc.searchTavily(server.URL, "k", "query", 10)
	if err != nil || len(hits) != 2 || hits[0].Content != "first" {
		t.Fatalf("hosted search: hits=%+v err=%v", hits, err)
	}
	hits, err = svc.searchSearx(server.URL, "query terms", 5)
	if err != nil || len(hits) != 1 || hits[0].Title != "S" {
		t.Fatalf("metasearch: hits=%+v err=%v", hits, err)
	}
}

func TestCleanResultsCapsAndDropsEmpties(t *testing.T) {
	in := make([]SearchResult, 0, 15)
	for i := 0; i < 15; i++ {
		in = append(in, SearchResult{Title: "t", URL: "https://x", Content: strings.Repeat("c", 3000)})
	}
	out := cleanResults(in, 10)
	if len(out) != 10 || len(out[0].Content) != 2000 {
		t.Fatalf("caps wrong: n=%d len=%d", len(out), len(out[0].Content))
	}
	if got := cleanResults([]SearchResult{{URL: "https://x"}}, 5); len(got) != 0 {
		t.Fatalf("empty hit kept: %+v", got)
	}
}
