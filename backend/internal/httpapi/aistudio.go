package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/ai"
	"hycanvas/backend/internal/aistudio"
	"hycanvas/backend/internal/jobs"
	"hycanvas/backend/internal/persistence"
)

// mountAIStudio wires the F39 AI Creative Studio orchestration endpoints. All
// model calls go through the AI proxy (routing/BYO/policy/metering); these
// handlers add schema validation + retry and session/provenance persistence.
func mountAIStudio(api chi.Router, svc *aistudio.Service, acct *accounts.Service, p *persistence.Service, reg *jobs.Registry) {
	api.Group(func(r chi.Router) {
		r.Use(requireAuth(acct))

		r.Post("/ai/outline", aiStudioOutlineHandler(svc, acct))
		r.Post("/ai/chart", aiStudioChartHandler(svc, acct))
		r.Post("/ai/assistant", aiStudioAssistantHandler(svc, acct))
		r.Post("/ai/style-profile", aiStudioStyleHandler(svc, acct))
		r.Post("/ai/critique", aiStudioCritiqueHandler(svc, acct))
		r.Post("/ai/generate-design", aiStudioGenerateHandler(svc, acct, reg))
		r.Post("/ai/variations", aiStudioVariationsHandler(svc, acct, reg))
		r.Post("/ai/design-svg", aiStudioSvgHandler(svc, acct))

		// Session history (design-scoped; FR-9 / FR-27).
		r.Get("/designs/{id}/ai-sessions", aiSessionsListHandler(svc, acct, p))
		r.Post("/designs/{id}/ai-sessions", aiSessionsCreateHandler(svc, acct, p))
		r.Get("/designs/{id}/ai-sessions/{sid}/turns", aiTurnsListHandler(svc, acct, p))
		r.Post("/designs/{id}/ai-sessions/{sid}/turns", aiTurnsCreateHandler(svc, acct, p))
	})
}

// aiStudioProblem maps orchestrator errors to problem+json, reusing the AI proxy
// mapping for provider/policy errors.
func aiStudioProblem(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, aistudio.ErrInvalidOutput) {
		Problem(w, r, http.StatusBadGateway, "AI output invalid", "the model did not return a valid result; try again")
		return
	}
	if errors.Is(err, ai.ErrPolicyBlocked) || errors.Is(err, ai.ErrBadRequest) || errors.Is(err, ai.ErrBadGateway) {
		aiProblem(w, r, err)
		return
	}
	Problem(w, r, http.StatusInternalServerError, "Internal Server Error", "generation failed")
}

// jobFailMessage gives a job's failure a specific, user-meaningful reason instead
// of a generic string, so the polled job result distinguishes policy/provider/
// invalid-output failures (mirrors aiStudioProblem's classification).
func jobFailMessage(err error) string {
	switch {
	case errors.Is(err, ai.ErrPolicyBlocked):
		return "blocked by your organization's AI policy"
	case errors.Is(err, aistudio.ErrInvalidOutput):
		return "the model did not return a valid result"
	case errors.Is(err, ai.ErrBadGateway):
		return "the AI provider returned an error"
	case errors.Is(err, ai.ErrBadRequest):
		return "the AI request was rejected"
	default:
		return "generation failed"
	}
}

func aiStudioOutlineHandler(svc *aistudio.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			WorkspaceID string `json:"workspaceId"`
			DesignType  string `json:"designType"`
			Prompt      string `json:"prompt"`
			BrandClause string `json:"brandClause"`
			PageCount   int    `json:"pageCount"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		if !aiAssert(r, acct, body.WorkspaceID, "member") {
			Problem(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace")
			return
		}
		out, err := svc.Outline(r.Context(), body.WorkspaceID, body.DesignType, body.Prompt, body.BrandClause, body.PageCount)
		if err != nil {
			aiStudioProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// aiStudioSvgHandler generates one stylish, editable SVG design at the requested
// artboard size. The client converts it to scene-graph nodes and creates a
// design; unlike an AI image, the result is fully editable.
func aiStudioSvgHandler(svc *aistudio.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			WorkspaceID string `json:"workspaceId"`
			DesignType  string `json:"designType"`
			Prompt      string `json:"prompt"`
			Width       int    `json:"width"`
			Height      int    `json:"height"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		if !aiAssert(r, acct, body.WorkspaceID, "member") {
			Problem(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace")
			return
		}
		design, err := svc.GenerateSvg(r.Context(), body.WorkspaceID, body.Prompt, body.DesignType, body.Width, body.Height)
		if err != nil {
			aiStudioProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, design)
	}
}

func aiStudioChartHandler(svc *aistudio.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			WorkspaceID string `json:"workspaceId"`
			Description string `json:"description"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		if !aiAssert(r, acct, body.WorkspaceID, "member") {
			Problem(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace")
			return
		}
		spec, err := svc.Chart(r.Context(), body.WorkspaceID, body.Description)
		if err != nil {
			aiStudioProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, spec)
	}
}

func aiStudioAssistantHandler(svc *aistudio.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			WorkspaceID   string `json:"workspaceId"`
			DesignSummary string `json:"designSummary"`
			History       string `json:"history"`
			Message       string `json:"message"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		if !aiAssert(r, acct, body.WorkspaceID, "member") {
			Problem(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace")
			return
		}
		reply, err := svc.Assistant(r.Context(), body.WorkspaceID, body.DesignSummary, body.History, body.Message)
		if err != nil {
			aiStudioProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, reply)
	}
}

func aiStudioStyleHandler(svc *aistudio.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			WorkspaceID   string   `json:"workspaceId"`
			ReferenceText string   `json:"referenceText"`
			SeedPalette   []string `json:"seedPalette"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		if !aiAssert(r, acct, body.WorkspaceID, "member") {
			Problem(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace")
			return
		}
		profile, err := svc.StyleProfile(r.Context(), body.WorkspaceID, body.ReferenceText, body.SeedPalette)
		if err != nil {
			aiStudioProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, profile)
	}
}

func aiStudioCritiqueHandler(svc *aistudio.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			WorkspaceID   string `json:"workspaceId"`
			DesignSummary string `json:"designSummary"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		if !aiAssert(r, acct, body.WorkspaceID, "member") {
			Problem(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace")
			return
		}
		text, err := svc.Critique(r.Context(), body.WorkspaceID, body.DesignSummary)
		if err != nil {
			aiStudioProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"suggestions": text})
	}
}

// aiStudioGenerateHandler runs the multi-call generation pipeline and records it
// as a job so the client can poll the result (FR-25).
func aiStudioGenerateHandler(svc *aistudio.Service, acct *accounts.Service, reg *jobs.Registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			WorkspaceID string `json:"workspaceId"`
			DesignType  string `json:"designType"`
			Prompt      string `json:"prompt"`
			BrandClause string `json:"brandClause"`
			PageCount   int    `json:"pageCount"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		if !aiAssert(r, acct, body.WorkspaceID, "member") {
			Problem(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace")
			return
		}
		u := userFrom(r.Context())
		job := reg.Start(u.ID, "ai-generate-design")
		outline, err := svc.GenerateDesign(r.Context(), body.WorkspaceID, body.DesignType, body.Prompt, body.BrandClause, body.PageCount)
		if err != nil {
			reg.Fail(job.ID, jobFailMessage(err))
		} else {
			reg.Complete(job.ID, outline, nil)
		}
		writeJSON(w, http.StatusOK, map[string]any{"jobId": job.ID})
	}
}

func aiStudioVariationsHandler(svc *aistudio.Service, acct *accounts.Service, reg *jobs.Registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			WorkspaceID string `json:"workspaceId"`
			DesignType  string `json:"designType"`
			Prompt      string `json:"prompt"`
			BrandClause string `json:"brandClause"`
			Count       int    `json:"count"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		if !aiAssert(r, acct, body.WorkspaceID, "member") {
			Problem(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace")
			return
		}
		u := userFrom(r.Context())
		job := reg.Start(u.ID, "ai-variations")
		variations, err := svc.Variations(r.Context(), body.WorkspaceID, body.DesignType, body.Prompt, body.BrandClause, body.Count)
		if err != nil {
			reg.Fail(job.ID, jobFailMessage(err))
		} else {
			reg.Complete(job.ID, map[string]any{"variations": variations}, nil)
		}
		writeJSON(w, http.StatusOK, map[string]any{"jobId": job.ID})
	}
}

// --- Sessions (design-scoped) ---------------------------------------------

func aiSessionsListHandler(svc *aistudio.Service, acct *accounts.Service, p *persistence.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		designID := chi.URLParam(r, "id")
		ws, err := authorizeDesign(r, p, acct, designID, "viewer")
		if err != nil {
			Problem(w, r, http.StatusForbidden, "Forbidden", "not permitted")
			return
		}
		list, err := svc.ListSessions(r.Context(), ws, designID)
		if err != nil {
			Problem(w, r, http.StatusInternalServerError, "Internal Server Error", "could not list sessions")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"sessions": list})
	}
}

func aiSessionsCreateHandler(svc *aistudio.Service, acct *accounts.Service, p *persistence.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		designID := chi.URLParam(r, "id")
		ws, err := authorizeDesign(r, p, acct, designID, "member")
		if err != nil {
			Problem(w, r, http.StatusForbidden, "Forbidden", "not permitted")
			return
		}
		sess, err := svc.CreateSession(r.Context(), ws, designID)
		if err != nil {
			Problem(w, r, http.StatusInternalServerError, "Internal Server Error", "could not create session")
			return
		}
		writeJSON(w, http.StatusOK, sess)
	}
}

func aiTurnsListHandler(svc *aistudio.Service, acct *accounts.Service, p *persistence.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		designID := chi.URLParam(r, "id")
		ws, err := authorizeDesign(r, p, acct, designID, "viewer")
		if err != nil {
			Problem(w, r, http.StatusForbidden, "Forbidden", "not permitted")
			return
		}
		turns, err := svc.ListTurns(r.Context(), ws, designID, chi.URLParam(r, "sid"))
		if err != nil {
			Problem(w, r, http.StatusNotFound, "Not Found", "session not found")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"turns": turns})
	}
}

func aiTurnsCreateHandler(svc *aistudio.Service, acct *accounts.Service, p *persistence.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		designID := chi.URLParam(r, "id")
		ws, err := authorizeDesign(r, p, acct, designID, "member")
		if err != nil {
			Problem(w, r, http.StatusForbidden, "Forbidden", "not permitted")
			return
		}
		var body struct {
			Role       string          `json:"role"`
			Text       string          `json:"text"`
			Plan       json.RawMessage `json:"plan"`
			Provenance json.RawMessage `json:"provenance"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		if body.Role != "user" && body.Role != "assistant" {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "role must be user or assistant")
			return
		}
		turn, err := svc.AppendTurn(r.Context(), ws, designID, aistudio.AiTurn{
			SessionID:  chi.URLParam(r, "sid"),
			Role:       body.Role,
			Text:       body.Text,
			Plan:       body.Plan,
			Provenance: body.Provenance,
		})
		if err != nil {
			Problem(w, r, http.StatusNotFound, "Not Found", "session not found")
			return
		}
		writeJSON(w, http.StatusOK, turn)
	}
}
