package httpapi

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// The test endpoint's body is optional (#46): an empty body keeps its original
// meaning, "test what is stored", which the dashboard's status check and any
// API client written before the candidate test still rely on.
func TestDecodeCandidate(t *testing.T) {
	var b aiConfigBody
	present, err := decodeCandidate(httptest.NewRequest("POST", "/", strings.NewReader("")), &b)
	if err != nil || present {
		t.Fatalf("empty body: present=%v err=%v, want stored-config test", present, err)
	}
	present, err = decodeCandidate(httptest.NewRequest("POST", "/", strings.NewReader(`{"provider":"custom","apiKey":"k"}`)), &b)
	if err != nil || !present || b.Provider != "custom" || b.APIKey != "k" {
		t.Fatalf("candidate body: present=%v err=%v body=%+v", present, err, b)
	}
	if _, err := decodeCandidate(httptest.NewRequest("POST", "/", strings.NewReader(`{"provider":`)), &b); err == nil {
		t.Fatal("a malformed body must be rejected, not treated as empty")
	}
}
