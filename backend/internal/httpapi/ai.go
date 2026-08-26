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

// aiFailure classifies an AI error into the HTTP status, title, human-readable
// detail and stable code the frontend translates.
//
// Shared by the problem+json path and the SSE path on purpose: those two
// diverged once, with the stream hardcoding "ai_provider_failed" for every
// cause, which made a rejected key, an exhausted account, an unknown model and
// a rate limit indistinguishable on the MAIN design-generation flow. One
// classifier means a streamed failure can never say less than a request-scoped
// one.
func aiFailure(err error) (status int, title, detail, code string) {
	switch {
	case errors.Is(err, ai.ErrPolicyBlocked):
		return http.StatusForbidden, "Forbidden", err.Error(), "ai_policy_blocked"
	case errors.Is(err, ai.ErrImageUnsupported):
		return http.StatusBadRequest, "Bad Request", "your AI provider does not support image generation; switch to an image-capable provider (e.g. OpenAI or Together AI) in AI settings", "ai_image_unsupported"
	case errors.Is(err, ai.ErrEditImageUnsupported):
		return http.StatusBadRequest, "Bad Request", "your AI provider does not support image editing; switch to a provider with image editing (e.g. OpenAI) in AI settings", "ai_image_edit_unsupported"
	case errors.Is(err, ai.ErrBaseURLRequired):
		return http.StatusBadRequest, "Bad Request", "this provider needs a base URL; enter your endpoint URL in AI settings", "ai_base_url_required"
	case errors.Is(err, ai.ErrKeyRequiredForProviderChange):
		return http.StatusBadRequest, "Bad Request", "changing the provider requires the new provider's API key; enter it and save again", "ai_key_required_for_provider_change"
	case errors.Is(err, ai.ErrBadRequest):
		return http.StatusBadRequest, "Bad Request", "invalid AI request or no provider configured", "ai_not_configured"
	case errors.Is(err, ai.ErrBadGateway):
		// The upstream status (attached by the ai package, body never echoed)
		// separates the self-fixable failures: a rejected key, an exhausted
		// account, a mistyped model, a rate limit.
		var up *ai.UpstreamError
		upstream := 0
		if errors.As(err, &up) {
			upstream = up.Status
		}
		switch upstream {
		case http.StatusUnauthorized, http.StatusForbidden:
			return http.StatusBadGateway, "Bad Gateway", "the AI provider rejected the workspace API key; check the key in AI settings", "ai_provider_auth_failed"
		case http.StatusPaymentRequired:
			return http.StatusBadGateway, "Bad Gateway", "the AI provider account is out of credit; top up or switch providers in AI settings", "ai_provider_quota_exhausted"
		case http.StatusNotFound:
			return http.StatusBadGateway, "Bad Gateway", "the AI provider does not recognize the configured model or endpoint; check the model name and base URL in AI settings", "ai_provider_model_not_found"
		case http.StatusTooManyRequests:
			return http.StatusBadGateway, "Bad Gateway", "the AI provider rate-limited the request; wait a moment and try again", "ai_provider_rate_limited"
		}
		return http.StatusBadGateway, "Bad Gateway", "the AI provider request failed", "ai_provider_failed"
	}
	return http.StatusInternalServerError, "Internal Server Error", "request failed", "ai_failed"
}

// aiProblem writes the classification as problem+json. The codes are repeated
// as LITERALS here on purpose: they must stay greppable and enumerable for
// translation (problem_code_test.go rejects a computed code), while aiFailure
// above stays the single place that decides WHICH one applies.
func aiProblem(w http.ResponseWriter, r *http.Request, err error) {
	status, title, detail, code := aiFailure(err)
	switch code {
	case "ai_policy_blocked":
		problemWithCode(w, r, status, title, detail, "ai_policy_blocked")
	case "ai_image_unsupported":
		problemWithCode(w, r, status, title, detail, "ai_image_unsupported")
	case "ai_image_edit_unsupported":
		problemWithCode(w, r, status, title, detail, "ai_image_edit_unsupported")
	case "ai_base_url_required":
		problemWithCode(w, r, status, title, detail, "ai_base_url_required")
	case "ai_key_required_for_provider_change":
		problemWithCode(w, r, status, title, detail, "ai_key_required_for_provider_change")
	case "ai_not_configured":
		problemWithCode(w, r, status, title, detail, "ai_not_configured")
	case "ai_provider_auth_failed":
		problemWithCode(w, r, status, title, detail, "ai_provider_auth_failed")
	case "ai_provider_quota_exhausted":
		problemWithCode(w, r, status, title, detail, "ai_provider_quota_exhausted")
	case "ai_provider_model_not_found":
		problemWithCode(w, r, status, title, detail, "ai_provider_model_not_found")
	case "ai_provider_rate_limited":
		problemWithCode(w, r, status, title, detail, "ai_provider_rate_limited")
	case "ai_provider_failed":
		problemWithCode(w, r, status, title, detail, "ai_provider_failed")
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
