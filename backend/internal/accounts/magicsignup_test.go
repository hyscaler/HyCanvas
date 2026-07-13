package accounts

import (
	"strings"
	"testing"
)

// The signup token must round-trip its email and reject tampering, a wrong
// secret, and a foreign prefix. No DB: this is the pure signing layer.
func TestMagicSignupTokenRoundTrip(t *testing.T) {
	svc := NewService(nil, "a-test-secret")
	email := "new.user@example.com"

	tok := svc.signMagicSignupToken(email)
	if !strings.HasPrefix(tok, magicSignupPrefix) {
		t.Fatalf("token missing prefix: %q", tok)
	}
	got, ok := svc.parseMagicSignupToken(tok)
	if !ok || got != email {
		t.Fatalf("round-trip failed: ok=%v got=%q want=%q", ok, got, email)
	}
}

func TestMagicSignupTokenRejectsTampering(t *testing.T) {
	svc := NewService(nil, "a-test-secret")
	tok := svc.signMagicSignupToken("victim@example.com")

	// Flip a character in the payload; the signature must no longer verify.
	bad := []byte(tok)
	bad[len(magicSignupPrefix)+2] ^= 0x01
	if _, ok := svc.parseMagicSignupToken(string(bad)); ok {
		t.Error("tampered token verified")
	}

	// A token signed with a different secret must not verify here.
	other := NewService(nil, "different-secret").signMagicSignupToken("victim@example.com")
	if _, ok := svc.parseMagicSignupToken(other); ok {
		t.Error("token from a foreign secret verified")
	}

	// A stored (non-signup) magic token shape is not a signup token.
	if _, ok := svc.parseMagicSignupToken("11111111-2222-3333-4444-555555555555.66666666"); ok {
		t.Error("a stored-token shape parsed as a signup token")
	}
}
