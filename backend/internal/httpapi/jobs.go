package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/jobs"
)

// apiKeyPollableJobs is the job-name allowlist for API-KEY callers (F40): the
// jobs the key-authed surface can itself start. A key authenticates as its
// minting user, but that user's browser-session jobs in OTHER workspaces
// (ai-generate-design, ai-variations, whiteboard-to-deck, video-export) carry
// workspace content in their results, and the key's workspace pinning must
// hold on the jobs route too.
var apiKeyPollableJobs = map[string]bool{
	"generate-presentation": true,
	"doc-export":            true,
}

// mountJobs attaches GET /api/v1/jobs/:id, the owner-scoped job status poll used
// by the export/convert/bulk flows.
func mountJobs(api chi.Router, reg *jobs.Registry, acct *accounts.Service) {
	api.With(requireAuth(acct)).Get("/jobs/{id}", func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		job, ok := reg.Get(u.ID, chi.URLParam(r, "id"))
		if !ok {
			problemWithCode(w, r, http.StatusNotFound, "Not Found", "job not found", "job_not_found")
			return
		}
		if apiKeyFrom(r.Context()) != nil && !apiKeyPollableJobs[job.Name] {
			// Same problem as missing: not an existence oracle for session jobs.
			problemWithCode(w, r, http.StatusNotFound, "Not Found", "job not found", "job_not_found")
			return
		}
		writeJSON(w, http.StatusOK, job.View())
	})
}
