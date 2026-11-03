package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"hycanvas/backend/internal/accounts"
)

// A sign-in refused because the account is deactivated must say so with its
// own code: falling through to the generic paths answered 500 ("sign-in is
// temporarily unavailable") for a password login and 401 ("invalid or expired
// link") for a magic link, which sends the person hunting for the wrong fix.
func TestSignInRefusedAnswersAccountDisabled(t *testing.T) {
	for _, err := range []error{accounts.ErrAccountDisabled, fmt.Errorf("wrapped: %w", accounts.ErrAccountDisabled)} {
		rec := httptest.NewRecorder()
		if !signInRefused(rec, httptest.NewRequest(http.MethodPost, "/x", nil), err) {
			t.Fatalf("%v: not handled", err)
		}
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%v: status %d, want 403", err, rec.Code)
		}
		var body struct {
			Code string `json:"code"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if body.Code != "account_disabled" {
			t.Fatalf("%v: code %q, want account_disabled", err, body.Code)
		}
	}
	// Every other error is left to the handler's own mapping.
	rec := httptest.NewRecorder()
	if signInRefused(rec, httptest.NewRequest(http.MethodPost, "/x", nil), errors.New("other")) {
		t.Fatal("an unrelated error was handled")
	}
	if rec.Body.Len() != 0 {
		t.Fatal("an unrelated error wrote a response")
	}
}
