package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/push"
)

// mountPush attaches the web-push subscription surface (doc 17 FR-13). The
// public key endpoint is unauthenticated (the client needs it to subscribe);
// subscribe/unsubscribe are session-guarded.
func mountPush(api chi.Router, ps *push.Service, acct *accounts.Service) {
	api.Get("/push/vapid-public-key", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"publicKey": ps.PublicKey(), "enabled": ps.IsEnabled()})
	})
	api.With(requireAuth(acct)).Post("/push/subscribe", pushSubscribeHandler(ps))
	api.With(requireAuth(acct)).Post("/push/unsubscribe", pushUnsubscribeHandler(ps))
}

func pushSubscribeHandler(ps *push.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Endpoint string `json:"endpoint"`
			Keys     struct {
				P256dh string `json:"p256dh"`
				Auth   string `json:"auth"`
			} `json:"keys"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Endpoint == "" {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid subscription", "invalid_subscription")
			return
		}
		u := userFrom(r.Context())
		if err := ps.Subscribe(r.Context(), u.ID, body.Endpoint, body.Keys.P256dh, body.Keys.Auth); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "could not save subscription", "could_not_save_subscription")
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

func pushUnsubscribeHandler(ps *push.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Endpoint string `json:"endpoint"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Endpoint == "" {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "missing endpoint", "missing_endpoint")
			return
		}
		if err := ps.Unsubscribe(r.Context(), body.Endpoint); err != nil {
			problemWithCode(w, r, http.StatusInternalServerError, "Internal Server Error", "could not unsubscribe", "could_not_unsubscribe")
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}
