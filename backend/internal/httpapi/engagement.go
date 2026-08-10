package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/engagement"
	"hycanvas/backend/internal/sharing"
)

// mountEngagement attaches the activity feed, notifications center, and insights
// surface (doc 17 slice D). Per-design reads are capability-gated in the
// service; notifications are scoped to the caller. The public shared view-beat
// route is unguarded (validated by share-link token in the service).
func mountEngagement(api chi.Router, en *engagement.Service, acct *accounts.Service) {
	api.Group(func(r chi.Router) {
		r.Use(requireAuth(acct))
		r.Get("/designs/{id}/activity", activityHandler(en))
		r.Get("/notifications", notificationsHandler(en))
		r.Get("/notifications/unread-count", unreadCountHandler(en))
		r.Post("/notifications/{nid}/read", markReadHandler(en))
		r.Post("/notifications/read-all", markAllReadHandler(en))
		r.Get("/me/notification-prefs", getPrefsHandler(en))
		r.Put("/me/notification-prefs", setPrefsHandler(en))
		r.Post("/designs/{id}/view-beat", viewBeatHandler(en))
		r.Get("/designs/{id}/insights", insightsHandler(en))
	})
	api.Post("/shared/{token}/view-beat", sharedViewBeatHandler(en))
}

func engagementProblem(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, engagement.ErrForbidden):
		problemWithCode(w, r, http.StatusForbidden, "Forbidden", "you do not have permission for this action", "forbidden_action")
	case errors.Is(err, engagement.ErrNotFound):
		problemWithCode(w, r, http.StatusNotFound, "Not Found", "not found", "not_found")
	case errors.Is(err, sharing.ErrLinkGone):
		problemWithCode(w, r, http.StatusGone, "Gone", "this link has expired", "this_link_has_expired")
	case errors.Is(err, sharing.ErrLinkNotAvail):
		problemWithCode(w, r, http.StatusNotFound, "Not Found", "this link is no longer available", "link_unavailable")
	case errors.Is(err, sharing.ErrLinkPassword):
		problemWithCode(w, r, http.StatusForbidden, "Forbidden", "incorrect password", "link_password_required")
	case errors.Is(err, sharing.ErrLinkSigninReq):
		problemWithCode(w, r, http.StatusForbidden, "Forbidden", "this link requires sign-in", "link_signin_required")
	default:
		problemWithCode(w, r, http.StatusInternalServerError, "Internal Server Error", "request failed", "request_failed")
	}
}

func activityHandler(en *engagement.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		page, err := en.ListActivity(r.Context(), chi.URLParam(r, "id"), u.ID, r.URL.Query().Get("type"), r.URL.Query().Get("cursor"))
		if err != nil {
			engagementProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, page)
	}
}

func notificationsHandler(en *engagement.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		unread := r.URL.Query().Get("unread")
		page, err := en.ListNotifications(r.Context(), u.ID, unread == "true" || unread == "1", r.URL.Query().Get("cursor"))
		if err != nil {
			engagementProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, page)
	}
}

func unreadCountHandler(en *engagement.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		n, err := en.UnreadCount(r.Context(), u.ID)
		if err != nil {
			engagementProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]int{"count": n})
	}
}

func markReadHandler(en *engagement.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		if err := en.MarkRead(r.Context(), chi.URLParam(r, "nid"), u.ID); err != nil {
			engagementProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func markAllReadHandler(en *engagement.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		if err := en.MarkAllRead(r.Context(), u.ID); err != nil {
			engagementProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func getPrefsHandler(en *engagement.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		prefs, err := en.GetPrefs(r.Context(), u.ID)
		if err != nil {
			engagementProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, prefs)
	}
}

func setPrefsHandler(en *engagement.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var raw map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		in := engagement.SetPrefsInput{}
		if v, ok := raw["emailTypes"]; ok {
			in.EmailTypesSet = true
			_ = json.Unmarshal(v, &in.EmailTypes)
		}
		if v, ok := raw["pushTypes"]; ok {
			in.PushTypesSet = true
			_ = json.Unmarshal(v, &in.PushTypes)
		}
		u := userFrom(r.Context())
		prefs, err := en.SetPrefs(r.Context(), u.ID, in)
		if err != nil {
			engagementProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, prefs)
	}
}

func viewBeatHandler(en *engagement.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			SessionID string  `json:"sessionId"`
			PageID    *string `json:"pageId"`
			Ms        int     `json:"ms"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		u := userFrom(r.Context())
		if err := en.RecordViewBeat(r.Context(), chi.URLParam(r, "id"), u.ID, engagement.ViewBeat{SessionID: body.SessionID, PageID: body.PageID, Ms: body.Ms}); err != nil {
			engagementProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func insightsHandler(en *engagement.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		ins, err := en.Insights(r.Context(), chi.URLParam(r, "id"), u.ID)
		if err != nil {
			engagementProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, ins)
	}
}

func sharedViewBeatHandler(en *engagement.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			AnonID    string  `json:"anonId"`
			SessionID string  `json:"sessionId"`
			PageID    *string `json:"pageId"`
			Ms        int     `json:"ms"`
			Password  string  `json:"password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		if err := en.RecordSharedViewBeat(r.Context(), chi.URLParam(r, "token"), body.Password, engagement.AnonViewBeat{AnonID: body.AnonID, SessionID: body.SessionID, PageID: body.PageID, Ms: body.Ms}); err != nil {
			engagementProblem(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
