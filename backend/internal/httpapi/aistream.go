// POST /ai/generate-design/stream (F28 T18): the SSE variant of design
// generation. Long AI work normally runs through the job registry, but a
// generation the user is watching benefits from per-stage progress, so SSE is
// the sanctioned exception here: events `outline` (the validated outline, as
// soon as it exists), `page` ({index, points} per finished polish), `done`
// (the final outline), and `error`. The request context propagates into every
// model call, so a client disconnect cancels the run.

package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/aistudio"
)

func mountAIStream(api chi.Router, svc *aistudio.Service, acct *accounts.Service) {
	api.With(requireAuth(acct)).Post("/ai/generate-design/stream", aiStudioGenerateStreamHandler(svc, acct))
}

func aiStudioGenerateStreamHandler(svc *aistudio.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			WorkspaceID string `json:"workspaceId"`
			DesignType  string `json:"designType"`
			Prompt      string `json:"prompt"`
			BrandClause string `json:"brandClause"`
			PageCount   int    `json:"pageCount"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		if !aiAssert(r, acct, body.WorkspaceID, "member") {
			problemWithCode(w, r, http.StatusForbidden, "Forbidden", "not a member of this workspace", "not_workspace_member")
			return
		}
		flusher, ok := w.(http.Flusher)
		if !ok {
			problemWithCode(w, r, http.StatusInternalServerError, "Internal Server Error", "request failed", "ai_failed")
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Accel-Buffering", "no") // reverse proxies must not buffer

		// Serialize writes: the polish goroutines emit concurrently. A write
		// error (client gone) is remembered and later emits become no-ops; the
		// canceled request context winds the model calls down.
		var mu sync.Mutex
		dead := false
		emit := func(event string, data any) {
			mu.Lock()
			defer mu.Unlock()
			if dead {
				return
			}
			payload, err := json.Marshal(data)
			if err != nil {
				return
			}
			if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, payload); err != nil {
				dead = true
				return
			}
			flusher.Flush()
		}

		outline, err := svc.GenerateDesignStream(r.Context(), body.WorkspaceID, body.DesignType, body.Prompt, body.BrandClause, body.PageCount, emit)
		if err != nil {
			// The stream is already 200; the error travels as an event with a
			// stable code (the client maps it like a problem+json code).
			emit("error", map[string]string{"code": "ai_provider_failed", "message": "the AI provider request failed"})
			return
		}
		emit("done", outline)
	}
}
