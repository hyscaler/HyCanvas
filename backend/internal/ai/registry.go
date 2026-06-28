// Provider registry, per-feature routing, and org policy (doc 19 FR: provider
// adapter layer, per-feature routing/fallback, org allow/block + spend caps).
// All pure: the registry is data, routing resolves a feature to a model +
// capability check, and the policy gate is a decision function. The transport
// (provider.go) and storage stay separate so these are unit-testable.
package ai

// Capabilities describes what a provider can do, so the UI and the router can
// gate features (e.g. image generation on a text-only provider).
type Capabilities struct {
	Text          bool `json:"text"`
	Image         bool `json:"image"`
	DescribeImage bool `json:"describeImage"`
	EditImage     bool `json:"editImage"`
}

// ProviderPreset is a known provider's defaults + capabilities. A custom base
// URL is allowed (ProviderCustom); the rest are OpenAI-compatible or Anthropic.
type ProviderPreset struct {
	ID                string       `json:"id"`
	Label             string       `json:"label"`
	BaseURL           string       `json:"baseUrl"`
	DefaultModel      string       `json:"defaultModel"`
	DefaultImageModel string       `json:"defaultImageModel,omitempty"`
	Capabilities      Capabilities `json:"capabilities"`
	/** True when the user must supply the base URL (Azure/custom). */
	NeedsBaseURL bool `json:"needsBaseUrl,omitempty"`
}

// PRESETS is the built-in provider catalog (BYO key per workspace). OpenAI-
// compatible endpoints share the chat/completions + images shapes; Anthropic
// uses its own (handled in provider.go).
var PRESETS = []ProviderPreset{
	{ID: "openai", Label: "OpenAI", BaseURL: "https://api.openai.com/v1", DefaultModel: "gpt-4o-mini", DefaultImageModel: "dall-e-3", Capabilities: Capabilities{Text: true, Image: true, DescribeImage: true, EditImage: true}},
	{ID: "anthropic", Label: "Anthropic (Claude)", BaseURL: "https://api.anthropic.com", DefaultModel: "claude-opus-4-8", Capabilities: Capabilities{Text: true, DescribeImage: true}},
	{ID: "deepseek", Label: "DeepSeek", BaseURL: "https://api.deepseek.com/v1", DefaultModel: "deepseek-chat", Capabilities: Capabilities{Text: true}},
	{ID: "google", Label: "Google (Gemini)", BaseURL: "https://generativelanguage.googleapis.com/v1beta/openai", DefaultModel: "gemini-1.5-flash", Capabilities: Capabilities{Text: true, DescribeImage: true}},
	{ID: "mistral", Label: "Mistral", BaseURL: "https://api.mistral.ai/v1", DefaultModel: "mistral-large-latest", Capabilities: Capabilities{Text: true}},
	{ID: "groq", Label: "Groq", BaseURL: "https://api.groq.com/openai/v1", DefaultModel: "llama-3.3-70b-versatile", Capabilities: Capabilities{Text: true}},
	{ID: "together", Label: "Together AI", BaseURL: "https://api.together.xyz/v1", DefaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo", DefaultImageModel: "black-forest-labs/FLUX.1-schnell", Capabilities: Capabilities{Text: true, Image: true}},
	{ID: "openrouter", Label: "OpenRouter", BaseURL: "https://openrouter.ai/api/v1", DefaultModel: "openai/gpt-4o-mini", Capabilities: Capabilities{Text: true}},
	{ID: "azure-openai", Label: "Azure OpenAI", BaseURL: "", DefaultModel: "gpt-4o-mini", DefaultImageModel: "dall-e-3", Capabilities: Capabilities{Text: true, Image: true, DescribeImage: true, EditImage: true}, NeedsBaseURL: true},
	{ID: "custom", Label: "Custom (OpenAI-compatible)", BaseURL: "", DefaultModel: "", Capabilities: Capabilities{Text: true, Image: true, DescribeImage: true, EditImage: true}, NeedsBaseURL: true},
}

// PresetFor returns the preset for an id, or nil. Unknown providers (legacy
// rows) fall back to the custom preset's permissive capabilities.
func PresetFor(id string) *ProviderPreset {
	for i := range PRESETS {
		if PRESETS[i].ID == id {
			return &PRESETS[i]
		}
	}
	return nil
}

// Feature is an AI capability a call needs.
type Feature string

const (
	FeatureText          Feature = "text"
	FeatureImage         Feature = "image"
	FeatureDescribeImage Feature = "describeImage"
	FeatureEditImage     Feature = "editImage"
)

func (c Capabilities) supports(f Feature) bool {
	switch f {
	case FeatureText:
		return c.Text
	case FeatureImage:
		return c.Image
	case FeatureDescribeImage:
		return c.DescribeImage
	case FeatureEditImage:
		return c.EditImage
	}
	return false
}

// Route is the resolved model + support decision for a (provider, feature).
type Route struct {
	Model     string
	Supported bool
}

// ResolveRoute picks the model for a feature from the workspace config, falling
// back to the preset defaults, and reports whether the provider supports the
// feature (FR per-feature routing). Text-ish features use the text model;
// image-ish features use the image model. An unknown provider id is treated as
// custom (permissive) so legacy/self-hosted configs keep working.
func ResolveRoute(providerID, model, imageModel string, f Feature) Route {
	preset := PresetFor(providerID)
	caps := Capabilities{Text: true, Image: true, DescribeImage: true, EditImage: true} // custom default
	var dModel, dImage string
	if preset != nil {
		caps = preset.Capabilities
		dModel, dImage = preset.DefaultModel, preset.DefaultImageModel
	}
	pick := model
	if f == FeatureImage || f == FeatureEditImage {
		pick = orDefault(imageModel, dImage)
	} else {
		pick = orDefault(model, dModel)
	}
	return Route{Model: pick, Supported: caps.supports(f)}
}

// OrgPolicy is a workspace/org AI governance policy (all optional / additive).
type OrgPolicy struct {
	// AllowedProviders, when non-empty, restricts which provider ids may be used.
	AllowedProviders []string `json:"allowedProviders,omitempty"`
	// BlockedProviders is an explicit deny list (takes precedence over allow).
	BlockedProviders []string `json:"blockedProviders,omitempty"`
	// MonthlyTokenCap > 0 caps total tokens per billing month (0 = unlimited).
	MonthlyTokenCap int `json:"monthlyTokenCap,omitempty"`
}

// Usage is the current period's accumulated usage (for cap checks).
type Usage struct {
	TokensThisMonth int `json:"tokensThisMonth"`
}

// PolicyDecision is the outcome of a policy check.
type PolicyDecision struct {
	Allowed bool   `json:"allowed"`
	Reason  string `json:"reason,omitempty"`
}

func contains(xs []string, v string) bool {
	for _, x := range xs {
		if x == v {
			return true
		}
	}
	return false
}

// CheckPolicy decides whether a call to providerID using ~estTokens is permitted
// under the org policy and current usage. An empty policy allows everything.
func CheckPolicy(policy OrgPolicy, usage Usage, providerID string, estTokens int) PolicyDecision {
	if contains(policy.BlockedProviders, providerID) {
		return PolicyDecision{Allowed: false, Reason: "provider blocked by organization policy"}
	}
	if len(policy.AllowedProviders) > 0 && !contains(policy.AllowedProviders, providerID) {
		return PolicyDecision{Allowed: false, Reason: "provider not in the organization's allowed list"}
	}
	if policy.MonthlyTokenCap > 0 && usage.TokensThisMonth+estTokens > policy.MonthlyTokenCap {
		return PolicyDecision{Allowed: false, Reason: "monthly AI usage limit reached"}
	}
	return PolicyDecision{Allowed: true}
}
