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
)

const oidcStateCookie = "oc_oidc"

// mountOIDC attaches the SSO surface (doc 15): the public provider list and the
// authorization-code + PKCE redirect/callback. start sets a signed state cookie
// and redirects to the IdP; callback verifies it, exchanges the code, links the
// account (LoginWithOidc), sets the session cookies, and redirects to the app.
func mountOIDC(api chi.Router, svc *oidc.Service, acct *accounts.Service, secure bool) {
	api.Get("/auth/providers", oidcProvidersHandler(svc))
	api.Get("/auth/oidc/start", oidcStartHandler(svc, secure))
	api.Get("/auth/oidc/callback", oidcCallbackHandler(svc, acct, secure))
	// Connect/disconnect SSO for an already-authenticated user (link flow). The
	// callback above handles both sign-in and connect via the signed state.
	api.With(requireAuth(acct)).Get("/auth/oidc/link", oidcLinkStartHandler(svc, secure))
	api.With(requireAuth(acct)).Get("/auth/oidc/identity", oidcIdentityHandler(svc, acct))
	api.With(requireAuth(acct)).Delete("/auth/oidc/identity", oidcUnlinkHandler(acct))
}

func frontendURL() string {
	f := strings.TrimRight(os.Getenv("FRONTEND_URL"), "/")
	if f == "" {
		f = "http://localhost:3000"
	}
	return f
}

func oidcProvidersHandler(svc *oidc.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"providers": svc.Providers()})
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

func oidcCallbackHandler(svc *oidc.Service, acct *accounts.Service, secure bool) http.HandlerFunc {
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

		_, tokens, mfaToken, err := acct.LoginWithOidc(r.Context(), accounts.OidcProfile{
			Subject: profile.Subject, Email: profile.Email, EmailVerified: profile.EmailVerified, Name: profile.Name,
		}, r.UserAgent(), clientIP(r))
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
