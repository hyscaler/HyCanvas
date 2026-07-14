package httpapi

import (
	"crypto/subtle"
	"errors"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/oidc"
	"hycanvas/backend/internal/platform/config"
)

const oidcStateCookie = "oc_oidc"

// mountOIDC attaches the SSO surface (doc 15): the public provider list and the
// authorization-code + PKCE redirect/callback. start sets a signed state cookie
// and redirects to the IdP; callback verifies it, exchanges the code, links the
// account (LoginWithOidc), sets the session cookies, and redirects to the app.
func mountOIDC(api chi.Router, svc *oidc.Service, acct *accounts.Service, secure bool, policy config.AuthPolicy, cap config.CaptchaConfig) {
	// The providers endpoint doubles as the auth-config endpoint the login page
	// reads, so it always mounts and reports the full policy plus captcha config.
	api.Get("/auth/providers", oidcProvidersHandler(svc, policy, cap))
	// The sign-in flow is available when either OIDC toggle is on; the
	// login-vs-signup split is enforced inside the callback.
	oidcOn := policy.OidcLogin || policy.OidcSignup
	oidcGate := func(h http.HandlerFunc) http.HandlerFunc {
		if oidcOn {
			return h
		}
		return func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, frontendURL()+"/login?error=oidc_disabled", http.StatusFound)
		}
	}
	api.Get("/auth/oidc/start", oidcGate(oidcStartHandler(svc, secure)))
	api.Get("/auth/oidc/callback", oidcGate(oidcCallbackHandler(svc, acct, secure, policy)))
	// Connect/disconnect SSO for an already-authenticated user (link flow). The
	// callback above handles both sign-in and connect via the signed state.
	api.With(requireAuth(acct)).Get("/auth/oidc/link", oidcLinkStartHandler(svc, secure))
	api.With(requireAuth(acct)).Get("/auth/oidc/identity", oidcIdentityHandler(svc, acct))
	api.With(requireAuth(acct)).Delete("/auth/oidc/identity", oidcUnlinkHandler(acct))
}

// frontendURL is where SSO redirects send the browser back to. In dev the
// frontend runs on its own origin (FRONTEND_URL, the Next dev server); in the
// single-binary production deployment it is served same-origin, so the public
// APP_URL is the right target and FRONTEND_URL stays unset.
func frontendURL() string {
	for _, k := range []string{"FRONTEND_URL", "APP_URL"} {
		if v := strings.TrimRight(os.Getenv(k), "/"); v != "" {
			return v
		}
	}
	return "http://localhost:3000"
}

// oidcProvidersHandler is also the auth-config endpoint the sign-in page reads:
// it returns the SSO provider list plus the full method policy, so the UI shows
// exactly the methods this instance allows.
func oidcProvidersHandler(svc *oidc.Service, policy config.AuthPolicy, cap config.CaptchaConfig) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// captcha is null when disabled; otherwise it carries the provider and the
		// public site key the widget needs. The secret key never leaves the server.
		var captchaBlock any
		if cap.Enabled() {
			captchaBlock = map[string]string{"provider": cap.Provider, "siteKey": cap.SiteKey}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"providers": svc.Providers(),
			"policy": map[string]bool{
				"passwordLogin":   policy.PasswordLogin,
				"passwordSignup":  policy.PasswordSignup,
				"magicLinkLogin":  policy.MagicLinkLogin,
				"magicLinkSignup": policy.MagicLinkSignup,
				"oidcLogin":       policy.OidcLogin,
				"oidcSignup":      policy.OidcSignup,
			},
			"captcha": captchaBlock,
		})
	}
}

func oidcStartHandler(svc *oidc.Service, secure bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		authURL, cookie, err := svc.AuthURL()
		if err != nil {
			http.Redirect(w, r, frontendURL()+"/login?error=sso", http.StatusFound)
			return
		}
		http.SetCookie(w, &http.Cookie{
			Name: oidcStateCookie, Value: cookie, Path: "/", HttpOnly: true,
			SameSite: http.SameSiteLaxMode, Secure: secure, MaxAge: 600,
		})
		http.Redirect(w, r, authURL, http.StatusFound)
	}
}

func oidcCallbackHandler(svc *oidc.Service, acct *accounts.Service, secure bool, policy config.AuthPolicy) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		front := frontendURL()
		// Clear the state cookie regardless of outcome.
		http.SetCookie(w, &http.Cookie{Name: oidcStateCookie, Value: "", Path: "/", MaxAge: -1})

		fail := func() { http.Redirect(w, r, front+"/login?error=sso", http.StatusFound) }

		code := r.URL.Query().Get("code")
		state := r.URL.Query().Get("state")
		c, err := r.Cookie(oidcStateCookie)
		if err != nil || code == "" || state == "" {
			fail()
			return
		}
		savedState, verifier, link, ok := svc.ParseStateCookie(c.Value)
		if !ok || subtle.ConstantTimeCompare([]byte(savedState), []byte(state)) != 1 {
			fail()
			return
		}
		profile, err := svc.Exchange(r.Context(), code, verifier)
		if err != nil {
			fail()
			return
		}

		// Connect flow: the state carries the user to link to. Require the live
		// session to belong to that same user (so a stray link cookie can't bind an
		// identity to someone else), then attach the identity and return to Settings.
		if link != "" {
			if optionalUserID(r, acct) != link {
				http.Redirect(w, r, front+"/settings?sso=error", http.StatusFound)
				return
			}
			if err := acct.LinkOidcIdentity(r.Context(), link, accounts.OidcProfile{
				Subject: profile.Subject, Email: profile.Email, EmailVerified: profile.EmailVerified, Name: profile.Name,
			}); err != nil {
				http.Redirect(w, r, front+"/settings?sso=error", http.StatusFound)
				return
			}
			http.Redirect(w, r, front+"/settings?sso=connected", http.StatusFound)
			return
		}

		// The policy splits the flow: signing an existing/linked identity in needs
		// OidcLogin; provisioning a brand-new account needs OidcSignup. LoginWithOidc
		// returns the matching sentinel when the relevant toggle is off.
		_, tokens, mfaToken, err := acct.LoginWithOidc(r.Context(), accounts.OidcProfile{
			Subject: profile.Subject, Email: profile.Email, EmailVerified: profile.EmailVerified, Name: profile.Name,
		}, r.UserAgent(), clientIP(r), policy.OidcLogin, policy.OidcSignup)
		if err != nil {
			switch {
			case errors.Is(err, accounts.ErrMFARequired):
				// The account uses TOTP: hand the challenge to the login page, which
				// prompts for the code and redeems it via the existing verify flow.
				http.Redirect(w, r, front+"/login?mfa="+url.QueryEscape(mfaToken), http.StatusFound)
			case errors.Is(err, accounts.ErrOidcLinkRefused):
				// An email-matching password account exists but the IdP is not a
				// vouched authority for it; tell the user to sign in and link manually.
				http.Redirect(w, r, front+"/login?error=sso_exists", http.StatusFound)
			case errors.Is(err, accounts.ErrOidcLoginDisabled):
				http.Redirect(w, r, front+"/login?error=oidc_login_disabled", http.StatusFound)
			case errors.Is(err, accounts.ErrOidcSignupDisabled):
				http.Redirect(w, r, front+"/login?error=oidc_signup_disabled", http.StatusFound)
			default:
				fail()
			}
			return
		}
		setAuthCookies(w, tokens.Access, tokens.Refresh, secure)
		http.Redirect(w, r, front+"/dashboard", http.StatusFound)
	}
}

// oidcLinkStartHandler begins connecting an SSO identity to the signed-in user.
func oidcLinkStartHandler(svc *oidc.Service, secure bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		authURL, cookie, err := svc.LinkURL(u.ID)
		if err != nil {
			http.Redirect(w, r, frontendURL()+"/settings?sso=error", http.StatusFound)
			return
		}
		http.SetCookie(w, &http.Cookie{
			Name: oidcStateCookie, Value: cookie, Path: "/", HttpOnly: true,
			SameSite: http.SameSiteLaxMode, Secure: secure, MaxAge: 600,
		})
		http.Redirect(w, r, authURL, http.StatusFound)
	}
}

// oidcIdentityHandler reports whether the caller has a linked SSO identity.
func oidcIdentityHandler(svc *oidc.Service, acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		linked, err := acct.HasOidcIdentity(r.Context(), u.ID)
		if err != nil {
			Problem(w, r, http.StatusInternalServerError, "Internal Server Error", "could not load SSO status")
			return
		}
		// configured reflects whether SSO is set up at all, so the UI can hide the
		// card entirely when there is no IdP.
		writeJSON(w, http.StatusOK, map[string]any{"linked": linked, "configured": svc.Configured()})
	}
}

// oidcUnlinkHandler disconnects the caller's SSO identity.
func oidcUnlinkHandler(acct *accounts.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		if err := acct.UnlinkOidcIdentity(r.Context(), u.ID); err != nil {
			if errors.Is(err, accounts.ErrOidcLastFactor) {
				Problem(w, r, http.StatusConflict, "Conflict", "set a password before disconnecting SSO so you are not locked out")
				return
			}
			Problem(w, r, http.StatusInternalServerError, "Internal Server Error", "could not disconnect SSO")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
