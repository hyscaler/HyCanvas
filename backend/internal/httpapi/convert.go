package httpapi

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/convert"
	"hycanvas/backend/internal/jobs"
)

// mountConvert attaches POST /designs/:id/convert/whiteboard-to-deck. The work
// runs inline; the result (the new design id) is recorded on a job the client
// polls via GET /jobs/:id, matching the unchanged async contract.
func mountConvert(api chi.Router, svc *convert.Service, reg *jobs.Registry, acct *accounts.Service) {
	api.With(requireAuth(acct)).Post("/designs/{id}/convert/whiteboard-to-deck", func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		res, err := svc.WhiteboardToDeck(r.Context(), u.ID, chi.URLParam(r, "id"))
		if errors.Is(err, accounts.ErrForbidden) {
			Problem(w, r, http.StatusForbidden, "Forbidden", "not permitted")
			return
		}
		job := reg.Start(u.ID, "whiteboard-to-deck")
		if err != nil {
			reg.Fail(job.ID, "conversion failed")
		} else {
			reg.Complete(job.ID, res, nil)
		}
		writeJSON(w, http.StatusOK, map[string]any{"jobId": job.ID})
	})
}
