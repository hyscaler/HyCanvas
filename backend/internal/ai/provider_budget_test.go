package ai

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The Claude transport: the current model by default, the system prompt as
// a cached block, and output caps sized for what each call produces.
func TestAnthropicRequestDefaultsAndCaching(t *testing.T) {
	cfg := CallConfig{Provider: ProviderAnthropic, APIKey: "k"}
	text := buildTextRequest(cfg, "hi", "the rules")
	body, _ := json.Marshal(text.body)
	for _, want := range []string{`"model":"claude-opus-5"`, `"max_tokens":4096`, `"cache_control":{"type":"ephemeral"}`, `"text":"the rules"`} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("text request missing %s:\n%s", want, body)
		}
	}
	structured := buildStructuredTextRequest(cfg, "p", "the rules", `{"type":"object"}`)
	body, _ = json.Marshal(structured.body)
	for _, want := range []string{`"max_tokens":16384`, `"cache_control"`, `"tool_choice"`} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("structured request missing %s:\n%s", want, body)
		}
	}
	// No system prompt, no system block at all.
	bare, _ := json.Marshal(buildTextRequest(cfg, "hi", "").body)
	if strings.Contains(string(bare), `"system"`) {
		t.Fatalf("empty system prompt must not send a system block:\n%s", bare)
	}
	// The registry and the transport agree on the defaults, and the Bedrock
	// default is the cross-region profile the deployment uses.
	if p := PresetFor("anthropic"); p == nil || p.DefaultModel != defaultAnthropicModel {
		t.Fatalf("registry default %v, transport default %s", p, defaultAnthropicModel)
	}
	if defaultBedrockModel != "us.anthropic.claude-opus-4-7" {
		t.Fatalf("bedrock default = %s", defaultBedrockModel)
	}
	if p := PresetFor("bedrock"); p == nil || p.DefaultModel != defaultBedrockModel {
		t.Fatalf("bedrock registry default %v, transport default %s", p, defaultBedrockModel)
	}
	if req := buildTextRequest(CallConfig{Provider: ProviderBedrock, APIKey: "AKIA", APISecret: "s", BaseURL: "https://bedrock-runtime.us-east-1.amazonaws.com"}, "hi", ""); !strings.Contains(req.url, "/model/us.anthropic.claude-opus-4-7/converse") {
		t.Fatalf("bedrock default model not on the route: %s", req.url)
	}
	// Bedrock's plain call and its structured fallback carry the matching caps.
	bcfg := CallConfig{Provider: ProviderBedrock, APIKey: "AKIA", APISecret: "s", BaseURL: "https://bedrock-runtime.us-east-1.amazonaws.com"}
	plain, _ := json.Marshal(buildTextRequest(bcfg, "hi", "").body)
	big, _ := json.Marshal(buildStructuredTextRequest(bcfg, "hi", "", `{"type":"object"}`).body)
	if !strings.Contains(string(plain), `"maxTokens":4096`) || !strings.Contains(string(big), `"maxTokens":16384`) {
		t.Fatalf("bedrock caps wrong:\n%s\n%s", plain, big)
	}
}

// A reply the model stopped at its cap is reported as such, in every
// dialect, instead of reaching the caller as JSON that merely fails to parse.
func TestTruncatedRepliesAreReported(t *testing.T) {
	cases := []struct {
		provider  Provider
		truncated string
		complete  string
	}{
		{ProviderAnthropic,
			`{"stop_reason":"max_tokens","content":[{"type":"text","text":"{\"title\":\"cut"}]}`,
			`{"stop_reason":"end_turn","content":[{"type":"text","text":"whole"}]}`},
		{ProviderBedrock,
			`{"stopReason":"max_tokens","output":{"message":{"content":[{"text":"cut"}]}}}`,
			`{"stopReason":"end_turn","output":{"message":{"content":[{"text":"whole"}]}}}`},
		{ProviderOpenAI,
			`{"choices":[{"finish_reason":"length","message":{"content":"cut"}}]}`,
			`{"choices":[{"finish_reason":"stop","message":{"content":"whole"}}]}`},
	}
	for _, c := range cases {
		if !replyTruncated(c.provider, []byte(c.truncated)) {
			t.Fatalf("%s: truncated reply not detected", c.provider)
		}
		if replyTruncated(c.provider, []byte(c.complete)) {
			t.Fatalf("%s: complete reply flagged as truncated", c.provider)
		}
	}

	// Through the call path: the error is the truncation, and badGateway
	// keeps it visible to the API layer.
	reply := `{"stop_reason":"max_tokens","content":[{"type":"tool_use","name":"emit_result","input":{"title":"cut"}}]}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(reply))
	}))
	defer server.Close()
	svc := &Service{client: server.Client(), allowLocal: true}
	cfg := CallConfig{Provider: ProviderAnthropic, APIKey: "k", BaseURL: server.URL}
	if _, err := svc.generateStructuredText(cfg, "p", "s", `{"type":"object"}`); !errors.Is(err, ErrReplyTruncated) {
		t.Fatalf("structured: want ErrReplyTruncated, got %v", err)
	}
	if _, err := svc.generateText(cfg, "p", "s"); !errors.Is(err, ErrReplyTruncated) {
		t.Fatalf("text: want ErrReplyTruncated, got %v", err)
	}
	wrapped := badGateway(cfg, ErrReplyTruncated)
	if !errors.Is(wrapped, ErrBadGateway) || !errors.Is(wrapped, ErrReplyTruncated) {
		t.Fatalf("badGateway must keep the truncation visible: %v", wrapped)
	}
	reply = `{"stop_reason":"end_turn","content":[{"type":"tool_use","name":"emit_result","input":{"title":"whole"}}]}`
	if got, err := svc.generateStructuredText(cfg, "p", "s", `{"type":"object"}`); err != nil || got != `{"title":"whole"}` {
		t.Fatalf("complete reply: got %q err %v", got, err)
	}
}
