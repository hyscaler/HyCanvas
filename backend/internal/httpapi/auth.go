package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
)

type ctxKey string

const userKey ctxKey = "authedUser"

type authedUser struct {
	ID        string
	SessionID string
}

// mountAuth attaches the auth + me routes (matching /api/v1/auth/* and /api/v1/me).
func mountAuth(api chi.Router, svc *accounts.Service, secure bool) {
	api.Route("/auth", func(r chi.Router) {
		r.Post("/signup", signupHandler(svc, secure))
		r.Post("/login", loginHandler(svc, secure))
		r.Post("/refresh", refreshHandler(svc, secure))
		r.With(requireAuth(svc)).Post("/logout", logoutHandler(svc, secure))
		// MFA (doc 15 FR-5). enroll/confirm/disable are session-guarded; verify is
		// public (it trades the login challenge token for a session).
		r.With(requireAuth(svc)).Post("/mfa/enroll", mfaEnrollHandler(svc))
		r.With(requireAuth(svc)).Post("/mfa/confirm", mfaConfirmHandler(svc))
		r.With(requireAuth(svc)).Post("/mfa/disable", mfaDisableHandler(svc))
		r.Post("/mfa/verify", mfaVerifyHandler(svc, secure))
		// Email flows (doc 15 FR-1). Request endpoints are enumeration-safe (204).
		r.Post("/verify-email/request", emailRequestHandler(svc, "verify"))
		r.Post("/verify-email", verifyEmailHandler(svc))
		r.Post("/password-reset/request", emailRequestHandler(svc, "reset"))
		r.Post("/password-reset", resetPasswordHandler(svc))
		r.Post("/magic-link/request", emailRequestHandler(svc, "magic"))
		r.Post("/magic-link", magicLinkHandler(svc, secure))
		// Dev-only mail outbox (no SMTP wired); forbidden when cookies are secure
		// (production).
		r.Get("/dev/outbox", devOutboxHandler(svc, secure))
	})
	api.With(requireAuth(svc)).Get("/me", meHandler(svc))
	api.With(requireAuth(svc)).Get("/auth/sessions", sessionsHandler(svc))
}

func sessionsHandler(svc *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		list, err := svc.ListSessions(r.Context(), u.ID)
		if err != nil {
			Problem(w, r, http.StatusInternalServerError, "Internal Server Error", "could not list sessions")
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

func signupHandler(svc *accounts.Service, secure bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Email    string `json:"email"`
			Password string `json:"password"`
			Name     string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		user, ws, tokens, err := svc.Signup(r.Context(), body.Email, body.Password, body.Name)
		if err != nil {
			switch {
			case errors.Is(err, accounts.ErrEmailTaken):
				Problem(w, r, http.StatusConflict, "Conflict", "an account with this email already exists")
			case errors.Is(err, accounts.ErrInvalidSignup):
				Problem(w, r, http.StatusBadRequest, "Bad Request", "a valid email and an 8+ character password are required")
			default:
				Problem(w, r, http.StatusInternalServerError, "Internal Server Error", "signup failed")
			}
			return
		}
		setAuthCookies(w, tokens.Access, tokens.Refresh, secure)
		writeJSON(w, http.StatusCreated, map[string]any{"user": user, "workspace": ws})
	}
}

func loginHandler(svc *accounts.Service, secure bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Email    string `json:"email"`
			Password string `json:"password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Email == "" || body.Password == "" {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "email and password are required")
			return
		}
		email := strings.ToLower(strings.TrimSpace(body.Email))
		user, tokens, mfaToken, err := svc.Login(r.Context(), email, body.Password, r.UserAgent(), clientIP(r))
		if err != nil {
			if errors.Is(err, accounts.ErrMFARequired) {
				// MFA-gated account: return the challenge, set no cookies. The
				// client redeems it via /auth/mfa/verify.
				writeJSON(w, http.StatusOK, map[string]any{"mfaRequired": true, "mfaToken": mfaToken})
				return
			}
			Problem(w, r, http.StatusUnauthorized, "Unauthorized", "invalid email or password")
			return
		}
		setAuthCookies(w, tokens.Access, tokens.Refresh, secure)
		writeJSON(w, http.StatusOK, map[string]any{"user": user})
	}
}

func refreshHandler(svc *accounts.Service, secure bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(refreshCookie)
		if err != nil || c.Value == "" {
			Problem(w, r, http.StatusUnauthorized, "Unauthorized", "missing refresh token")
			return
		}
		tokens, err := svc.Refresh(r.Context(), c.Value)
		if err != nil {
			// On any refresh failure (invalid/revoked/reuse) clear cookies so the
			// client falls back to a fresh login.
			clearAuthCookies(w, secure)
			Problem(w, r, http.StatusUnauthorized, "Unauthorized", "invalid refresh token")
			return
		}
		setAuthCookies(w, tokens.Access, tokens.Refresh, secure)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

func logoutHandler(svc *accounts.Service, secure bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if u := userFrom(r.Context()); u != nil {
			_ = svc.Logout(r.Context(), u.SessionID)
		}
		clearAuthCookies(w, secure)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

func meHandler(svc *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		view, err := svc.GetUserByID(r.Context(), u.ID)
		if err != nil {
			Problem(w, r, http.StatusNotFound, "Not Found", "user not found")
			return
		}
		writeJSON(w, http.StatusOK, view)
	}
}

func mfaEnrollHandler(svc *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		otpauthURL, secret, err := svc.BeginMfaEnrollment(r.Context(), u.ID)
		if err != nil {
			mfaProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"otpauthUrl": otpauthURL, "secret": secret})
	}
}

func mfaConfirmHandler(svc *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Code string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		u := userFrom(r.Context())
		codes, err := svc.ConfirmMfaEnrollment(r.Context(), u.ID, body.Code)
		if err != nil {
			mfaProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"recoveryCodes": codes})
	}
}

func mfaDisableHandler(svc *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Code string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		u := userFrom(r.Context())
		if err := svc.DisableMfa(r.Context(), u.ID, body.Code); err != nil {
			mfaProblem(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

func mfaVerifyHandler(svc *accounts.Service, secure bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			MfaToken string `json:"mfaToken"`
			Code     string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		user, tokens, err := svc.VerifyMfaLogin(r.Context(), body.MfaToken, body.Code, r.UserAgent(), clientIP(r))
		if err != nil {
			mfaProblem(w, r, err)
			return
		}
		setAuthCookies(w, tokens.Access, tokens.Refresh, secure)
		writeJSON(w, http.StatusOK, map[string]any{"user": user})
	}
}

// emailRequestHandler handles the enumeration-safe request endpoints (always
// 204): verify-email/request, password-reset/request, magic-link/request.
func emailRequestHandler(svc *accounts.Service, kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Email string `json:"email"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Email == "" {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "email is required")
			return
		}
		var err error
		switch kind {
		case "reset":
			err = svc.RequestPasswordReset(r.Context(), body.Email)
		case "magic":
			err = svc.RequestMagicLink(r.Context(), body.Email)
		default:
			err = svc.RequestEmailVerification(r.Context(), body.Email)
		}
		if err != nil {
			Problem(w, r, http.StatusInternalServerError, "Internal Server Error", "request failed")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func verifyEmailHandler(svc *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Token string `json:"token"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		user, err := svc.VerifyEmail(r.Context(), body.Token)
		if err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid or expired token")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"user": user})
	}
}

func resetPasswordHandler(svc *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Token    string `json:"token"`
			Password string `json:"password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		if err := svc.ResetPassword(r.Context(), body.Token, body.Password); err != nil {
			if errors.Is(err, accounts.ErrInvalidSignup) {
				Problem(w, r, http.StatusBadRequest, "Bad Request", "password must be at least 8 characters")
				return
			}
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid or expired token")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func magicLinkHandler(svc *accounts.Service, secure bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Token string `json:"token"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid body")
			return
		}
		user, tokens, err := svc.LoginWithMagicLink(r.Context(), body.Token, r.UserAgent(), clientIP(r))
		if err != nil {
			Problem(w, r, http.StatusUnauthorized, "Unauthorized", "invalid or expired link")
			return
		}
		setAuthCookies(w, tokens.Access, tokens.Refresh, secure)
		writeJSON(w, http.StatusOK, map[string]any{"user": user})
	}
}

// devOutboxHandler exposes the in-memory mail outbox in non-production only.
func devOutboxHandler(svc *accounts.Service, secure bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if secure {
			Problem(w, r, http.StatusForbidden, "Forbidden", "not available in production")
			return
		}
		writeJSON(w, http.StatusOK, svc.Outbox())
	}
}

// mfaProblem maps MFA errors to RFC 7807 statuses.
func mfaProblem(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, accounts.ErrMFAChallenge):
		Problem(w, r, http.StatusUnauthorized, "Unauthorized", "invalid or expired MFA challenge")
	case errors.Is(err, accounts.ErrMFAInvalid):
		// 401 on the verify path, 400 on enroll/disable; both are acceptable, use 400.
		Problem(w, r, http.StatusBadRequest, "Bad Request", "invalid authentication code")
	case errors.Is(err, accounts.ErrMFAAlready):
		Problem(w, r, http.StatusBadRequest, "Bad Request", "MFA is already enabled")
	case errors.Is(err, accounts.ErrMFANotSetup):
		Problem(w, r, http.StatusBadRequest, "Bad Request", "start MFA enrollment first")
	default:
		Problem(w, r, http.StatusInternalServerError, "Internal Server Error", "request failed")
	}
}

// requireAuth verifies the access token (bearer or hc_access cookie) and the
// session's active state, then injects the user into the request context.
func requireAuth(svc *accounts.Service) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := bearerOrCookie(r)
			if token == "" {
				Problem(w, r, http.StatusUnauthorized, "Unauthorized", "missing access token")
				return
			}
			uid, sid, err := svc.VerifyAccess(r.Context(), token)
			if err != nil {
				Problem(w, r, http.StatusUnauthorized, "Unauthorized", "invalid or expired access token")
				return
			}
			ctx := context.WithValue(r.Context(), userKey, &authedUser{ID: uid, SessionID: sid})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func bearerOrCookie(r *http.Request) string {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return strings.TrimPrefix(h, "Bearer ")
	}
	if c, err := r.Cookie(accessCookie); err == nil {
		return c.Value
	}
	return ""
}

func userFrom(ctx context.Context) *authedUser {
	u, _ := ctx.Value(userKey).(*authedUser)
	return u
}

func clientIP(r *http.Request) string {
	return r.RemoteAddr
}
