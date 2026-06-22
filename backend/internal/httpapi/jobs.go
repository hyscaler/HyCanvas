package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/jobs"
)

// mountJobs attaches GET /api/v1/jobs/:id, the owner-scoped job status poll used
// by the export/convert/bulk flows.
func mountJobs(api chi.Router, reg *jobs.Registry, acct *accounts.Service) {
	api.With(requireAuth(acct)).Get("/jobs/{id}", func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		job, ok := reg.Get(u.ID, chi.URLParam(r, "id"))
		if !ok {
			Problem(w, r, http.StatusNotFound, "Not Found", "job not found")
			return
		}
		writeJSON(w, http.StatusOK, job.View())
	})
}
