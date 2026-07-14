// Package captcha verifies a CAPTCHA response against a provider's siteverify
// endpoint, so the auth forms can reject automated abuse. Two providers are
// supported, selected by config: Cloudflare Turnstile and Google reCAPTCHA
// (v2 checkbox and v3 score both use the same verify shape).
//
// The design is fail-closed: a missing or invalid token, or any error talking to
// the provider, is a failure. A CAPTCHA is a security control the operator opted
// into, so "we could not confirm you are human" must not fall through to "let
// them in". The cost is that a provider outage blocks the gated forms; that
// tradeoff is documented so it is a deliberate choice.
package captcha

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"hycanvas/backend/internal/platform/config"
)

// ErrFailed marks a token that did not verify (absent, malformed, expired,
// already used, or below the reCAPTCHA score threshold).
var ErrFailed = errors.New("captcha verification failed")

// Verifier checks a CAPTCHA response token. remoteIP is the client address, sent
// to the provider as an extra signal (best-effort; providers tolerate it empty).
type Verifier interface {
	Verify(ctx context.Context, token, remoteIP string) error
}

const (
	ProviderTurnstile = "turnstile"
	ProviderRecaptcha = "recaptcha"

	turnstileVerifyURL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
	recaptchaVerifyURL = "https://www.google.com/recaptcha/api/siteverify"
)

// New builds a Verifier from config, or returns nil when CAPTCHA is disabled or
// the provider is unrecognized. A nil Verifier means "no gate" to callers.
func New(c config.CaptchaConfig) Verifier {
	if !c.Enabled() {
		return nil
	}
	client := &http.Client{Timeout: 5 * time.Second}
	switch strings.ToLower(c.Provider) {
	case ProviderTurnstile:
		return &httpVerifier{url: turnstileVerifyURL, secret: c.SecretKey, client: client}
	case ProviderRecaptcha:
		return &httpVerifier{url: recaptchaVerifyURL, secret: c.SecretKey, client: client, minScore: c.MinScore, scored: true}
	default:
		return nil
	}
}

// httpVerifier serves both providers: they share the POST-form siteverify shape
// (secret + response + remoteip) and a JSON reply with a "success" boolean.
// reCAPTCHA additionally returns a "score" that v3 gates on; Turnstile and
// reCAPTCHA v2 omit it, so an absent score passes.
type httpVerifier struct {
	url      string
	secret   string
	client   *http.Client
	minScore float64
	scored   bool
}

type verifyResponse struct {
	Success    bool     `json:"success"`
	Score      *float64 `json:"score"`
	ErrorCodes []string `json:"error-codes"`
}

func (v *httpVerifier) Verify(ctx context.Context, token, remoteIP string) error {
	if strings.TrimSpace(token) == "" {
		return ErrFailed
	}
	form := url.Values{"secret": {v.secret}, "response": {token}}
	if remoteIP != "" {
		form.Set("remoteip", remoteIP)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, v.url, strings.NewReader(form.Encode()))
	if err != nil {
		return ErrFailed
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := v.client.Do(req)
	if err != nil {
		return ErrFailed // provider unreachable: fail closed
	}
	defer func() { _ = resp.Body.Close() }()

	var out verifyResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return ErrFailed
	}
	if !out.Success {
		return ErrFailed
	}
	// reCAPTCHA v3 returns a score in [0,1]; reject when it is below the operator's
	// threshold. An absent score (Turnstile, reCAPTCHA v2) is a plain pass.
	if v.scored && out.Score != nil && *out.Score < v.minScore {
		return ErrFailed
	}
	return nil
}
