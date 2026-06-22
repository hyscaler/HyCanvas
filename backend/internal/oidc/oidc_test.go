package oidc

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

// stubIdP serves discovery, token, and userinfo for the OIDC flow test.
func stubIdP(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	var base string
	srv := httptest.NewServer(mux)
	base = srv.URL
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"authorization_endpoint": base + "/authorize",
			"token_endpoint":         base + "/token",
			"userinfo_endpoint":      base + "/userinfo",
		})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.Form.Get("code") != "good-code" || r.Form.Get("code_verifier") == "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"access_token": "at-123"})
	})
	mux.HandleFunc("/userinfo", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("authorization") != "Bearer at-123" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"sub": "sub-1", "email": "Sso@Example.com", "email_verified": true, "name": "SSO User"})
	})
	return srv
}

func TestOIDCFlow(t *testing.T) {
	srv := stubIdP(t)
	defer srv.Close()
	t.Setenv("OIDC_ISSUER", srv.URL)
	t.Setenv("OIDC_CLIENT_ID", "client-1")
	t.Setenv("OIDC_CLIENT_SECRET", "secret-1")
	t.Setenv("OIDC_REDIRECT_URI", "https://app.example.com/api/v1/auth/oidc/callback")

	svc := NewService("test-jwt-secret")
	if !svc.Configured() {
		t.Fatal("should be configured")
	}
	if len(svc.Providers()) != 1 {
		t.Fatalf("expected one provider: %v", svc.Providers())
	}

	authURL, cookie, err := svc.AuthURL()
	if err != nil {
		t.Fatalf("AuthURL: %v", err)
	}
	u, _ := url.Parse(authURL)
	if u.Query().Get("code_challenge_method") != "S256" || u.Query().Get("client_id") != "client-1" {
		t.Fatalf("auth url params wrong: %s", authURL)
	}
	state, verifier, ok := svc.ParseStateCookie(cookie)
	if !ok || state != u.Query().Get("state") || verifier == "" {
		t.Fatalf("state cookie round-trip failed")
	}
	// Tampered cookie rejected.
	if _, _, ok := svc.ParseStateCookie(cookie + "x"); ok {
		t.Fatal("tampered cookie should be rejected")
	}

	profile, err := svc.Exchange(context.Background(), "good-code", verifier)
	if err != nil {
		t.Fatalf("Exchange: %v", err)
	}
	if profile.Subject != "sub-1" || profile.Email != "sso@example.com" || !profile.EmailVerified {
		t.Fatalf("profile wrong: %+v", profile)
	}
	// A bad code fails the exchange.
	if _, err := svc.Exchange(context.Background(), "bad", verifier); err == nil {
		t.Fatal("bad code should fail exchange")
	}
}

func TestOIDCNotConfigured(t *testing.T) {
	t.Setenv("OIDC_ISSUER", "")
	t.Setenv("OIDC_CLIENT_ID", "")
	t.Setenv("OIDC_CLIENT_SECRET", "")
	svc := NewService("s")
	if svc.Configured() || len(svc.Providers()) != 0 {
		t.Fatal("should report not configured")
	}
	if _, _, err := svc.AuthURL(); err != ErrNotConfigured {
		t.Fatalf("AuthURL should be ErrNotConfigured, got %v", err)
	}
}
