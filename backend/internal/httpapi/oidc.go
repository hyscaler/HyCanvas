package httpapi

import (
	"net/http"
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
		savedState, verifier, ok := svc.ParseStateCookie(c.Value)
		if !ok || savedState != state {
			fail()
			return
		}
		profile, err := svc.Exchange(r.Context(), code, verifier)
		if err != nil {
			fail()
			return
		}
		_, tokens, err := acct.LoginWithOidc(r.Context(), accounts.OidcProfile{
			Subject: profile.Subject, Email: profile.Email, EmailVerified: profile.EmailVerified, Name: profile.Name,
		}, r.UserAgent(), clientIP(r))
		if err != nil {
			fail()
			return
		}
		setAuthCookies(w, tokens.Access, tokens.Refresh, secure)
		http.Redirect(w, r, front+"/dashboard", http.StatusFound)
	}
}
