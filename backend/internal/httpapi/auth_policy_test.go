package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/oidc"
	"hycanvas/backend/internal/platform/config"
)

// A disabled method answers 403 before the handler touches the database, so the
// gate can be exercised with a nil-DB service.
func TestDisabledAuthRoutesReturn403(t *testing.T) {
	r := chi.NewRouter()
	r.Route("/api/v1", func(api chi.Router) {
		mountAuth(api, accounts.NewService(nil, "s"), false, config.AuthPolicy{}) // all off
	})
	srv := httptest.NewServer(r)
	defer srv.Close()

	for _, path := range []string{
		"/api/v1/auth/signup",
		"/api/v1/auth/login",
		"/api/v1/auth/password-reset/request",
		"/api/v1/auth/password-reset",
		"/api/v1/auth/magic-link/request",
		"/api/v1/auth/magic-link",
	} {
		resp, err := http.Post(srv.URL+path, "application/json", strings.NewReader(`{"email":"a@b.com"}`))
		if err != nil {
			t.Fatalf("POST %s: %v", path, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Errorf("POST %s with all methods disabled = %d, want 403", path, resp.StatusCode)
		}
	}
}

// The providers endpoint doubles as the auth-config endpoint the sign-in page
// reads: it reports the full method policy so the UI shows only allowed methods.
func TestProvidersEndpointReportsPolicy(t *testing.T) {
	policy := config.AuthPolicy{PasswordLogin: false, MagicLinkLogin: true, OidcLogin: true, OidcSignup: true}
	r := chi.NewRouter()
	r.Route("/api/v1", func(api chi.Router) {
		mountOIDC(api, oidc.NewService("s"), accounts.NewService(nil, "s"), false, policy)
	})
	srv := httptest.NewServer(r)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/v1/auth/providers")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct {
		Policy map[string]bool `json:"policy"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Policy["passwordLogin"] {
		t.Error("policy should report passwordLogin=false")
	}
	if !body.Policy["magicLinkLogin"] || !body.Policy["oidcSignup"] {
		t.Error("policy should report the enabled methods true")
	}
}
