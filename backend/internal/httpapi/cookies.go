package httpapi

import "net/http"

// Session cookie names + lifetimes, matching backend/src/accounts/cookies.ts.
const (
	accessCookie  = "hc_access"
	refreshCookie = "hc_refresh"
	accessMaxAge  = 15 * 60           // 15 minutes
	refreshMaxAge = 30 * 24 * 60 * 60 // 30 days
)

func setAuthCookies(w http.ResponseWriter, access, refresh string, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name: accessCookie, Value: access, Path: "/",
		HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode, MaxAge: accessMaxAge,
	})
	// An empty refresh means "keep the existing cookie": the tolerated
	// concurrent-refresh path mints only a new access token, so a racing tab
	// never overwrites the winning refresh cookie with a stale token.
	if refresh == "" {
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: refreshCookie, Value: refresh, Path: "/",
		HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode, MaxAge: refreshMaxAge,
	})
}

func clearAuthCookies(w http.ResponseWriter, secure bool) {
	for _, name := range []string{accessCookie, refreshCookie} {
		http.SetCookie(w, &http.Cookie{
			Name: name, Value: "", Path: "/",
			HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode, MaxAge: -1,
		})
	}
}
