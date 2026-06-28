// Workspace member + invitation REST endpoints (Canva-style team invites): list
// members, invite by email, accept an invitation, list/revoke pending
// invitations, change a member's role, remove a member. All authenticated; the
// accounts service enforces the workspace-role authority + last-owner invariants.
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
)

func mountMembers(api chi.Router, acct *accounts.Service) {
	if acct == nil {
		return
	}
	api.With(requireAuth(acct)).Get("/workspaces/{id}/members", listMembersHandler(acct))
	api.With(requireAuth(acct)).Patch("/workspaces/{id}/members/{userId}", changeMemberRoleHandler(acct))
	api.With(requireAuth(acct)).Delete("/workspaces/{id}/members/{userId}", removeMemberHandler(acct))
	api.With(requireAuth(acct)).Post("/workspaces/{id}/invitations", inviteHandler(acct))
	api.With(requireAuth(acct)).Get("/workspaces/{id}/invitations", listInvitationsHandler(acct))
	api.With(requireAuth(acct)).Delete("/workspaces/{id}/invitations/{invitationId}", revokeInvitationHandler(acct))
	api.With(requireAuth(acct)).Post("/invitations/{token}/accept", acceptInvitationHandler(acct))
	// In-app accept/decline (the invitee's own view; reached from the bell).
	api.With(requireAuth(acct)).Get("/invitations/mine", myInvitationsHandler(acct))
	api.With(requireAuth(acct)).Post("/invitations/{id}/respond", respondInvitationHandler(acct))
}

// membersProblem maps an accounts service error to an RFC 7807 response.
func membersProblem(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, accounts.ErrForbidden):
		Problem(w, r, http.StatusForbidden, "Forbidden", "you do not have permission for this action")
	case errors.Is(err, accounts.ErrNotFound):
		Problem(w, r, http.StatusNotFound, "Not Found", "resource not found")
	case errors.Is(err, accounts.ErrBadRequest):
		Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid request")
	case errors.Is(err, accounts.ErrAlreadyMember):
		Problem(w, r, http.StatusConflict, "Conflict", "this person is already a member")
	case errors.Is(err, accounts.ErrLastOwner):
		Problem(w, r, http.StatusConflict, "Conflict", "a workspace must keep at least one owner")
	case errors.Is(err, accounts.ErrInviteInvalid):
		Problem(w, r, http.StatusGone, "Gone", "this invitation is no longer valid")
	case errors.Is(err, accounts.ErrInviteEmailMismatch):
		Problem(w, r, http.StatusForbidden, "Forbidden", "this invitation was sent to a different email address")
	default:
		Problem(w, r, http.StatusInternalServerError, "Internal Server Error", "request failed")
	}
}

func listMembersHandler(acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		members, err := acct.ListMembers(r.Context(), u.ID, chi.URLParam(r, "id"))
		if err != nil {
			membersProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, members)
	}
}

func inviteHandler(acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Email string `json:"email"`
			Role  string `json:"role"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		u := userFrom(r.Context())
		inv, token, err := acct.Invite(r.Context(), u.ID, chi.URLParam(r, "id"), body.Email, body.Role)
		if err != nil {
			membersProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"invitation": inv, "token": token})
	}
}

func acceptInvitationHandler(acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		m, err := acct.AcceptInvitation(r.Context(), u.ID, chi.URLParam(r, "token"))
		if err != nil {
			membersProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, m)
	}
}

func myInvitationsHandler(acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		invs, err := acct.MyInvitations(r.Context(), u.ID)
		if err != nil {
			membersProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, invs)
	}
}

func respondInvitationHandler(acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Accept bool `json:"accept"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		u := userFrom(r.Context())
		m, err := acct.RespondToInvitation(r.Context(), u.ID, chi.URLParam(r, "id"), body.Accept)
		if err != nil {
			membersProblem(w, r, err)
			return
		}
		if !body.Accept {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		writeJSON(w, http.StatusOK, m)
	}
}

func listInvitationsHandler(acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		invs, err := acct.ListInvitations(r.Context(), u.ID, chi.URLParam(r, "id"))
		if err != nil {
			membersProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, invs)
	}
}

func revokeInvitationHandler(acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		if err := acct.RevokeInvitation(r.Context(), u.ID, chi.URLParam(r, "id"), chi.URLParam(r, "invitationId")); err != nil {
			membersProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func changeMemberRoleHandler(acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Role string `json:"role"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		u := userFrom(r.Context())
		if err := acct.ChangeMemberRole(r.Context(), u.ID, chi.URLParam(r, "id"), chi.URLParam(r, "userId"), body.Role); err != nil {
			membersProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func removeMemberHandler(acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		if err := acct.RemoveMember(r.Context(), u.ID, chi.URLParam(r, "id"), chi.URLParam(r, "userId")); err != nil {
			membersProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
