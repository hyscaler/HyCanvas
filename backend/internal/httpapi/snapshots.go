package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/brand"
	"hycanvas/backend/internal/persistence"
)

// mountSnapshots attaches the user-facing snapshot-save route (doc 04 + doc 18).
// It is the one persistence write that runs the brand-lock validateSnapshot gate
// (a non-manage-brand saver's out-of-kit colors/fonts are rejected when a lock
// is on), which is why it lives here with both services rather than in
// mountPersistence.
func mountSnapshots(api chi.Router, p *persistence.Service, br *brand.Service, acct *accounts.Service) {
	api.With(requireAuth(acct)).Post("/designs/{id}/snapshots", snapshotHandler(p, br, acct))
}

func snapshotHandler(p *persistence.Service, br *brand.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			File  persistence.DesignFile `json:"file"`
			Label string                 `json:"label"`
			Kind  string                 `json:"kind"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.File == nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "missing file")
			return
		}
		id := chi.URLParam(r, "id")
		ws, err := authorizeDesign(r, p, acct, id, "member")
		if err != nil {
			authProblem(w, r, err)
			return
		}
		u := userFrom(r.Context())
		// Brand-lock gate (doc 18 AC-3): reject out-of-kit values from a
		// non-manage-brand saver while a lock is on.
		if err := br.ValidateSnapshot(r.Context(), id, ws, u.ID, body.File); err != nil {
			if errors.Is(err, brand.ErrBrandLocked) {
				Problem(w, r, http.StatusBadRequest, "Bad Request", err.Error())
				return
			}
			Problem(w, r, http.StatusInternalServerError, "Internal Server Error", "brand validation failed")
			return
		}
		// The storage layer uppercases kinds into the Postgres enum, so accept
		// any casing here too; the allowlist below compares lowercase.
		kind := persistence.SnapshotKind(strings.ToLower(body.Kind))
		switch kind {
		case "":
			if body.Label != "" {
				kind = persistence.KindNamed
			} else {
				kind = persistence.KindCheckpoint
			}
		case persistence.KindAuto, persistence.KindCheckpoint, persistence.KindNamed, persistence.KindRestore:
			// user-savable kinds
		default:
			// KindBranch is minted by the branch endpoint only; anything else
			// would fail at the enum INSERT as a 500 after the blob was stored.
			Problem(w, r, http.StatusUnprocessableEntity, "Unprocessable Entity", "kind must be auto, checkpoint, named, or restore")
			return
		}
		var label *string
		if body.Label != "" {
			label = &body.Label
		}
		rec, err := p.Snapshot(r.Context(), id, ws, body.File, kind, label, &u.ID)
		if err != nil {
			persistenceProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, rec)
	}
}
