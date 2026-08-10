package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/ai"
)

// mountAI attaches the AI surface (doc 19), all JWT-guarded: config read needs
// viewer, config write needs admin, generation needs member. The provider key
// is set encrypted and never returned.
func mountAI(api chi.Router, svc *ai.Service, acct *accounts.Service) {
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
		r.Post("/ai/image", aiImageHandler(svc, acct))
		r.Post("/ai/describe-image", aiDescribeImageHandler(svc, acct))
		r.Post("/ai/image/edit", aiEditImageHandler(svc, acct))
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
	case errors.Is(err, ai.ErrBadRequest):
		problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid AI request or no provider configured", "ai_not_configured")
	case errors.Is(err, ai.ErrBadGateway):
		problemWithCode(w, r, http.StatusBadGateway, "Bad Gateway", "the AI provider request failed", "ai_provider_failed")
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
			Problem(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace")
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
			Problem(w, r, http.StatusForbidden, "Forbidden", "admin access required")
			return
		}
		var body struct {
			Provider   string `json:"provider"`
			Model      string `json:"model"`
			ImageModel string `json:"imageModel"`
			BaseURL    string `json:"baseUrl"`
			APIKey     string `json:"apiKey"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
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
			Problem(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace")
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
			Problem(w, r, http.StatusForbidden, "Forbidden", "admin access required")
			return
		}
		var body ai.OrgPolicy
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
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
			Problem(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace")
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
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		if !aiAssert(r, acct, body.WorkspaceID, "member") {
			Problem(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace")
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

func aiImageHandler(svc *ai.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			WorkspaceID string `json:"workspaceId"`
			Prompt      string `json:"prompt"`
			Size        string `json:"size"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		if !aiAssert(r, acct, body.WorkspaceID, "member") {
			Problem(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace")
			return
		}
		img, err := svc.Image(r.Context(), body.WorkspaceID, body.Prompt, body.Size)
		if err != nil {
			aiProblem(w, r, err)
			return
		}
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
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		if !aiAssert(r, acct, body.WorkspaceID, "member") {
			Problem(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace")
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

func aiEditImageHandler(svc *ai.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			WorkspaceID string `json:"workspaceId"`
			ImageBase64 string `json:"imageBase64"`
			Prompt      string `json:"prompt"`
			MaskBase64  string `json:"maskBase64"`
			Size        string `json:"size"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		if !aiAssert(r, acct, body.WorkspaceID, "member") {
			Problem(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace")
			return
		}
		img, err := svc.EditImage(r.Context(), body.WorkspaceID, body.ImageBase64, body.Prompt, body.MaskBase64, body.Size)
		if err != nil {
			aiProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"image": img})
	}
}
