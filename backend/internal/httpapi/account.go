package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accountdata"
	"hycanvas/backend/internal/accounts"
)

// mountAccount attaches the account data-portability surface (doc 15 FR-17):
// GET /api/v1/account/export (a JSON bundle of the user's own data) and
// DELETE /api/v1/account (re-authenticated, irreversible teardown). Both operate
// strictly on the authenticated user.
func mountAccount(api chi.Router, svc *accountdata.Service, acct *accounts.Service, secure bool) {
	api.With(requireAuth(acct)).Get("/account/export", func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		bundle, err := svc.Export(r.Context(), u.ID)
		if err != nil {
			problemWithCode(w, r, http.StatusInternalServerError, "Internal Server Error", "could not export account", "could_not_export_account")
			return
		}
		w.Header().Set("Content-Disposition", `attachment; filename="hycanvas-account.json"`)
		writeJSON(w, http.StatusOK, bundle)
	})

	api.With(requireAuth(acct)).Delete("/account", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Password string `json:"password"`
			Code     string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Password == "" {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "password is required", "password_is_required")
			return
		}
		u := userFrom(r.Context())
		if err := svc.Delete(r.Context(), u.ID, body.Password, body.Code); err != nil {
			if errors.Is(err, accounts.ErrReauth) {
				problemWithCode(w, r, http.StatusUnauthorized, "Unauthorized", "invalid password or authentication code", "invalid_password_or_authentication_code")
				return
			}
			problemWithCode(w, r, http.StatusInternalServerError, "Internal Server Error", "could not delete account", "could_not_delete_account")
			return
		}
		clearAuthCookies(w, secure)
		w.WriteHeader(http.StatusNoContent)
	})
}
