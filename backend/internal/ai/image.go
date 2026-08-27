// A second, optional provider dedicated to image work.
//
// The catalog splits sharply: seven of the eleven presets cannot generate an
// image at all. Tying every capability to one row meant choosing Claude or Kimi
// for writing gave up generated imagery, and choosing OpenAI for imagery gave
// up the model you actually wanted writing your decks. Nobody should have to
// pick which half of the product to lose.
//
// The record is separate rather than more columns on "ai_configs" because it is
// a different vendor with a different key and host, and because separateness is
// what makes it safe: a workspace with no row here behaves exactly as it did
// before, since every image path falls back to the main provider.
//
// Storage, encryption and the write-boundary rules mirror the search provider
// config next door; usage metering and policy stay keyed by WORKSPACE, so the
// monthly cap counts both providers together and a provider blocked in Usage
// limits stays blocked whichever slot it occupies.

package ai

import (
	"context"
	"crypto/rand"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/auth/secrets"
)

// ImageConfigInput is the set payload. Provider "" clears the config, which
// returns the workspace to using its main provider for images.
type ImageConfigInput struct {
	Provider string
	Model    string
	BaseURL  *string
	APIKey   string
}

// ImageConfigView is the public config (never includes the key).
type ImageConfigView struct {
	Provider     string       `json:"provider"`
	Model        *string      `json:"model"`
	BaseURL      *string      `json:"baseUrl"`
	HasKey       bool         `json:"hasKey"`
	Capabilities Capabilities `json:"capabilities"`
}

type imageRow struct {
	provider  string
	model     *string
	baseURL   *string
	keyCipher *string
	keyIV     *string
	keyTag    *string
}

func (s *Service) getImageRow(ctx context.Context, workspaceID string) (*imageRow, error) {
	const q = `SELECT provider, model, "base_url", "key_cipher", "key_iv", "key_tag"
		FROM "ai_image_configs" WHERE "workspace_id" = $1`
	var r imageRow
	err := s.db.QueryRow(ctx, q, workspaceID).Scan(&r.provider, &r.model, &r.baseURL, &r.keyCipher, &r.keyIV, &r.keyTag)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// GetImageConfig returns the workspace's dedicated image provider, or nil when
// none is set (images then run on the main provider).
func (s *Service) GetImageConfig(ctx context.Context, workspaceID string) (*ImageConfigView, error) {
	r, err := s.getImageRow(ctx, workspaceID)
	if err != nil || r == nil {
		return nil, err
	}
	caps := Capabilities{Text: true, Image: true, DescribeImage: true, EditImage: true}
	if p := PresetFor(r.provider); p != nil {
		caps = p.Capabilities
	}
	return &ImageConfigView{
		Provider: r.provider, Model: r.model, BaseURL: r.baseURL,
		HasKey:       r.keyCipher != nil && *r.keyCipher != "",
		Capabilities: caps,
	}, nil
}

// SetImageConfig upserts (or clears, with provider "") the dedicated image
// provider. The rules match SetConfig, plus one of its own: the provider must
// actually be able to generate images. Accepting a text-only provider here
// would store a configuration whose only possible outcome is a failed call.
func (s *Service) SetImageConfig(ctx context.Context, workspaceID string, in ImageConfigInput) (*ImageConfigView, error) {
	if in.Provider == "" {
		const del = `DELETE FROM "ai_image_configs" WHERE "workspace_id" = $1`
		if _, err := s.db.Exec(ctx, del, workspaceID); err != nil {
			return nil, err
		}
		return nil, nil
	}
	if !providerSet[in.Provider] {
		return nil, ErrBadRequest
	}
	if !ResolveRoute(in.Provider, "", in.Model, FeatureImage).Supported {
		return nil, ErrImageUnsupported
	}
	if in.BaseURL != nil {
		trimmed := strings.TrimSpace(*in.BaseURL)
		in.BaseURL = &trimmed
		if trimmed != "" && !isSafeBaseURL(trimmed, s.allowLocal) {
			return nil, ErrBadRequest
		}
	}
	existing, err := s.getImageRow(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	providerChanged := existing != nil && existing.provider != in.Provider

	// A provider change may never silently carry the old vendor's key.
	in.APIKey = strings.TrimSpace(in.APIKey)
	if providerChanged && in.APIKey == "" && existing.keyCipher != nil {
		return nil, ErrKeyRequiredForProviderChange
	}
	// Unlike the search config there is no keyless image provider, so a first
	// save must bring one; there would otherwise be nothing to authenticate
	// with and every generation would 401.
	hasStoredKey := existing != nil && !providerChanged && existing.keyCipher != nil
	if in.APIKey == "" && !hasStoredKey {
		return nil, ErrBadRequest
	}

	// PATCH semantics for the base URL, as in SetConfig: nil preserves, "" clears,
	// and a provider change drops it so a stale host never follows a new vendor.
	resolvedBase := ""
	switch {
	case in.BaseURL != nil:
		resolvedBase = *in.BaseURL
	case providerChanged || existing == nil:
		resolvedBase = ""
	default:
		resolvedBase = deref(existing.baseURL)
	}
	if p := PresetFor(in.Provider); p != nil && p.NeedsBaseURL && resolvedBase == "" {
		return nil, ErrBaseURLRequired
	}

	model := nilIfEmpty(strings.TrimSpace(in.Model))
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
	const q = `INSERT INTO "ai_image_configs" ("workspace_id",provider,model,"base_url","key_cipher","key_iv","key_tag","updated_at")
		VALUES ($1,$2,$3,$4,$5,$6,$7,now())
		ON CONFLICT ("workspace_id") DO UPDATE SET
			provider = EXCLUDED.provider,
			model = EXCLUDED.model,
			"base_url" = EXCLUDED."base_url",
			"key_cipher" = CASE WHEN $5 IS NOT NULL THEN $5 ELSE "ai_image_configs"."key_cipher" END,
			"key_iv"     = CASE WHEN $6 IS NOT NULL THEN $6 ELSE "ai_image_configs"."key_iv" END,
			"key_tag"    = CASE WHEN $7 IS NOT NULL THEN $7 ELSE "ai_image_configs"."key_tag" END,
			"updated_at" = now()`
	if _, err := s.db.Exec(ctx, q, workspaceID, in.Provider, model, baseURL, cipher, iv, tag); err != nil {
		return nil, err
	}
	return s.GetImageConfig(ctx, workspaceID)
}

// DeleteImageConfig removes the dedicated image provider. Images fall back to
// the main provider, exactly as for a workspace that never set one.
func (s *Service) DeleteImageConfig(ctx context.Context, workspaceID string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM "ai_image_configs" WHERE "workspace_id" = $1`, workspaceID)
	return err
}

// imageCallConfig resolves the config for an outbound IMAGE call: the dedicated
// image provider when one is configured, otherwise the main provider.
//
// It deliberately does not require a main config to exist. A workspace may run
// images on one vendor and nothing else, and demanding a text provider it does
// not use would be a rule with no purpose.
func (s *Service) imageCallConfig(ctx context.Context, workspaceID string) (CallConfig, error) {
	r, err := s.getImageRow(ctx, workspaceID)
	if err != nil {
		return CallConfig{}, err
	}
	if r == nil || r.keyCipher == nil || r.keyIV == nil || r.keyTag == nil {
		return s.callConfig(ctx, workspaceID)
	}
	if r.baseURL != nil && !isSafeBaseURL(*r.baseURL, s.allowLocal) {
		return CallConfig{}, ErrBadRequest
	}
	key, err := secrets.DecryptAISecret(secrets.Encrypted{Cipher: *r.keyCipher, IV: *r.keyIV, Tag: *r.keyTag}, s.secret)
	if err != nil {
		return CallConfig{}, ErrBadRequest
	}
	// The registry supplies whatever the row leaves empty, as in callConfig.
	// Model fills BOTH slots: this provider exists to serve image calls, so its
	// model is the image model, and the transport reads ImageModel.
	baseURL, model := deref(r.baseURL), deref(r.model)
	if p := PresetFor(r.provider); p != nil {
		if baseURL == "" {
			baseURL = p.BaseURL
		}
		if model == "" {
			model = p.DefaultImageModel
		}
	}
	return CallConfig{
		Provider: Provider(r.provider), APIKey: key,
		BaseURL: baseURL, Model: model, ImageModel: model,
	}, nil
}

// visionCallConfig resolves the config for reading an image (alt text,
// describe). Vision is not image generation: it rides the chat model, so it
// belongs to whichever configured provider can actually do it.
//
// The main provider wins when it is vision-capable, because that is the model
// the workspace chose to think with. Only when it cannot see (DeepSeek,
// Mistral, Groq) does this fall to the image provider, which is what makes alt
// text work at all for those workspaces. When neither can see, the main config
// is returned so the caller reports the same unsupported error as before.
func (s *Service) visionCallConfig(ctx context.Context, workspaceID string) (CallConfig, error) {
	main, mainErr := s.callConfig(ctx, workspaceID)
	if mainErr == nil && ResolveRoute(string(main.Provider), main.Model, main.ImageModel, FeatureDescribeImage).Supported {
		return main, nil
	}
	alt, altErr := s.imageCallConfig(ctx, workspaceID)
	if altErr == nil && alt.Provider != main.Provider &&
		ResolveRoute(string(alt.Provider), alt.Model, alt.ImageModel, FeatureDescribeImage).Supported {
		return alt, nil
	}
	return main, mainErr
}
