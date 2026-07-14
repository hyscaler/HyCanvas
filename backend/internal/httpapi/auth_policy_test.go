package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/captcha"
	"hycanvas/backend/internal/oidc"
	"hycanvas/backend/internal/platform/config"
)

// A disabled method answers 403 before the handler touches the database, so the
// gate can be exercised with a nil-DB service.
func TestDisabledAuthRoutesReturn403(t *testing.T) {
	r := chi.NewRouter()
	r.Route("/api/v1", func(api chi.Router) {
		mountAuth(api, accounts.NewService(nil, "s"), false, config.AuthPolicy{}, nil) // all off, no captcha
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
		mountOIDC(api, oidc.NewService("s"), accounts.NewService(nil, "s"), false, policy, config.CaptchaConfig{})
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

// stubVerifier lets the guard test simulate accept/reject without a network call.
type stubVerifier struct{ err error }

func (s stubVerifier) Verify(_ context.Context, _, _ string) error { return s.err }

// With a CAPTCHA that rejects, a human-facing auth form is 403'd before the
// handler runs (nil-DB service proves the guard short-circuits).
func TestCaptchaGuardRejects(t *testing.T) {
	r := chi.NewRouter()
	r.Route("/api/v1", func(api chi.Router) {
		mountAuth(api, accounts.NewService(nil, "s"), false,
			config.AuthPolicy{PasswordLogin: true, PasswordSignup: true, MagicLinkLogin: true},
			stubVerifier{err: captcha.ErrFailed})
	})
	srv := httptest.NewServer(r)
	defer srv.Close()

	for _, path := range []string{"/api/v1/auth/login", "/api/v1/auth/signup", "/api/v1/auth/magic-link/request"} {
		resp, err := http.Post(srv.URL+path, "application/json", strings.NewReader(`{"email":"a@b.com","password":"pw12345678"}`))
		if err != nil {
			t.Fatalf("POST %s: %v", path, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Errorf("POST %s with a failing captcha = %d, want 403", path, resp.StatusCode)
		}
	}
}

// A nil verifier is a pass-through: the captcha guard adds no gate.
func TestCaptchaGuardNilIsPassthrough(t *testing.T) {
	r := chi.NewRouter()
	r.Route("/api/v1", func(api chi.Router) {
		mountAuth(api, accounts.NewService(nil, "s"), false, config.AuthPolicy{PasswordLogin: true}, nil)
	})
	srv := httptest.NewServer(r)
	defer srv.Close()
	// The route reaches the (nil-DB) handler and fails there, but NOT with the
	// captcha 403; a 403 would mean the nil guard wrongly blocked it.
	resp, err := http.Post(srv.URL+"/api/v1/auth/login", "application/json", strings.NewReader(`{"email":"a@b.com","password":"x"}`))
	if err == nil {
		defer resp.Body.Close()
		if resp.StatusCode == http.StatusForbidden {
			t.Error("a nil captcha verifier must not 403")
		}
	}
}
