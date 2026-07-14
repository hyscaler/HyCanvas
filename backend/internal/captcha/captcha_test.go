package captcha

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"hycanvas/backend/internal/platform/config"
)

func TestNewReturnsNilWhenDisabledOrUnknown(t *testing.T) {
	cases := []config.CaptchaConfig{
		{},                                    // nothing set
		{Provider: "turnstile"},               // missing keys
		{Provider: "turnstile", SiteKey: "s"}, // missing secret
		{Provider: "nope", SiteKey: "s", SecretKey: "x"}, // unknown provider
	}
	for _, c := range cases {
		if v := New(c); v != nil {
			t.Errorf("New(%+v) should be nil (disabled), got %T", c, v)
		}
	}
	for _, p := range []string{ProviderTurnstile, ProviderRecaptcha} {
		if New(config.CaptchaConfig{Provider: p, SiteKey: "s", SecretKey: "x"}) == nil {
			t.Errorf("New with configured %s should return a verifier", p)
		}
	}
}

// verifyWith points a verifier at a stub siteverify server returning `resp`.
func verifyWith(t *testing.T, scored bool, minScore float64, resp map[string]any) error {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("parse form: %v", err)
		}
		if r.FormValue("response") == "" {
			t.Error("siteverify called with no response token")
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()
	v := &httpVerifier{url: srv.URL, secret: "x", client: &http.Client{Timeout: 5 * time.Second}, scored: scored, minScore: minScore}
	return v.Verify(context.Background(), "a-token", "1.2.3.4")
}

func TestVerifySuccessAndFailure(t *testing.T) {
	if err := verifyWith(t, false, 0, map[string]any{"success": true}); err != nil {
		t.Errorf("success:true should pass, got %v", err)
	}
	if err := verifyWith(t, false, 0, map[string]any{"success": false}); err == nil {
		t.Error("success:false should fail")
	}
}

func TestRecaptchaScoreThreshold(t *testing.T) {
	// Above threshold passes, below fails, absent score (Turnstile / v2) passes.
	if err := verifyWith(t, true, 0.5, map[string]any{"success": true, "score": 0.9}); err != nil {
		t.Errorf("score 0.9 >= 0.5 should pass, got %v", err)
	}
	if err := verifyWith(t, true, 0.5, map[string]any{"success": true, "score": 0.3}); err == nil {
		t.Error("score 0.3 < 0.5 should fail")
	}
	if err := verifyWith(t, true, 0.5, map[string]any{"success": true}); err != nil {
		t.Errorf("absent score should pass, got %v", err)
	}
}

func TestVerifyEmptyTokenAndUnreachableFailClosed(t *testing.T) {
	v := &httpVerifier{url: "http://127.0.0.1:0/nope", secret: "x", client: &http.Client{Timeout: 500 * time.Millisecond}}
	if err := v.Verify(context.Background(), "", "ip"); err == nil {
		t.Error("empty token must fail closed")
	}
	if err := v.Verify(context.Background(), "tok", "ip"); err == nil {
		t.Error("an unreachable provider must fail closed")
	}
}
