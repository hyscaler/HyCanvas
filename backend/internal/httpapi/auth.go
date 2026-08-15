package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/captcha"
	"hycanvas/backend/internal/platform/config"
)

type ctxKey string

const userKey ctxKey = "authedUser"

type authedUser struct {
	ID        string
	SessionID string
}

// mountAuth attaches the auth + me routes (matching /api/v1/auth/* and /api/v1/me).
// `policy` decides which method-specific routes are live; a disabled route
// answers 403 rather than being absent, so a client gets a clear reason.
func mountAuth(api chi.Router, svc *accounts.Service, secure bool, policy config.AuthPolicy, cap captcha.Verifier) {
	// gate wraps a handler so it returns 403 when its method is turned off. The
	// route still exists (a 404 would look like a version mismatch); the body
	// says which method is disabled.
	gate := func(enabled bool, h http.HandlerFunc) http.HandlerFunc {
		if enabled {
			return h
		}
		return func(w http.ResponseWriter, r *http.Request) {
			problemWithCode(w, r, http.StatusForbidden, "Forbidden", "this sign-in method is disabled on this instance", "signin_method_disabled")
		}
	}
	// protect wraps a human-facing auth form with the CAPTCHA check when one is
	// configured. It runs before the handler reads the body, verifying the
	// X-Captcha-Token header; a missing or invalid token is 403. When no CAPTCHA
	// is configured (cap == nil) it is a pass-through, so nothing changes.
	protect := func(h http.HandlerFunc) http.HandlerFunc {
		if cap == nil {
			return h
		}
		return func(w http.ResponseWriter, r *http.Request) {
			token := r.Header.Get("X-Captcha-Token")
			if err := cap.Verify(r.Context(), token, clientIP(r)); err != nil {
				problemWithCode(w, r, http.StatusForbidden, "Forbidden", "captcha verification failed; please try again", "captcha_failed")
				return
			}
			h(w, r)
		}
	}
	api.Route("/auth", func(r chi.Router) {
		r.Post("/signup", gate(policy.PasswordSignup, protect(signupHandler(svc, secure))))
		r.Post("/login", gate(policy.PasswordLogin, protect(loginHandler(svc, secure))))
		r.Post("/refresh", refreshHandler(svc, secure))
		r.With(requireAuth(svc)).Post("/logout", logoutHandler(svc, secure))
		// MFA (doc 15 FR-5). enroll/confirm/disable are session-guarded; verify is
		// public (it trades the login challenge token for a session). Left ungated:
		// an OIDC account can still carry a second factor.
		r.With(requireAuth(svc)).Post("/mfa/enroll", mfaEnrollHandler(svc))
		r.With(requireAuth(svc)).Post("/mfa/confirm", mfaConfirmHandler(svc))
		r.With(requireAuth(svc)).Post("/mfa/disable", mfaDisableHandler(svc))
		r.Post("/mfa/verify", mfaVerifyHandler(svc, secure))
		// Email flows (doc 15 FR-1). Request endpoints are enumeration-safe (204).
		// verify-email stays ungated (any account may confirm its address); reset
		// follows password login (no point resetting a password you cannot use).
		r.Post("/verify-email/request", emailRequestHandler(svc, "verify"))
		r.Post("/verify-email", verifyEmailHandler(svc))
		// The reset REQUEST form is CAPTCHA-protected (a bot can spam reset emails);
		// the redeem step is not (it carries a token from the email, not a form).
		r.Post("/password-reset/request", gate(policy.PasswordLogin, protect(emailRequestHandler(svc, "reset"))))
		r.Post("/password-reset", gate(policy.PasswordLogin, resetPasswordHandler(svc)))
		// Magic-link request/redeem stay mounted whenever either magic toggle is on;
		// the login-vs-signup decision lives inside the handlers, which consult the
		// policy (an unknown email is a signup, gated by MagicLinkSignup). The
		// request form is CAPTCHA-protected; the redeem step (token from email) is not.
		magicOn := policy.MagicLinkLogin || policy.MagicLinkSignup
		r.Post("/magic-link/request", gate(magicOn, protect(magicRequestHandler(svc, policy))))
		r.Post("/magic-link", gate(magicOn, magicLinkHandler(svc, secure, policy)))
		// Dev-only mail outbox (no SMTP wired); forbidden when cookies are secure
		// (production).
		r.Get("/dev/outbox", devOutboxHandler(svc, secure))
	})
	api.With(requireAuth(svc)).Get("/me", meHandler(svc))
	api.With(requireAuth(svc)).Patch("/me", updateMeHandler(svc))
	api.With(requireAuth(svc)).Get("/auth/sessions", sessionsHandler(svc))
}

// updateMeHandler patches the caller's profile (name, avatarUrl, locale, and the
// regional preferences timezone/timeFormat/weekStart). Absent fields are left
// unchanged; avatarUrl "" clears the avatar.
func updateMeHandler(svc *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var raw map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		var in accounts.UpdateProfileInput
		if v, ok := raw["name"]; ok {
			_ = json.Unmarshal(v, &in.Name)
		}
		if v, ok := raw["avatarUrl"]; ok {
			_ = json.Unmarshal(v, &in.AvatarURL)
		}
		if v, ok := raw["locale"]; ok {
			_ = json.Unmarshal(v, &in.Locale)
		}
		if v, ok := raw["timezone"]; ok {
			_ = json.Unmarshal(v, &in.Timezone)
		}
		if v, ok := raw["timeFormat"]; ok {
			_ = json.Unmarshal(v, &in.TimeFormat)
		}
		if v, ok := raw["weekStart"]; ok {
			_ = json.Unmarshal(v, &in.WeekStart)
		}
		u := userFrom(r.Context())
		view, err := svc.UpdateProfile(r.Context(), u.ID, in)
		if err != nil {
			if errors.Is(err, accounts.ErrInvalidSignup) {
				problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "name cannot be empty", "name_cannot_be_empty")
				return
			}
			if errors.Is(err, accounts.ErrInvalidProfile) {
				problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid timezone or preference value", "invalid_timezone_or_preference_value")
				return
			}
			problemWithCode(w, r, http.StatusInternalServerError, "Internal Server Error", "could not update profile", "could_not_update_profile")
			return
		}
		writeJSON(w, http.StatusOK, view)
	}
}

func sessionsHandler(svc *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		list, err := svc.ListSessions(r.Context(), u.ID)
		if err != nil {
			problemWithCode(w, r, http.StatusInternalServerError, "Internal Server Error", "could not list sessions", "could_not_list_sessions")
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
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		user, ws, tokens, err := svc.Signup(r.Context(), body.Email, body.Password, body.Name)
		if err != nil {
			switch {
			case errors.Is(err, accounts.ErrEmailTaken):
				problemWithCode(w, r, http.StatusConflict, "Conflict", "an account with this email already exists", "email_already_registered")
			case errors.Is(err, accounts.ErrInvalidSignup):
				problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "a valid email and an 8+ character password are required", "signup_credentials_invalid")
			default:
				problemWithCode(w, r, http.StatusInternalServerError, "Internal Server Error", "signup failed", "signup_failed")
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
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "email and password are required", "email_and_password_are_required")
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
			problemWithCode(w, r, http.StatusUnauthorized, "Unauthorized", "invalid email or password", "invalid_email_or_password")
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
			problemWithCode(w, r, http.StatusUnauthorized, "Unauthorized", "missing refresh token", "missing_refresh_token")
			return
		}
		tokens, err := svc.Refresh(r.Context(), c.Value)
		if err != nil {
			// Clear the auth cookies only when the family is definitively dead
			// (revoked, or reuse detected), forcing a fresh login. For a token
			// that merely isn't current (ErrInvalidRefresh) do NOT clear: this
			// tab may have lost a concurrent-refresh race and presented a token
			// already rotated away, while the shared cookie jar already holds the
			// live one. Deleting cookies here would log the whole browser out
			// despite a healthy session; a bare 401 lets the jar keep its live
			// cookie and the next request refreshes cleanly.
			if errors.Is(err, accounts.ErrReuseDetected) || errors.Is(err, accounts.ErrSessionRevoked) {
				clearAuthCookies(w, secure)
			}
			problemWithCode(w, r, http.StatusUnauthorized, "Unauthorized", "invalid refresh token", "invalid_refresh_token")
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
			problemWithCode(w, r, http.StatusNotFound, "Not Found", "user not found", "user_not_found")
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
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
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
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
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
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
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
// 204): verify-email/request and password-reset/request. Magic-link requests go
// through magicRequestHandler, which is signup-aware.
func emailRequestHandler(svc *accounts.Service, kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Email string `json:"email"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Email == "" {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "email is required", "email_is_required")
			return
		}
		var err error
		switch kind {
		case "reset":
			err = svc.RequestPasswordReset(r.Context(), body.Email)
		default:
			err = svc.RequestEmailVerification(r.Context(), body.Email)
		}
		if err != nil {
			problemWithCode(w, r, http.StatusInternalServerError, "Internal Server Error", "request failed", "request_failed")
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
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		user, err := svc.VerifyEmail(r.Context(), body.Token)
		if err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid or expired token", "invalid_or_expired_token")
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
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		if err := svc.ResetPassword(r.Context(), body.Token, body.Password); err != nil {
			if errors.Is(err, accounts.ErrInvalidSignup) {
				problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "password must be at least 8 characters", "password_too_short")
				return
			}
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid or expired token", "invalid_or_expired_token")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// magicRequestHandler issues a magic link. It is enumeration-safe (always 204):
// for a known email it sends a sign-in link; for an unknown email it sends a
// sign-up link only when magic-link signup is enabled, and otherwise does
// nothing, so the response never reveals whether an account exists.
func magicRequestHandler(svc *accounts.Service, policy config.AuthPolicy) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Email string `json:"email"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Email == "" {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "email is required", "email_is_required")
			return
		}
		if err := svc.RequestMagicLink(r.Context(), body.Email, policy.MagicLinkSignup); err != nil {
			problemWithCode(w, r, http.StatusInternalServerError, "Internal Server Error", "request failed", "request_failed")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func magicLinkHandler(svc *accounts.Service, secure bool, policy config.AuthPolicy) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Token string `json:"token"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid body", "invalid_body")
			return
		}
		// A redeem may create the account (sign-up link for a new email) only when
		// magic-link signup is enabled; existing-user links always work.
		user, tokens, err := svc.LoginWithMagicLink(r.Context(), body.Token, r.UserAgent(), clientIP(r), policy.MagicLinkSignup)
		if err != nil {
			problemWithCode(w, r, http.StatusUnauthorized, "Unauthorized", "invalid or expired link", "invalid_or_expired_link")
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
			problemWithCode(w, r, http.StatusForbidden, "Forbidden", "not available in production", "not_available_in_production")
			return
		}
		writeJSON(w, http.StatusOK, svc.Outbox())
	}
}

// mfaProblem maps MFA errors to RFC 7807 statuses.
func mfaProblem(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, accounts.ErrMFAChallenge):
		problemWithCode(w, r, http.StatusUnauthorized, "Unauthorized", "invalid or expired MFA challenge", "invalid_or_expired_mfa_challenge")
	case errors.Is(err, accounts.ErrMFAInvalid):
		// 401 on the verify path, 400 on enroll/disable; both are acceptable, use 400.
		problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "invalid authentication code", "invalid_authentication_code")
	case errors.Is(err, accounts.ErrMFAAlready):
		problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "MFA is already enabled", "mfa_is_already_enabled")
	case errors.Is(err, accounts.ErrMFANotSetup):
		problemWithCode(w, r, http.StatusBadRequest, "Bad Request", "start MFA enrollment first", "start_mfa_enrollment_first")
	default:
		problemWithCode(w, r, http.StatusInternalServerError, "Internal Server Error", "request failed", "request_failed")
	}
}

// requireAuth verifies the access token (bearer or hc_access cookie) and the
// session's active state, then injects the user into the request context.
func requireAuth(svc *accounts.Service) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := bearerOrCookie(r)
			if token == "" {
				problemWithCode(w, r, http.StatusUnauthorized, "Unauthorized", "missing access token", "missing_access_token")
				return
			}
			uid, sid, err := svc.VerifyAccess(r.Context(), token)
			if err != nil {
				problemWithCode(w, r, http.StatusUnauthorized, "Unauthorized", "invalid or expired access token", "invalid_or_expired_access_token")
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
