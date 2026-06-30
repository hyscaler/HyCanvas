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

// ConfigInput is the set-config payload.
type ConfigInput struct {
	Provider   string
	Model      string
	ImageModel string
	BaseURL    string
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

var providerSet = map[string]bool{"openai": true, "anthropic": true, "deepseek": true, "custom": true}

// SetConfig upserts the workspace's provider config. A new apiKey is encrypted;
// changing the provider without a new key clears the stored key (so an old
// vendor's key is never sent to a different vendor).
func (s *Service) SetConfig(ctx context.Context, workspaceID string, in ConfigInput) (*ConfigView, error) {
	if !providerSet[in.Provider] {
		return nil, ErrBadRequest
	}
	if in.BaseURL != "" && !isSafeBaseURL(in.BaseURL, s.allowLocal) {
		return nil, ErrBadRequest
	}
	existing, err := s.getRow(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	model := nilIfEmpty(in.Model)
	imageModel := nilIfEmpty(in.ImageModel)
	baseURL := nilIfEmpty(in.BaseURL)

	var cipher, iv, tag *string
	clearKey := false
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
	} else if existing != nil && existing.provider != in.Provider {
		clearKey = true
	}

	// Upsert. When a new key is supplied, write it; when clearing, null it; when
	// neither, COALESCE keeps the existing key columns.
	const q = `INSERT INTO "ai_configs" ("workspace_id",provider,model,"image_model","base_url","key_cipher","key_iv","key_tag","updated_at")
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
		ON CONFLICT ("workspace_id") DO UPDATE SET
			provider = EXCLUDED.provider,
			model = EXCLUDED.model,
			"image_model" = EXCLUDED."image_model",
			"base_url" = EXCLUDED."base_url",
			"key_cipher" = CASE WHEN $9 THEN NULL WHEN $6 IS NOT NULL THEN $6 ELSE "ai_configs"."key_cipher" END,
			"key_iv"     = CASE WHEN $9 THEN NULL WHEN $7 IS NOT NULL THEN $7 ELSE "ai_configs"."key_iv" END,
			"key_tag"    = CASE WHEN $9 THEN NULL WHEN $8 IS NOT NULL THEN $8 ELSE "ai_configs"."key_tag" END,
			"updated_at" = now()`
	if _, err := s.db.Exec(ctx, q, workspaceID, in.Provider, model, imageModel, baseURL, cipher, iv, tag, clearKey); err != nil {
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
	baseURL, model := deref(r.baseURL), deref(r.model)
	if p := PresetFor(r.provider); p != nil {
		if baseURL == "" {
			baseURL = p.BaseURL
		}
		if model == "" {
			model = p.DefaultModel
		}
	}
	return CallConfig{
		Provider: Provider(r.provider), APIKey: key,
		BaseURL: baseURL, Model: model, ImageModel: deref(r.imageModel),
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

// assertImageCapable rejects image ops on Anthropic (no image endpoint), so an
// Anthropic key is never POSTed to api.openai.com.
// assertImageCapable rejects image generation on a provider the registry marks
// as text-only (anthropic, google, mistral, groq, openrouter), not just one.
func assertImageCapable(cfg CallConfig) error {
	if !ResolveRoute(string(cfg.Provider), cfg.Model, cfg.ImageModel, FeatureImage).Supported {
		return ErrBadRequest
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
	if err := assertImageCapable(cfg); err != nil {
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
