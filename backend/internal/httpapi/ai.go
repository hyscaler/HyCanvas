package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/ai"
	"hycanvas/backend/internal/uploads"
)

// persistAIImage stores an AI-generated image as a workspace asset and returns a
// stable asset URL, so a provider's transient hosted URL (e.g. Zhipu CogView,
// which returns an expiring link) or a large inline data URL (OpenAI b64) never
// becomes the design's image source. On any failure it returns the value
// unchanged, so image generation still works even if persistence hiccups.
func persistAIImage(ctx context.Context, up *uploads.Service, userID, workspaceID, img string) string {
	if up == nil || img == "" {
		return img
	}
	var (
		asset uploads.UploadedAsset
		err   error
	)
	switch {
	case strings.HasPrefix(img, "data:"):
		parts := strings.SplitN(img, ",", 2)
		if len(parts) != 2 || parts[1] == "" {
			return img
		}
		asset, err = up.Upload(ctx, userID, workspaceID, "ai-image.png", parts[1], nil, "")
	case strings.HasPrefix(img, "http://"), strings.HasPrefix(img, "https://"):
		asset, err = up.ImportFromURL(ctx, userID, workspaceID, img, nil)
	default:
		return img
	}
	if err != nil || asset.URL == "" {
		return img
	}
	return asset.URL
}

// mountAI attaches the AI surface (doc 19), all JWT-guarded: config read needs
// viewer, config write needs admin, generation needs member. The provider key
// is set encrypted and never returned.
func mountAI(api chi.Router, svc *ai.Service, acct *accounts.Service, up *uploads.Service) {
	api.Group(func(r chi.Router) {
		r.Use(requireAuth(acct))
		// Provider registry (presets + capabilities) for the config UI. No secrets.
		r.Get("/ai/providers", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, ai.PRESETS)
		})
		r.Get("/workspaces/{id}/ai-config", aiGetConfigHandler(svc, acct))
		r.Put("/workspaces/{id}/ai-config", aiSetConfigHandler(svc, acct))
		r.Get("/workspaces/{id}/ai-policy", aiGetPolicyHandler(svc, acct))
		r.Put("/workspaces/{id}/ai-policy", aiSetPolicyHandler(svc, acct))
		r.Get("/workspaces/{id}/ai-usage", aiGetUsageHandler(svc, acct))
		r.Post("/ai/text", aiTextHandler(svc, acct))
		r.Post("/ai/text-structured", aiTextStructuredHandler(svc, acct))
		r.Post("/ai/image", aiImageHandler(svc, acct, up))
		r.Post("/ai/describe-image", aiDescribeImageHandler(svc, acct))
		r.Post("/ai/image/edit", aiEditImageHandler(svc, acct, up))
	})
}

func aiProblem(w http.ResponseWriter, r *http.Request, err error) {
	// Each branch carries a stable `code` so the frontend can translate the
	// failure (F38 FR-9); the English detail stays as the fallback wording.
	switch {
	case errors.Is(err, ai.ErrPolicyBlocked):
		problemWithCode(w, r, http.StatusForbidden, "Forbidden", err.Error(), "ai_policy_blocked")
	case errors.Is(err, ai.ErrImageUnsupported):
		problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "your AI provider does not support image generation; switch to an image-capable provider (e.g. OpenAI or Together AI) in AI settings", "ai_image_unsupported")
	case errors.Is(err, ai.ErrEditImageUnsupported):
		problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "your AI provider does not support image editing; switch to a provider with image editing (e.g. OpenAI) in AI settings", "ai_image_edit_unsupported")
	case errors.Is(err, ai.ErrBaseURLRequired):
		problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "this provider needs a base URL; enter your endpoint URL in AI settings", "ai_base_url_required")
	case errors.Is(err, ai.ErrKeyRequiredForProviderChange):
		problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "changing the provider requires the new provider's API key; enter it and save again", "ai_key_required_for_provider_change")
	case errors.Is(err, ai.ErrBadRequest):
		problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid AI request or no provider configured", "ai_not_configured")
	case errors.Is(err, ai.ErrBadGateway):
		// The upstream status (attached by the ai package, body never echoed)
		// separates the self-fixable failures: a rejected key, an exhausted
		// account, a mistyped model, a rate limit.
		var up *ai.UpstreamError
		status := 0
		if errors.As(err, &up) {
			status = up.Status
		}
		switch status {
		case http.StatusUnauthorized, http.StatusForbidden:
			problemWithCode(w, r, http.StatusBadGateway, "Bad Gateway", "the AI provider rejected the workspace API key; check the key in AI settings", "ai_provider_auth_failed")
		case http.StatusPaymentRequired:
			problemWithCode(w, r, http.StatusBadGateway, "Bad Gateway", "the AI provider account is out of credit; top up or switch providers in AI settings", "ai_provider_quota_exhausted")
		case http.StatusNotFound:
			problemWithCode(w, r, http.StatusBadGateway, "Bad Gateway", "the AI provider does not recognize the configured model or endpoint; check the model name and base URL in AI settings", "ai_provider_model_not_found")
		case http.StatusTooManyRequests:
			problemWithCode(w, r, http.StatusBadGateway, "Bad Gateway", "the AI provider rate-limited the request; wait a moment and try again", "ai_provider_rate_limited")
		default:
			problemWithCode(w, r, http.StatusBadGateway, "Bad Gateway", "the AI provider request failed", "ai_provider_failed")
		}
	default:
		problemWithCode(w, r, http.StatusInternalServerError, "Internal Server Error", "request failed", "ai_failed")
	}
}

// aiAssert resolves the workspace membership for an AI route.
func aiAssert(r *http.Request, acct *accounts.Service, workspaceID, minRole string) bool {
	u := userFrom(r.Context())
	return acct.AssertMember(r.Context(), u.ID, workspaceID, minRole) == nil
}

func aiGetConfigHandler(svc *ai.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		if !aiAssert(r, acct, id, "viewer") {
			problemWithCode(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace", "not_workspace_member")
			return
		}
		cfg, err := svc.GetConfig(r.Context(), id)
		if err != nil {
			aiProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, cfg) // null when none configured
	}
}

func aiSetConfigHandler(svc *ai.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		if !aiAssert(r, acct, id, "admin") {
			problemWithCode(w, r, http.StatusForbidden, "Forbidden", "admin access required", "admin_access_required")
			return
		}
		var body struct {
			Provider   string `json:"provider"`
			Model      string `json:"model"`
			ImageModel string `json:"imageModel"`
			// Pointer for PATCH semantics: absent preserves the stored URL,
			// an empty string clears it (see ai.ConfigInput).
			BaseURL *string `json:"baseUrl"`
			APIKey  string  `json:"apiKey"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		cfg, err := svc.SetConfig(r.Context(), id, ai.ConfigInput{
			Provider: body.Provider, Model: body.Model, ImageModel: body.ImageModel, BaseURL: body.BaseURL, APIKey: body.APIKey,
		})
		if err != nil {
			aiProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, cfg)
	}
}

func aiGetPolicyHandler(svc *ai.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		if !aiAssert(r, acct, id, "viewer") {
			problemWithCode(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace", "not_workspace_member")
			return
		}
		p, err := svc.GetPolicy(r.Context(), id)
		if err != nil {
			aiProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, p)
	}
}

func aiSetPolicyHandler(svc *ai.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		if !aiAssert(r, acct, id, "admin") {
			problemWithCode(w, r, http.StatusForbidden, "Forbidden", "admin access required", "admin_access_required")
			return
		}
		var body ai.OrgPolicy
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		if err := svc.SetPolicy(r.Context(), id, body); err != nil {
			aiProblem(w, r, err)
			return
		}
		p, err := svc.GetPolicy(r.Context(), id)
		if err != nil {
			aiProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, p)
	}
}

func aiGetUsageHandler(svc *ai.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		if !aiAssert(r, acct, id, "viewer") {
			problemWithCode(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace", "not_workspace_member")
			return
		}
		u, err := svc.GetUsage(r.Context(), id)
		if err != nil {
			aiProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, u)
	}
}

func aiTextHandler(svc *ai.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			WorkspaceID string `json:"workspaceId"`
			Prompt      string `json:"prompt"`
			System      string `json:"system"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		if !aiAssert(r, acct, body.WorkspaceID, "member") {
			problemWithCode(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace", "not_workspace_member")
			return
		}
		text, err := svc.Text(r.Context(), body.WorkspaceID, body.Prompt, body.System)
		if err != nil {
			aiProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"text": text})
	}
}

// aiTextStructuredHandler is the schema-constrained variant of /ai/text: the
// provider is asked for natively schema-valid output (with the proxy's plain
// fallback when a provider rejects the parameter). Same policy/metering path
// as Text; the schema shapes the reply, it grants nothing extra.
func aiTextStructuredHandler(svc *ai.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			WorkspaceID string          `json:"workspaceId"`
			Prompt      string          `json:"prompt"`
			System      string          `json:"system"`
			Schema      json.RawMessage `json:"schema"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		if !aiAssert(r, acct, body.WorkspaceID, "member") {
			problemWithCode(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace", "not_workspace_member")
			return
		}
		text, err := svc.TextStructured(r.Context(), body.WorkspaceID, body.Prompt, body.System, string(body.Schema))
		if err != nil {
			aiProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"text": text})
	}
}

func aiImageHandler(svc *ai.Service, acct *accounts.Service, up *uploads.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			WorkspaceID string `json:"workspaceId"`
			Prompt      string `json:"prompt"`
			Size        string `json:"size"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		if !aiAssert(r, acct, body.WorkspaceID, "member") {
			problemWithCode(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace", "not_workspace_member")
			return
		}
		img, err := svc.Image(r.Context(), body.WorkspaceID, body.Prompt, body.Size)
		if err != nil {
			aiProblem(w, r, err)
			return
		}
		img = persistAIImage(r.Context(), up, userFrom(r.Context()).ID, body.WorkspaceID, img)
		writeJSON(w, http.StatusOK, map[string]string{"image": img})
	}
}

func aiDescribeImageHandler(svc *ai.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			WorkspaceID string `json:"workspaceId"`
			ImageBase64 string `json:"imageBase64"`
			Instruction string `json:"instruction"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		if !aiAssert(r, acct, body.WorkspaceID, "member") {
			problemWithCode(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace", "not_workspace_member")
			return
		}
		text, err := svc.DescribeImage(r.Context(), body.WorkspaceID, body.ImageBase64, body.Instruction)
		if err != nil {
			aiProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"text": text})
	}
}

func aiEditImageHandler(svc *ai.Service, acct *accounts.Service, up *uploads.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			WorkspaceID string `json:"workspaceId"`
			ImageBase64 string `json:"imageBase64"`
			Prompt      string `json:"prompt"`
			MaskBase64  string `json:"maskBase64"`
			Size        string `json:"size"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		if !aiAssert(r, acct, body.WorkspaceID, "member") {
			problemWithCode(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace", "not_workspace_member")
			return
		}
		img, err := svc.EditImage(r.Context(), body.WorkspaceID, body.ImageBase64, body.Prompt, body.MaskBase64, body.Size)
		if err != nil {
			aiProblem(w, r, err)
			return
		}
		img = persistAIImage(r.Context(), up, userFrom(r.Context()).ID, body.WorkspaceID, img)
		writeJSON(w, http.StatusOK, map[string]string{"image": img})
	}
}
