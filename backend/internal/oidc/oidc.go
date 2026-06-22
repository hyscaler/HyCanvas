// Package oidc ports the NestJS OIDC SSO flow (doc 15): the authorization-code +
// PKCE dance against any OIDC provider configured via env (OIDC_ISSUER /
// OIDC_CLIENT_ID / OIDC_CLIENT_SECRET). It performs discovery, builds the
// authorize redirect with a signed state+verifier cookie, and exchanges the code
// for a profile via the token + userinfo endpoints. Account linking + session
// issuance live in internal/accounts (LoginWithOidc).
package oidc

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// Errors map to a login redirect / 400 at the HTTP layer.
var (
	ErrNotConfigured = errors.New("SSO is not configured")
	ErrDiscovery     = errors.New("OIDC discovery failed")
	ErrExchange      = errors.New("OIDC token exchange failed")
)

// Profile is the resolved identity from the userinfo endpoint.
type Profile struct {
	Subject       string
	Email         string
	EmailVerified bool
	Name          string
}

type config struct {
	issuer       string
	clientID     string
	clientSecret string
	redirectURI  string
	scopes       string
}

type discovery struct {
	AuthorizationEndpoint string `json:"authorization_endpoint"`
	TokenEndpoint         string `json:"token_endpoint"`
	UserinfoEndpoint      string `json:"userinfo_endpoint"`
}

// Service is the OIDC flow.
type Service struct {
	jwtSecret string
	client    *http.Client
	mu        sync.Mutex
	disc      *discovery
}

// NewService wires the OIDC service; jwtSecret signs the state cookie.
func NewService(jwtSecret string) *Service {
	return &Service{jwtSecret: jwtSecret, client: &http.Client{Timeout: 15 * time.Second}}
}

func (s *Service) config() *config {
	issuer := strings.TrimRight(strings.TrimSpace(os.Getenv("OIDC_ISSUER")), "/")
	clientID := strings.TrimSpace(os.Getenv("OIDC_CLIENT_ID"))
	clientSecret := strings.TrimSpace(os.Getenv("OIDC_CLIENT_SECRET"))
	if issuer == "" || clientID == "" || clientSecret == "" {
		return nil
	}
	appURL := strings.TrimRight(os.Getenv("APP_URL"), "/")
	if appURL == "" {
		appURL = "http://localhost:8090"
	}
	redirect := strings.TrimSpace(os.Getenv("OIDC_REDIRECT_URI"))
	if redirect == "" {
		redirect = appURL + "/api/v1/auth/oidc/callback"
	}
	scopes := strings.TrimSpace(os.Getenv("OIDC_SCOPES"))
	if scopes == "" {
		scopes = "openid email profile"
	}
	return &config{issuer: issuer, clientID: clientID, clientSecret: clientSecret, redirectURI: redirect, scopes: scopes}
}

// Configured reports whether SSO is enabled (all env present).
func (s *Service) Configured() bool { return s.config() != nil }

// Providers is the public provider list the login page gates on.
func (s *Service) Providers() []map[string]string {
	if s.config() == nil {
		return []map[string]string{}
	}
	label := strings.TrimSpace(os.Getenv("OIDC_LABEL"))
	if label == "" {
		label = "SSO"
	}
	return []map[string]string{{"id": "oidc", "label": label}}
}

func (s *Service) discover(c *config) (*discovery, error) {
	s.mu.Lock()
	if s.disc != nil {
		d := s.disc
		s.mu.Unlock()
		return d, nil
	}
	s.mu.Unlock()
	res, err := s.client.Get(c.issuer + "/.well-known/openid-configuration")
	if err != nil || res.StatusCode != http.StatusOK {
		if res != nil {
			res.Body.Close()
		}
		return nil, ErrDiscovery
	}
	defer res.Body.Close()
	var d discovery
	if err := json.NewDecoder(res.Body).Decode(&d); err != nil {
		return nil, ErrDiscovery
	}
	if d.AuthorizationEndpoint == "" || d.TokenEndpoint == "" || d.UserinfoEndpoint == "" {
		return nil, ErrDiscovery
	}
	s.mu.Lock()
	s.disc = &d
	s.mu.Unlock()
	return &d, nil
}

func (s *Service) sign(body string) string {
	mac := hmac.New(sha256.New, []byte(s.jwtSecret))
	mac.Write([]byte(body))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

type statePayload struct {
	State    string `json:"state"`
	Verifier string `json:"verifier"`
	Exp      int64  `json:"exp"`
}

// ParseStateCookie verifies + decodes the signed state cookie.
func (s *Service) ParseStateCookie(cookie string) (state, verifier string, ok bool) {
	parts := strings.SplitN(cookie, ".", 2)
	if len(parts) != 2 {
		return "", "", false
	}
	body, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || s.sign(string(body)) != parts[1] {
		return "", "", false
	}
	var d statePayload
	if json.Unmarshal(body, &d) != nil || d.State == "" || d.Verifier == "" || d.Exp < time.Now().UnixMilli() {
		return "", "", false
	}
	return d.State, d.Verifier, true
}

// AuthURL builds the authorize redirect URL + the signed state cookie value.
func (s *Service) AuthURL() (authURL, cookie string, err error) {
	c := s.config()
	if c == nil {
		return "", "", ErrNotConfigured
	}
	d, err := s.discover(c)
	if err != nil {
		return "", "", err
	}
	state := randB64(16)
	verifier := randB64(32)
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	body, _ := json.Marshal(statePayload{State: state, Verifier: verifier, Exp: time.Now().Add(10 * time.Minute).UnixMilli()})
	cookie = base64.RawURLEncoding.EncodeToString(body) + "." + s.sign(string(body))

	u, _ := url.Parse(d.AuthorizationEndpoint)
	q := u.Query()
	q.Set("client_id", c.clientID)
	q.Set("redirect_uri", c.redirectURI)
	q.Set("response_type", "code")
	q.Set("scope", c.scopes)
	q.Set("state", state)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	u.RawQuery = q.Encode()
	return u.String(), cookie, nil
}

// Exchange swaps the auth code (+ PKCE verifier) for the userinfo profile.
func (s *Service) Exchange(ctx context.Context, code, verifier string) (Profile, error) {
	c := s.config()
	if c == nil {
		return Profile{}, ErrNotConfigured
	}
	d, err := s.discover(c)
	if err != nil {
		return Profile{}, err
	}
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", c.redirectURI)
	form.Set("client_id", c.clientID)
	form.Set("client_secret", c.clientSecret)
	form.Set("code_verifier", verifier)

	tokReq, _ := http.NewRequestWithContext(ctx, http.MethodPost, d.TokenEndpoint, strings.NewReader(form.Encode()))
	tokReq.Header.Set("content-type", "application/x-www-form-urlencoded")
	tokReq.Header.Set("accept", "application/json")
	tokRes, err := s.client.Do(tokReq)
	if err != nil || tokRes.StatusCode != http.StatusOK {
		if tokRes != nil {
			tokRes.Body.Close()
		}
		return Profile{}, ErrExchange
	}
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	dec := json.NewDecoder(io.LimitReader(tokRes.Body, 1<<20))
	_ = dec.Decode(&tok)
	tokRes.Body.Close()
	if tok.AccessToken == "" {
		return Profile{}, ErrExchange
	}

	uiReq, _ := http.NewRequestWithContext(ctx, http.MethodGet, d.UserinfoEndpoint, nil)
	uiReq.Header.Set("authorization", "Bearer "+tok.AccessToken)
	uiRes, err := s.client.Do(uiReq)
	if err != nil || uiRes.StatusCode != http.StatusOK {
		if uiRes != nil {
			uiRes.Body.Close()
		}
		return Profile{}, ErrExchange
	}
	defer uiRes.Body.Close()
	var ui struct {
		Sub           string `json:"sub"`
		Email         string `json:"email"`
		EmailVerified bool   `json:"email_verified"`
		Name          string `json:"name"`
	}
	if json.NewDecoder(io.LimitReader(uiRes.Body, 1<<20)).Decode(&ui) != nil || ui.Sub == "" {
		return Profile{}, ErrExchange
	}
	return Profile{Subject: ui.Sub, Email: strings.ToLower(strings.TrimSpace(ui.Email)), EmailVerified: ui.EmailVerified, Name: ui.Name}, nil
}

func randB64(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}
