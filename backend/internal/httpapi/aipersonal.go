package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/ai"
)

// The personal AI provider (#47): a user's own bring-your-own-key provider,
// set in user settings and used in any workspace that has no provider of its
// own and allows personal keys. The routes mirror the workspace ones and run
// through the same validation, encryption and connection test; they read and
// write only the signed-in user's records, so no one else can see the key.
func mountPersonalAI(r chi.Router, svc *ai.Service) {
	r.Get("/me/ai-config", meGetAIConfigHandler(svc))
	r.Put("/me/ai-config", meSetAIConfigHandler(svc))
	r.Delete("/me/ai-config", meDeleteAIConfigHandler(svc))
	r.Post("/me/ai-config/test", meTestAIConfigHandler(svc))
	r.Post("/me/ai-config/models", meListAIModelsHandler(svc))
	r.Get("/me/ai-image-config", meGetAIImageConfigHandler(svc))
	r.Put("/me/ai-image-config", meSetAIImageConfigHandler(svc))
	r.Delete("/me/ai-image-config", meDeleteAIImageConfigHandler(svc))
	r.Post("/me/ai-image-config/test", meTestAIImageConfigHandler(svc))
	r.Post("/me/ai-image-config/models", meListAIImageModelsHandler(svc))
	r.Get("/me/ai-usage", meGetAIUsageHandler(svc))
}

func meGetAIConfigHandler(svc *ai.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cfg, err := svc.GetUserConfig(r.Context(), userFrom(r.Context()).ID)
		if err != nil {
			aiProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, cfg) // null when none configured
	}
}

func meSetAIConfigHandler(svc *ai.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body aiConfigBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		cfg, err := svc.SetUserConfig(r.Context(), userFrom(r.Context()).ID, body.input())
		if err != nil {
			aiProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, cfg)
	}
}

// meDeleteAIConfigHandler removes the personal provider and its key outright.
// The personal image provider goes with it from the settings form, which
// deletes both, as the workspace form does.
func meDeleteAIConfigHandler(svc *ai.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := svc.DeleteUserConfig(r.Context(), userFrom(r.Context()).ID); err != nil {
			aiProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// meTestAIConfigHandler tests a candidate (with a body) or the stored personal
// config (without one), exactly like the workspace test.
func meTestAIConfigHandler(svc *ai.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body aiConfigBody
		present, err := decodeCandidate(r, &body)
		if err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		var in *ai.ConfigInput
		if present && body.Provider != "" {
			v := body.input()
			in = &v
		}
		if err := svc.TestUserConfig(r.Context(), userFrom(r.Context()).ID, in); err != nil {
			aiProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func meListAIModelsHandler(svc *ai.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body aiModelsBody
		present, err := decodeCandidate(r, &body)
		if err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		purpose := strings.ToLower(strings.TrimSpace(body.Purpose))
		if purpose != "" && purpose != ai.PurposeText && purpose != ai.PurposeImage {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		uid := userFrom(r.Context()).ID
		var list ai.ModelList
		if present && body.Provider != "" {
			list, err = svc.ListUserModels(r.Context(), uid, body.input(), purpose)
		} else {
			list, err = svc.ListUserStoredModels(r.Context(), uid, purpose)
		}
		if err != nil {
			aiProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

func meGetAIImageConfigHandler(svc *ai.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cfg, err := svc.GetUserImageConfig(r.Context(), userFrom(r.Context()).ID)
		if err != nil {
			aiProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, cfg)
	}
}

func meSetAIImageConfigHandler(svc *ai.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body aiImageConfigBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		cfg, err := svc.SetUserImageConfig(r.Context(), userFrom(r.Context()).ID, body.input())
		if err != nil {
			imageConfigProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, cfg)
	}
}

func meDeleteAIImageConfigHandler(svc *ai.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := svc.DeleteUserImageConfig(r.Context(), userFrom(r.Context()).ID); err != nil {
			aiProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func meTestAIImageConfigHandler(svc *ai.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body aiImageConfigBody
		present, err := decodeCandidate(r, &body)
		if err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		uid := userFrom(r.Context()).ID
		var check ai.ImageCheck
		if present && body.Provider != "" {
			check, err = svc.VerifyUserImageCandidate(r.Context(), uid, body.input())
		} else {
			check, err = svc.VerifyUserImageConfig(r.Context(), uid)
		}
		if err != nil {
			imageConfigProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, check)
	}
}

func meListAIImageModelsHandler(svc *ai.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body aiImageConfigBody
		present, err := decodeCandidate(r, &body)
		if err != nil || !present || body.Provider == "" {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		list, err := svc.ListUserImageModels(r.Context(), userFrom(r.Context()).ID, body.input())
		if err != nil {
			imageConfigProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

func meGetAIUsageHandler(svc *ai.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, err := svc.GetUserUsage(r.Context(), userFrom(r.Context()).ID)
		if err != nil {
			aiProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, u)
	}
}

// aiEffectiveHandler says which provider serves the caller in the workspace:
// its own ("workspace"), the caller's personal one ("personal"), or none. Any
// member may ask; the personal configs in the answer are the caller's own.
func aiEffectiveHandler(svc *ai.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		if !aiAssert(r, acct, id, "viewer") {
			problemWithCode(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace", "not_workspace_member")
			return
		}
		v, err := svc.Effective(r.Context(), id)
		if err != nil {
			aiProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, v)
	}
}
