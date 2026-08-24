// Package ai ports the NestJS AI module (doc 19): per-workspace provider config
// with the API key encrypted at rest (AES-256-GCM via internal/auth/secrets),
// and text/image/describe/edit generation through the provider adapter. The key
// is decrypted only here, only to make the outbound call, and never returned to
// the client.
package ai

import (
	"context"
	"crypto/rand"
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"hycanvas/backend/internal/auth/secrets"
)

// altTextInstruction is the default alt-text generation prompt (F22 FR-12).
const altTextInstruction = "Describe this image in a single concise sentence suitable for alt text. " +
	"Be specific and factual; do not start with \"image of\" or \"picture of\"; " +
	"return only the description with no preamble or quotes."

// Errors map to RFC 7807 statuses at the HTTP layer.
var (
	ErrBadRequest = errors.New("bad request")
	ErrBadGateway = errors.New("provider request failed")
	// ErrImageUnsupported is returned when an image op is attempted on a provider
	// the registry marks as text-only (DeepSeek, Anthropic, Google, Mistral,
	// Groq, OpenRouter). Distinct from ErrBadRequest so the API can tell the user
	// their provider can't do images, not that their request/config is malformed.
	ErrImageUnsupported = errors.New("provider does not support image generation")
	// ErrBaseURLRequired is returned when a config for an endpoint-routed
	// provider (Azure/custom) is saved without a base URL. Distinct from
	// ErrBadRequest so the UI can point the user at the missing field.
	ErrBaseURLRequired = errors.New("provider requires a base URL")
	// ErrKeyRequiredForProviderChange is returned when a provider change
	// arrives without a new API key while one is stored: silently clearing
	// the credential (data loss) and silently carrying it to another vendor
	// (leak) are both unacceptable, so the change must bring its own key.
	ErrKeyRequiredForProviderChange = errors.New("changing the provider requires its API key")
	// ErrEditImageUnsupported is the edit-specific capability rejection:
	// several providers generate images but cannot edit them (azure-openai,
	// zhipu), so the generation-worded message would be wrong.
	ErrEditImageUnsupported = errors.New("provider does not support image editing")
)

// DBTX is the query surface (satisfied by *pgxpool.Pool and pgx.Tx).
type DBTX interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Service is the AI module.
type Service struct {
	db         DBTX
	secret     string // AI_SECRET (falls back to JWT_SECRET) for key crypto
	allowLocal bool   // permit http://localhost base URLs (dev only)
	client     *http.Client
}

// NewService wires the AI service. secret is the AES key material; allowLocalHTTP
// permits localhost http base URLs (dev).
func NewService(db DBTX, secret string, allowLocalHTTP bool) *Service {
	return &Service{db: db, secret: secret, allowLocal: allowLocalHTTP, client: newHTTPClient()}
}

// ConfigInput is the set-config payload. BaseURL is a pointer for PATCH
// semantics: nil preserves the stored URL, an empty string clears it. (Model
// and ImageModel keep plain overwrite semantics: an omitted model means "use
// the preset default", which is a reset, not data loss.)
type ConfigInput struct {
	Provider   string
	Model      string
	ImageModel string
	BaseURL    *string
	APIKey     string
}

// ConfigView is the public config (never includes the key).
type ConfigView struct {
	Provider     string       `json:"provider"`
	Model        *string      `json:"model"`
	ImageModel   *string      `json:"imageModel"`
	BaseURL      *string      `json:"baseUrl"`
	HasKey       bool         `json:"hasKey"`
	Capabilities Capabilities `json:"capabilities"`
}

type configRow struct {
	provider   string
	model      *string
	imageModel *string
	baseURL    *string
	keyCipher  *string
	keyIV      *string
	keyTag     *string
}

func (s *Service) getRow(ctx context.Context, workspaceID string) (*configRow, error) {
	const q = `SELECT provider, model, "image_model", "base_url", "key_cipher", "key_iv", "key_tag"
		FROM "ai_configs" WHERE "workspace_id" = $1`
	var r configRow
	err := s.db.QueryRow(ctx, q, workspaceID).Scan(&r.provider, &r.model, &r.imageModel, &r.baseURL, &r.keyCipher, &r.keyIV, &r.keyTag)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func toConfigView(r *configRow) *ConfigView {
	// Surface the provider's capabilities so the UI can gate features (e.g. only
	// offer image generation on an image-capable provider). Unknown/custom
	// providers fall back to the permissive default (same as ResolveRoute).
	caps := Capabilities{Text: true, Image: true, DescribeImage: true, EditImage: true}
	if p := PresetFor(r.provider); p != nil {
		caps = p.Capabilities
	}
	return &ConfigView{
		Provider: r.provider, Model: r.model, ImageModel: r.imageModel, BaseURL: r.baseURL,
		HasKey:       r.keyCipher != nil && *r.keyCipher != "",
		Capabilities: caps,
	}
}

// GetConfig returns the workspace's provider config, or nil when none is set.
func (s *Service) GetConfig(ctx context.Context, workspaceID string) (*ConfigView, error) {
	r, err := s.getRow(ctx, workspaceID)
	if err != nil || r == nil {
		return nil, err
	}
	return toConfigView(r), nil
}

// providerSet is the set of configurable provider ids, derived from the registry
// so every advertised preset (openai, anthropic, deepseek, zhipu, google,
// mistral, groq, together, openrouter, azure-openai, custom) is accepted by
// SetConfig. Deriving it from PRESETS keeps this in lockstep with the catalog
// the config UI is shown, instead of a hand-maintained list that drifts.
var providerSet = func() map[string]bool {
	m := make(map[string]bool, len(PRESETS))
	for i := range PRESETS {
		m[PRESETS[i].ID] = true
	}
	return m
}()

// SetConfig upserts the workspace's provider config. A new apiKey is encrypted;
// changing the provider without a new key clears the stored key (so an old
// vendor's key is never sent to a different vendor).
func (s *Service) SetConfig(ctx context.Context, workspaceID string, in ConfigInput) (*ConfigView, error) {
	if !providerSet[in.Provider] {
		return nil, ErrBadRequest
	}
	// Statically decidable URL rejections run before any DB access: an
	// explicitly supplied URL is trimmed (pasted whitespace must not persist;
	// url.Parse accepts spaces), SSRF-checked, and - for endpoint-routed
	// providers - required to be non-empty.
	if in.BaseURL != nil {
		trimmed := strings.TrimSpace(*in.BaseURL)
		in.BaseURL = &trimmed
		if trimmed != "" && !isSafeBaseURL(trimmed, s.allowLocal) {
			return nil, ErrBadRequest
		}
		if p := PresetFor(in.Provider); p != nil && p.NeedsBaseURL && trimmed == "" {
			return nil, ErrBaseURLRequired
		}
	}
	existing, err := s.getRow(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	providerChanged := existing != nil && existing.provider != in.Provider

	// A provider change may never silently carry or destroy the stored key:
	// it must arrive with the NEW provider's key (rejected here), and the old
	// key never survives onto a different vendor (a fresh one is written).
	// With no stored key there is nothing to protect, so the change is free.
	in.APIKey = strings.TrimSpace(in.APIKey)
	if providerChanged && in.APIKey == "" && existing.keyCipher != nil {
		return nil, ErrKeyRequiredForProviderChange
	}

	// Resolve the base URL under PATCH semantics: nil preserves the stored
	// URL, an empty string clears it (validated above), and a provider change
	// drops it (a stale URL must never follow the new provider). The preserved
	// value passed validation when it was stored, but the required-URL check
	// runs again on the RESOLVED value so an endpoint-routed provider can
	// never end up saved host-less (a 400 here beats an opaque 502 per call).
	resolvedBase := ""
	switch {
	case in.BaseURL != nil:
		resolvedBase = *in.BaseURL // already trimmed + validated above
	case providerChanged || existing == nil:
		resolvedBase = ""
	default:
		resolvedBase = deref(existing.baseURL)
	}
	if p := PresetFor(in.Provider); p != nil && p.NeedsBaseURL && resolvedBase == "" {
		return nil, ErrBaseURLRequired
	}

	model := nilIfEmpty(strings.TrimSpace(in.Model))
	imageModel := nilIfEmpty(strings.TrimSpace(in.ImageModel))
	baseURL := nilIfEmpty(resolvedBase)

	var cipher, iv, tag *string
	if in.APIKey != "" {
		nonce := make([]byte, 12)
		if _, err := rand.Read(nonce); err != nil {
			return nil, err
		}
		enc, err := secrets.EncryptAISecret(in.APIKey, s.secret, nonce)
		if err != nil {
			return nil, err
		}
		cipher, iv, tag = &enc.Cipher, &enc.IV, &enc.Tag
	}

	// Upsert. When a new key is supplied, write it; otherwise keep the stored
	// one (a keyless provider change was rejected above, so a stale key can
	// never survive onto a different provider).
	const q = `INSERT INTO "ai_configs" ("workspace_id",provider,model,"image_model","base_url","key_cipher","key_iv","key_tag","updated_at")
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
		ON CONFLICT ("workspace_id") DO UPDATE SET
			provider = EXCLUDED.provider,
			model = EXCLUDED.model,
			"image_model" = EXCLUDED."image_model",
			"base_url" = EXCLUDED."base_url",
			"key_cipher" = CASE WHEN $6 IS NOT NULL THEN $6 ELSE "ai_configs"."key_cipher" END,
			"key_iv"     = CASE WHEN $7 IS NOT NULL THEN $7 ELSE "ai_configs"."key_iv" END,
			"key_tag"    = CASE WHEN $8 IS NOT NULL THEN $8 ELSE "ai_configs"."key_tag" END,
			"updated_at" = now()`
	if _, err := s.db.Exec(ctx, q, workspaceID, in.Provider, model, imageModel, baseURL, cipher, iv, tag); err != nil {
		return nil, err
	}
	return s.GetConfig(ctx, workspaceID)
}

// callConfig resolves + decrypts the provider config for an outbound call.
func (s *Service) callConfig(ctx context.Context, workspaceID string) (CallConfig, error) {
	r, err := s.getRow(ctx, workspaceID)
	if err != nil {
		return CallConfig{}, err
	}
	if r == nil || r.keyCipher == nil || r.keyIV == nil || r.keyTag == nil {
		return CallConfig{}, ErrBadRequest
	}
	if r.baseURL != nil && !isSafeBaseURL(*r.baseURL, s.allowLocal) {
		return CallConfig{}, ErrBadRequest
	}
	key, err := secrets.DecryptAISecret(secrets.Encrypted{Cipher: *r.keyCipher, IV: *r.keyIV, Tag: *r.keyTag}, s.secret)
	if err != nil {
		return CallConfig{}, ErrBadRequest
	}
	// The registry is the single source of per-provider defaults: when the stored
	// base URL or model is empty, fall back to the provider's preset so a built-in
	// provider (e.g. DeepSeek) routes to its own endpoint/model instead of the
	// OpenAI-compatible defaults baked into the transport.
	baseURL, model, imageModel := deref(r.baseURL), deref(r.model), deref(r.imageModel)
	if p := PresetFor(r.provider); p != nil {
		if baseURL == "" {
			baseURL = p.BaseURL
		}
		if model == "" {
			model = p.DefaultModel
		}
		if imageModel == "" {
			imageModel = p.DefaultImageModel
		}
	}
	return CallConfig{
		Provider: Provider(r.provider), APIKey: key,
		BaseURL: baseURL, Model: model, ImageModel: imageModel,
	}, nil
}

// Text runs a text-generation call.
func (s *Service) Text(ctx context.Context, workspaceID, prompt, system string) (string, error) {
	cfg, err := s.callConfig(ctx, workspaceID)
	if err != nil {
		return "", err
	}
	if err := s.enforce(ctx, workspaceID, string(cfg.Provider), estimateTokens(prompt+system, 1024)); err != nil {
		return "", err
	}
	out, err := s.generateText(cfg, prompt, system)
	if err != nil {
		return "", ErrBadGateway
	}
	s.meter(ctx, workspaceID, countTokens(prompt)+countTokens(system)+countTokens(out))
	return out, nil
}

// TextStructured runs a text call constrained by a JSON Schema, natively where
// the provider supports it (response_format on the OpenAI-compatible dialect,
// a forced tool on Anthropic) with one automatic retry as plain text when the
// provider rejects the parameter. Callers keep the schema restated in the
// prompt and keep validating the reply: this primitive raises the odds of
// schema-valid output, it does not guarantee them.
func (s *Service) TextStructured(ctx context.Context, workspaceID, prompt, system, schemaJSON string) (string, error) {
	cfg, err := s.callConfig(ctx, workspaceID)
	if err != nil {
		return "", err
	}
	// Structured payloads carry a 4096-token output allowance (see the
	// Anthropic dialect), so the policy estimate uses the same figure.
	if err := s.enforce(ctx, workspaceID, string(cfg.Provider), estimateTokens(prompt+system, 4096)); err != nil {
		return "", err
	}
	out, err := s.generateStructuredText(cfg, prompt, system, schemaJSON)
	if err != nil {
		return "", ErrBadGateway
	}
	s.meter(ctx, workspaceID, countTokens(prompt)+countTokens(system)+countTokens(out))
	return out, nil
}

// assertImageCapable rejects image ops on Anthropic (no image endpoint), so an
// Anthropic key is never POSTed to api.openai.com.
// assertImageCapable rejects image generation on a provider the registry marks
// as text-only (anthropic, google, mistral, groq, openrouter), not just one.
func assertImageCapable(cfg CallConfig) error {
	if !ResolveRoute(string(cfg.Provider), cfg.Model, cfg.ImageModel, FeatureImage).Supported {
		return ErrImageUnsupported
	}
	return nil
}

// assertEditImageCapable gates on the EDIT capability specifically: a provider
// can generate but not edit (azure-openai's pinned api-version has no edits
// operation; zhipu's CogView has no OpenAI-style edit route), and gating on
// FeatureImage alone would let those calls through to an opaque 502.
func assertEditImageCapable(cfg CallConfig) error {
	if !ResolveRoute(string(cfg.Provider), cfg.Model, cfg.ImageModel, FeatureEditImage).Supported {
		return ErrEditImageUnsupported
	}
	return nil
}

// Image runs an image-generation call.
func (s *Service) Image(ctx context.Context, workspaceID, prompt, size string) (string, error) {
	cfg, err := s.callConfig(ctx, workspaceID)
	if err != nil {
		return "", err
	}
	if err := assertImageCapable(cfg); err != nil {
		return "", err
	}
	if err := s.enforce(ctx, workspaceID, string(cfg.Provider), countTokens(prompt)+imageTokenCost); err != nil {
		return "", err
	}
	out, err := s.generateImage(cfg, prompt, size)
	if err != nil {
		return "", ErrBadGateway
	}
	s.meter(ctx, workspaceID, countTokens(prompt)+imageTokenCost)
	return out, nil
}

var dataURLMime = regexp.MustCompile(`^data:([^;,]+)[;,]`)
var dataURLPrefix = regexp.MustCompile(`^data:[^,]*,`)

// DescribeImage generates alt text for an image (F22 FR-12). A data: prefix is
// stripped and its mime type reused.
func (s *Service) DescribeImage(ctx context.Context, workspaceID, imageBase64, instruction string) (string, error) {
	cfg, err := s.callConfig(ctx, workspaceID)
	if err != nil {
		return "", err
	}
	// Vision describe is unsupported on text-only providers (e.g. DeepSeek); fail
	// fast with a 400 instead of POSTing an image payload that will be rejected.
	if !ResolveRoute(string(cfg.Provider), cfg.Model, cfg.ImageModel, FeatureDescribeImage).Supported {
		return "", ErrBadRequest
	}
	mime := "image/png"
	if m := dataURLMime.FindStringSubmatch(imageBase64); m != nil {
		mime = m[1]
	}
	payload := dataURLPrefix.ReplaceAllString(imageBase64, "")
	instr := strings.TrimSpace(instruction)
	if instr == "" {
		instr = altTextInstruction
	}
	if err := s.enforce(ctx, workspaceID, string(cfg.Provider), imageTokenCost); err != nil {
		return "", err
	}
	out, err := s.describeImageCall(cfg, DescribeImageInput{ImageBase64: payload, MimeType: mime, Instruction: instr})
	if err != nil {
		return "", ErrBadGateway
	}
	s.meter(ctx, workspaceID, countTokens(instr)+countTokens(out))
	return out, nil
}

// EditImage edits/outpaints an image by prompt (+ optional mask).
func (s *Service) EditImage(ctx context.Context, workspaceID, imageBase64, prompt, maskBase64, size string) (string, error) {
	cfg, err := s.callConfig(ctx, workspaceID)
	if err != nil {
		return "", err
	}
	if err := assertEditImageCapable(cfg); err != nil {
		return "", err
	}
	if err := s.enforce(ctx, workspaceID, string(cfg.Provider), countTokens(prompt)+imageTokenCost); err != nil {
		return "", err
	}
	strip := func(b string) string { return dataURLPrefix.ReplaceAllString(b, "") }
	mask := ""
	if maskBase64 != "" {
		mask = strip(maskBase64)
	}
	out, err := s.editImageCall(cfg, EditImageInput{ImageBase64: strip(imageBase64), Prompt: prompt, MaskBase64: mask, Size: size})
	if err != nil {
		return "", ErrBadGateway
	}
	s.meter(ctx, workspaceID, countTokens(prompt)+imageTokenCost)
	return out, nil
}

func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
