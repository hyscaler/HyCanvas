package ai

import "testing"

func TestPresetRegistry(t *testing.T) {
	if PresetFor("openai") == nil || PresetFor("anthropic") == nil {
		t.Fatal("core presets must exist")
	}
	if PresetFor("nope") != nil {
		t.Fatal("unknown preset should be nil")
	}
	// OpenAI does images; Anthropic does not.
	if !PresetFor("openai").Capabilities.Image {
		t.Fatal("openai should support image")
	}
	if PresetFor("anthropic").Capabilities.Image {
		t.Fatal("anthropic should not support image generation")
	}
}

func TestDeepSeekPreset(t *testing.T) {
	p := PresetFor("deepseek")
	if p == nil {
		t.Fatal("deepseek preset must exist")
	}
	if p.BaseURL != "https://api.deepseek.com/v1" || p.DefaultModel != "deepseek-chat" {
		t.Fatalf("deepseek defaults wrong: %+v", p)
	}
	// DeepSeek is OpenAI-compatible text-only: no image/vision/edit.
	if !p.Capabilities.Text || p.Capabilities.Image || p.Capabilities.DescribeImage || p.Capabilities.EditImage {
		t.Fatalf("deepseek capabilities wrong: %+v", p.Capabilities)
	}
	// Image-ish features are unsupported; text resolves to the default model.
	if ResolveRoute("deepseek", "", "", FeatureImage).Supported {
		t.Fatal("deepseek image should be unsupported")
	}
	if r := ResolveRoute("deepseek", "", "", FeatureText); !r.Supported || r.Model != "deepseek-chat" {
		t.Fatalf("deepseek text route: %+v", r)
	}
	// A DeepSeek call (resolved with the preset base URL) routes to DeepSeek, not
	// the OpenAI default baked into the OpenAI-compatible transport path.
	req := buildTextRequest(CallConfig{Provider: ProviderDeepSeek, APIKey: "k", BaseURL: p.BaseURL, Model: p.DefaultModel}, "hi", "")
	if req.url != "https://api.deepseek.com/v1/chat/completions" || req.headers["authorization"] != "Bearer k" {
		t.Fatalf("deepseek request wrong: %+v", req)
	}
}

func TestResolveRoute(t *testing.T) {
	// Text feature uses the text model (config override wins over preset default).
	r := ResolveRoute("openai", "gpt-4o", "", FeatureText)
	if r.Model != "gpt-4o" || !r.Supported {
		t.Fatalf("text route: %+v", r)
	}
	// Falls back to the preset default when unset.
	r = ResolveRoute("openai", "", "", FeatureText)
	if r.Model != "gpt-4o-mini" {
		t.Fatalf("default text model: %+v", r)
	}
	// Image feature uses the image model; anthropic does not support it.
	r = ResolveRoute("anthropic", "", "", FeatureImage)
	if r.Supported {
		t.Fatalf("anthropic image should be unsupported: %+v", r)
	}
	r = ResolveRoute("openai", "", "dall-e-3", FeatureImage)
	if r.Model != "dall-e-3" || !r.Supported {
		t.Fatalf("image route: %+v", r)
	}
	// Unknown provider id -> treated as custom (permissive), default model unset.
	r = ResolveRoute("self-hosted", "llama", "", FeatureText)
	if !r.Supported || r.Model != "llama" {
		t.Fatalf("custom-fallback route: %+v", r)
	}
}

func TestCheckPolicy(t *testing.T) {
	// Empty policy allows anything.
	if d := CheckPolicy(OrgPolicy{}, Usage{}, "openai", 1000); !d.Allowed {
		t.Fatalf("empty policy should allow: %+v", d)
	}
	// Allowlist excludes others.
	allow := OrgPolicy{AllowedProviders: []string{"openai"}}
	if CheckPolicy(allow, Usage{}, "groq", 10).Allowed {
		t.Fatal("provider outside allowlist should be denied")
	}
	if !CheckPolicy(allow, Usage{}, "openai", 10).Allowed {
		t.Fatal("allowlisted provider should pass")
	}
	// Blocklist takes precedence.
	if CheckPolicy(OrgPolicy{BlockedProviders: []string{"openai"}}, Usage{}, "openai", 10).Allowed {
		t.Fatal("blocked provider should be denied")
	}
	// Monthly cap.
	cap := OrgPolicy{MonthlyTokenCap: 1000}
	if CheckPolicy(cap, Usage{TokensThisMonth: 950}, "openai", 100).Allowed {
		t.Fatal("over-cap should be denied")
	}
	if !CheckPolicy(cap, Usage{TokensThisMonth: 900}, "openai", 50).Allowed {
		t.Fatal("under-cap should pass")
	}
}
