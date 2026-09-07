package ai

import (
	"strings"
	"testing"
)

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

func TestZhipuPreset(t *testing.T) {
	p := PresetFor("zhipu")
	if p == nil {
		t.Fatal("zhipu preset must exist")
	}
	if p.BaseURL != "https://api.z.ai/api/paas/v4" || p.DefaultModel != "glm-4.6" || p.DefaultImageModel != "cogview-4-250304" {
		t.Fatalf("zhipu defaults wrong: %+v", p)
	}
	// GLM does text; CogView does image. Text + Image supported.
	if !p.Capabilities.Text || !p.Capabilities.Image {
		t.Fatalf("zhipu should support text and image: %+v", p.Capabilities)
	}
	// Image feature resolves to the CogView image model, not the text model.
	if r := ResolveRoute("zhipu", "", "", FeatureImage); !r.Supported || r.Model != "cogview-4-250304" {
		t.Fatalf("zhipu image route: %+v", r)
	}
	// An image call routes to the Zhipu endpoint with the CogView model.
	req := buildImageRequest(CallConfig{Provider: ProviderZhipu, APIKey: "k", BaseURL: p.BaseURL, ImageModel: p.DefaultImageModel}, "a cat", "1024x1024")
	if req.url != "https://api.z.ai/api/paas/v4/images/generations" {
		t.Fatalf("zhipu image url wrong: %q", req.url)
	}
	body, _ := req.body.(map[string]any)
	if m, _ := body["model"].(string); m != "cogview-4-250304" {
		t.Fatalf("zhipu image model wrong: %v", body["model"])
	}
}

// TestProviderSetMatchesPresets guards against the config allow-list drifting
// from the advertised catalog: every preset shown in the config UI must be
// accepted by SetConfig (regression: zhipu/google/together/... were rejected
// because providerSet was a stale hand-maintained list).
func TestProviderSetMatchesPresets(t *testing.T) {
	for i := range PRESETS {
		id := PRESETS[i].ID
		if !providerSet[id] {
			t.Fatalf("preset %q is advertised but not configurable (missing from providerSet)", id)
		}
	}
	if len(providerSet) != len(PRESETS) {
		t.Fatalf("providerSet (%d) and PRESETS (%d) out of sync", len(providerSet), len(PRESETS))
	}
}

// Moonshot (Kimi) rides the OpenAI-compatible dialect: only Anthropic has its
// own request shape, so the preset must build a plain chat/completions call
// against Moonshot's host with the configured model, and must not advertise
// image generation the API does not offer.
func TestMoonshotPreset(t *testing.T) {
	p := PresetFor("moonshot")
	if p == nil {
		t.Fatal("moonshot preset must exist")
	}
	if p.Capabilities.Image || p.Capabilities.EditImage {
		t.Fatal("moonshot has no image generation; advertising it would fail every call")
	}
	if !p.Capabilities.Text {
		t.Fatal("moonshot must support text")
	}
	req := buildTextRequest(CallConfig{Provider: "moonshot", APIKey: "k", BaseURL: p.BaseURL, Model: p.DefaultModel}, "hi", "sys")
	if req.url != "https://api.moonshot.ai/v1/chat/completions" {
		t.Fatalf("unexpected endpoint: %s", req.url)
	}
	if req.headers["authorization"] != "Bearer k" {
		t.Fatalf("expected bearer auth, got %v", req.headers["authorization"])
	}
	body, _ := req.body.(map[string]any)
	if body["model"] != p.DefaultModel {
		t.Fatalf("model not carried: %v", body["model"])
	}
	// The text route resolves to the text model, and the image route is
	// unsupported rather than silently routed to some default.
	if r := ResolveRoute("moonshot", "", "", FeatureText); !r.Supported || r.Model != p.DefaultModel {
		t.Fatalf("text route wrong: %+v", r)
	}
	if r := ResolveRoute("moonshot", "", "", FeatureImage); r.Supported {
		t.Fatal("image route must be unsupported for moonshot")
	}
}

// OpenRouter serves image generation on its unified /images route rather than
// the /images/generations path every other OpenAI-compatible preset uses, so
// the preset is not a capability flag flip: the transport has to branch. These
// assertions pin the branch, the models the preset advertises, and the fact
// that turning it on did not move any other provider's endpoint.
func TestOpenRouterPreset(t *testing.T) {
	p := PresetFor("openrouter")
	if p == nil {
		t.Fatal("openrouter preset must exist")
	}
	if p.BaseURL != "https://openrouter.ai/api/v1" || p.DefaultModel != "openai/gpt-4o-mini" {
		t.Fatalf("openrouter text defaults wrong: %+v", p)
	}
	// The shipped default is the model that was exercised against OpenRouter.
	// openai/dall-e-3 is absent from OpenRouter's catalog, so defaulting to it
	// would fail every user's first generation.
	if p.DefaultImageModel != "qwen/qwen-image-3-pro" {
		t.Fatalf("openrouter image default wrong: %q", p.DefaultImageModel)
	}
	if !p.Capabilities.Text || !p.Capabilities.Image {
		t.Fatalf("openrouter should support text and image: %+v", p.Capabilities)
	}
	// Neither is verified against the API, and ResolveRoute gates on the flag
	// alone, so advertising either would turn a clean rejection into a
	// confusing provider error.
	if p.Capabilities.EditImage || p.Capabilities.DescribeImage {
		t.Fatalf("openrouter must not advertise unverified capabilities: %+v", p.Capabilities)
	}

	// The image feature routes to the image model, not the text one.
	if r := ResolveRoute("openrouter", "", "", FeatureImage); !r.Supported || r.Model != "qwen/qwen-image-3-pro" {
		t.Fatalf("openrouter image route: %+v", r)
	}
	if r := ResolveRoute("openrouter", "", "", FeatureText); !r.Supported || r.Model != "openai/gpt-4o-mini" {
		t.Fatalf("openrouter text route: %+v", r)
	}
	if ResolveRoute("openrouter", "", "", FeatureEditImage).Supported {
		t.Fatal("openrouter edit must stay unsupported")
	}

	cfg := CallConfig{Provider: ProviderOpenRouter, APIKey: "k", BaseURL: p.BaseURL, Model: p.DefaultModel, ImageModel: p.DefaultImageModel}

	// Image generation goes to /images. /images/generations does not exist on
	// OpenRouter, so this is the whole reason the preset needed a code change.
	ireq := buildImageRequest(cfg, "a red panda", "1024x1024")
	if ireq.url != "https://openrouter.ai/api/v1/images" {
		t.Fatalf("openrouter image url wrong: %q", ireq.url)
	}
	if ireq.headers["authorization"] != "Bearer k" {
		t.Fatalf("openrouter image auth wrong: %v", ireq.headers["authorization"])
	}
	body, _ := ireq.body.(map[string]any)
	if m, _ := body["model"].(string); m != "qwen/qwen-image-3-pro" {
		t.Fatalf("openrouter image model wrong: %v", body["model"])
	}
	if body["prompt"] != "a red panda" {
		t.Fatalf("openrouter prompt not carried: %v", body["prompt"])
	}

	// Text is unchanged: the ordinary OpenAI-compatible chat route.
	treq := buildTextRequest(cfg, "hi", "")
	if treq.url != "https://openrouter.ai/api/v1/chat/completions" {
		t.Fatalf("openrouter text url wrong: %q", treq.url)
	}

	// The branch is scoped to OpenRouter: every other OpenAI-compatible preset
	// keeps the /images/generations path.
	for _, id := range []string{"openai", "zhipu", "together", "custom"} {
		q := PresetFor(id)
		if q == nil || !q.Capabilities.Image {
			continue
		}
		r := buildImageRequest(CallConfig{Provider: Provider(id), APIKey: "k", BaseURL: q.BaseURL, ImageModel: q.DefaultImageModel}, "x", "")
		if !strings.HasSuffix(r.url, "/images/generations") {
			t.Fatalf("%s image url moved: %q", id, r.url)
		}
	}
}

// The longer image deadline must not leak onto text and vision calls: those are
// the ones a user is waiting on interactively.
func TestImageDeadlineIsScopedToImageRequests(t *testing.T) {
	if imageTimeout <= providerTimeout {
		t.Fatalf("image timeout (%s) should exceed the default (%s)", imageTimeout, providerTimeout)
	}
	cfg := CallConfig{Provider: ProviderOpenRouter, APIKey: "k", BaseURL: "https://openrouter.ai/api/v1"}
	if got := buildImageRequest(cfg, "a cat", "").timeout; got != imageTimeout {
		t.Fatalf("image request timeout = %s, want %s", got, imageTimeout)
	}
	// Zero means the default deadline, applied in do().
	if got := buildTextRequest(cfg, "hi", "").timeout; got != 0 {
		t.Fatalf("text request should not carry the image deadline, got %s", got)
	}
	if got := buildDescribeImageRequest(cfg, DescribeImageInput{ImageBase64: "QUJD"}).timeout; got != 0 {
		t.Fatalf("vision request should not carry the image deadline, got %s", got)
	}
}

// OpenRouter reports the encoding per image and its models do not all emit PNG.
func TestImageResponseHonoursMediaType(t *testing.T) {
	if got := parseImageResponse([]byte(`{"data":[{"b64_json":"QUJD","media_type":"image/webp"}]}`)); got != "data:image/webp;base64,QUJD" {
		t.Fatalf("media_type ignored: %q", got)
	}
	// Providers that omit it keep the historical PNG assumption.
	if got := parseImageResponse([]byte(`{"data":[{"b64_json":"QUJD"}]}`)); got != "data:image/png;base64,QUJD" {
		t.Fatalf("png default lost: %q", got)
	}
}

// VerifyImageConfig proves a key by GETting the provider's model list and
// reading a 401 as "the key was rejected". That reasoning holds only where the
// listing is authenticated. OpenRouter serves its catalog publicly (200 for no
// key and for a bad one alike), so probing /models there would call every
// typo'd key verified. It probes the authenticated /key route instead.
func TestCredentialProbeIsAuthenticatedPerProvider(t *testing.T) {
	if got := credentialProbeOp(CallConfig{Provider: ProviderOpenRouter}); got != "key" {
		t.Fatalf("openrouter probe = %q, want \"key\": /models is public there, so it cannot detect a bad key", got)
	}
	// Everyone else keeps the OpenAI-compatible listing, which does authenticate.
	for _, p := range []Provider{ProviderOpenAI, ProviderZhipu, ProviderDeepSeek, ProviderCustom, ProviderAzureOpenAI} {
		if got := credentialProbeOp(CallConfig{Provider: p}); got != "models" {
			t.Fatalf("%s probe = %q, want \"models\"", p, got)
		}
	}
}
