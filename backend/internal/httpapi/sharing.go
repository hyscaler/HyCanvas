package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/sharing"
)

// mountSharing attaches the sharing + permissions surface (doc 17 slice A).
// Auth-guarded routes delegate capability checks to the service (share /
// manage-roles). The public link-resolve route is unguarded: an external
// recipient resolves a view/comment link without an account, while a signed-in
// visitor (read opportunistically from the access cookie) gets a recorded grant.
func mountSharing(api chi.Router, sh *sharing.Service, acct *accounts.Service) {
	api.Group(func(r chi.Router) {
		r.Use(requireAuth(acct))
		r.Get("/designs/{id}/access", sharingAccessHandler(sh))
		r.Get("/designs/{id}/sharing", sharingViewHandler(sh))
		r.Post("/designs/{id}/grants", addGrantHandler(sh))
		r.Patch("/grants/{gid}", updateGrantHandler(sh))
		r.Delete("/grants/{gid}", removeGrantHandler(sh))
		r.Post("/designs/{id}/links", createLinkHandler(sh))
		r.Patch("/links/{lid}", updateLinkHandler(sh))
		r.Delete("/links/{lid}", deleteLinkHandler(sh))
		r.Post("/links/{lid}/rotate", rotateLinkHandler(sh))
		r.Get("/workspaces/{wid}/roles", listRolesHandler(sh))
		r.Post("/workspaces/{wid}/roles", createRoleHandler(sh))
		r.Patch("/roles/{rid}", updateRoleHandler(sh))
		r.Delete("/roles/{rid}", deleteRoleHandler(sh))
		r.Post("/designs/{id}/role-assignments", assignRoleHandler(sh))
		// Request access: any signed-in user may ask; listing/adjudicating is
		// capability-gated inside the service.
		r.Post("/designs/{id}/access-requests", requestAccessHandler(sh))
		r.Get("/designs/{id}/access-requests", listAccessRequestsHandler(sh))
		r.Post("/access-requests/{rid}/approve", resolveAccessRequestHandler(sh, true))
		r.Post("/access-requests/{rid}/deny", resolveAccessRequestHandler(sh, false))
	})
	// Public (no auth guard): resolve a share link by token (FR-6, FR-15).
	api.Post("/links/{token}/resolve", resolveLinkHandler(sh, acct))
	api.Post("/links/{token}/file", resolveLinkFileHandler(sh, acct))
}

// sharingProblem maps a service error to an RFC 7807 response.
func sharingProblem(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, sharing.ErrForbidden):
		problemWithCode(w, r, http.StatusForbidden, "Forbidden", "you do not have permission for this action", "forbidden_action")
	case errors.Is(err, sharing.ErrNotFound):
		problemWithCode(w, r, http.StatusNotFound, "Not Found", "resource not found", "resource_not_found")
	case errors.Is(err, sharing.ErrBadRequest):
		problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid request", "invalid_request")
	case errors.Is(err, sharing.ErrLinkGone):
		problemWithCode(w, r, http.StatusGone, "Gone", "this link has expired", "this_link_has_expired")
	case errors.Is(err, sharing.ErrLinkNotAvail):
		problemWithCode(w, r, http.StatusNotFound, "Not Found", "this link is no longer available", "link_unavailable")
	case errors.Is(err, sharing.ErrLinkPassword):
		// Distinct, stable code so the landing can show the password form.
		problemWithCode(w, r, http.StatusForbidden, "Forbidden", "incorrect password", "link_password_required")
	case errors.Is(err, sharing.ErrLinkSigninReq):
		problemWithCode(w, r, http.StatusForbidden, "Forbidden", "this link requires sign-in", "link_signin_required")
	default:
		problemWithCode(w, r, http.StatusInternalServerError, "Internal Server Error", "request failed", "request_failed")
	}
}

func sharingAccessHandler(sh *sharing.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		v, err := sh.GetAccess(r.Context(), chi.URLParam(r, "id"), u.ID)
		if err != nil {
			sharingProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, v)
	}
}

func sharingViewHandler(sh *sharing.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		v, err := sh.GetSharing(r.Context(), chi.URLParam(r, "id"), u.ID)
		if err != nil {
			sharingProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, v)
	}
}

func addGrantHandler(sh *sharing.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Principal sharing.Principal `json:"principal"`
			Mode      string            `json:"mode"`
			RoleID    *string           `json:"roleId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		u := userFrom(r.Context())
		g, err := sh.AddGrant(r.Context(), chi.URLParam(r, "id"), u.ID, sharing.AddGrantInput{Principal: body.Principal, Mode: body.Mode, RoleID: body.RoleID})
		if err != nil {
			sharingProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, g)
	}
}

func updateGrantHandler(sh *sharing.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var raw map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		var mode *string
		if v, ok := raw["mode"]; ok {
			_ = json.Unmarshal(v, &mode)
		}
		var roleID *string
		_, roleSet := raw["roleId"]
		if roleSet {
			_ = json.Unmarshal(raw["roleId"], &roleID)
		}
		u := userFrom(r.Context())
		g, err := sh.UpdateGrant(r.Context(), chi.URLParam(r, "gid"), u.ID, mode, roleID, roleSet)
		if err != nil {
			sharingProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, g)
	}
}

func removeGrantHandler(sh *sharing.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		if err := sh.RemoveGrant(r.Context(), chi.URLParam(r, "gid"), u.ID); err != nil {
			sharingProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func createLinkHandler(sh *sharing.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Mode          string `json:"mode"`
			Password      string `json:"password"`
			ExpiresAt     string `json:"expiresAt"`
			RequireSignin bool   `json:"requireSignin"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		u := userFrom(r.Context())
		l, err := sh.CreateLink(r.Context(), chi.URLParam(r, "id"), u.ID, sharing.CreateLinkInput{Mode: body.Mode, Password: body.Password, ExpiresAt: body.ExpiresAt, RequireSignin: body.RequireSignin})
		if err != nil {
			sharingProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, l)
	}
}

func updateLinkHandler(sh *sharing.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var raw map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		in := sharing.UpdateLinkInput{}
		if v, ok := raw["mode"]; ok {
			_ = json.Unmarshal(v, &in.Mode)
		}
		if v, ok := raw["disabled"]; ok {
			_ = json.Unmarshal(v, &in.Disabled)
		}
		if v, ok := raw["expiresAt"]; ok {
			in.ExpiresSet = true
			_ = json.Unmarshal(v, &in.ExpiresAt) // nil for JSON null -> clear
		}
		if v, ok := raw["requireSignin"]; ok {
			_ = json.Unmarshal(v, &in.RequireSignin)
		}
		u := userFrom(r.Context())
		l, err := sh.UpdateLink(r.Context(), chi.URLParam(r, "lid"), u.ID, in)
		if err != nil {
			sharingProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, l)
	}
}

func deleteLinkHandler(sh *sharing.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		if err := sh.DeleteLink(r.Context(), chi.URLParam(r, "lid"), u.ID); err != nil {
			sharingProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func rotateLinkHandler(sh *sharing.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		l, err := sh.RotateLink(r.Context(), chi.URLParam(r, "lid"), u.ID)
		if err != nil {
			sharingProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, l)
	}
}

func listRolesHandler(sh *sharing.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		roles, err := sh.ListRoles(r.Context(), chi.URLParam(r, "wid"), u.ID)
		if err != nil {
			sharingProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, roles)
	}
}

func createRoleHandler(sh *sharing.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name         string   `json:"name"`
			Capabilities []string `json:"capabilities"`
			DesignID     *string  `json:"designId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		u := userFrom(r.Context())
		role, err := sh.CreateRole(r.Context(), chi.URLParam(r, "wid"), u.ID, body.Name, body.Capabilities, body.DesignID)
		if err != nil {
			sharingProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, role)
	}
}

func updateRoleHandler(sh *sharing.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name         *string   `json:"name"`
			Capabilities *[]string `json:"capabilities"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		u := userFrom(r.Context())
		role, err := sh.UpdateRole(r.Context(), chi.URLParam(r, "rid"), u.ID, body.Name, body.Capabilities)
		if err != nil {
			sharingProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, role)
	}
}

func deleteRoleHandler(sh *sharing.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		if err := sh.DeleteRole(r.Context(), chi.URLParam(r, "rid"), u.ID); err != nil {
			sharingProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func assignRoleHandler(sh *sharing.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			TargetUserID string  `json:"targetUserId"`
			RoleID       string  `json:"roleId"`
			Mode         *string `json:"mode"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		u := userFrom(r.Context())
		g, err := sh.AssignRole(r.Context(), chi.URLParam(r, "id"), u.ID, body.TargetUserID, body.RoleID, body.Mode)
		if err != nil {
			sharingProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, g)
	}
}

func requestAccessHandler(sh *sharing.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Mode    string `json:"mode"`
			Message string `json:"message"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Mode == "" {
			body.Mode = "view"
		}
		u := userFrom(r.Context())
		v, err := sh.RequestAccess(r.Context(), chi.URLParam(r, "id"), u.ID, body.Mode, body.Message)
		if err != nil {
			sharingProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, v)
	}
}

func listAccessRequestsHandler(sh *sharing.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		list, err := sh.ListAccessRequests(r.Context(), chi.URLParam(r, "id"), u.ID)
		if err != nil {
			sharingProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

func resolveAccessRequestHandler(sh *sharing.Service, approve bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Mode *string `json:"mode"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		u := userFrom(r.Context())
		v, err := sh.ResolveAccessRequest(r.Context(), chi.URLParam(r, "rid"), u.ID, approve, body.Mode)
		if err != nil {
			sharingProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, v)
	}
}

func resolveLinkHandler(sh *sharing.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Password string `json:"password"`
		}
		// Body is optional for a passwordless link.
		_ = json.NewDecoder(r.Body).Decode(&body)
		userID := optionalUserID(r, acct)
		resolved, err := sh.ResolveLink(r.Context(), chi.URLParam(r, "token"), sharing.ResolveLinkOpts{Password: body.Password, UserID: userID})
		if err != nil {
			sharingProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, resolved)
	}
}

func resolveLinkFileHandler(sh *sharing.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Password string `json:"password"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		userID := optionalUserID(r, acct)
		resolved, err := sh.ResolveLinkFile(r.Context(), chi.URLParam(r, "token"), sharing.ResolveLinkOpts{Password: body.Password, UserID: userID})
		if err != nil {
			sharingProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, resolved)
	}
}

// optionalUserID reads the signed-in user from the access cookie best-effort;
// an unauthenticated visitor resolves as anonymous (empty id).
func optionalUserID(r *http.Request, acct *accounts.Service) string {
	c, err := r.Cookie(accessCookie)
	if err != nil || c.Value == "" {
		return ""
	}
	uid, _, err := acct.VerifyAccess(r.Context(), c.Value)
	if err != nil {
		return ""
	}
	return uid
}
