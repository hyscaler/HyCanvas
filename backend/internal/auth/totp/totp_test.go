package totp

import (
	"strings"
	"testing"
)

func TestTOTPRoundTrip(t *testing.T) {
	secret, err := GenerateSecret()
	if err != nil {
		t.Fatalf("GenerateSecret: %v", err)
	}
	now := int64(1_700_000_000_000) // fixed ms epoch
	code := hotpAt(t, secret, now)
	if !Verify(secret, code, 1, now) {
		t.Fatalf("current code should verify")
	}
	// Within the +/-1 step window.
	if !Verify(secret, code, 1, now+29_000) {
		t.Fatalf("code should verify within skew window")
	}
	// Outside the window.
	if Verify(secret, code, 1, now+120_000) {
		t.Fatalf("code should not verify far outside the window")
	}
	// Non-6-digit input rejected.
	if Verify(secret, "12345", 1, now) || Verify(secret, "abcdef", 1, now) {
		t.Fatalf("malformed codes should be rejected")
	}
}

// hotpAt computes the expected code at a time via the package's own primitives.
func hotpAt(t *testing.T, secret string, timeMs int64) string {
	t.Helper()
	key, ok := base32Decode(secret)
	if !ok {
		t.Fatalf("decode secret")
	}
	return hotp(key, uint64(timeMs/1000/stepSeconds))
}

func TestRecoveryCodes(t *testing.T) {
	codes, err := GenerateRecoveryCodes(10)
	if err != nil || len(codes) != 10 {
		t.Fatalf("recovery codes: %v len=%d", err, len(codes))
	}
	for _, c := range codes {
		if len(strings.Split(c, "-")) != 3 {
			t.Fatalf("code format wrong: %q", c)
		}
		if NormalizeRecoveryCode(c) != strings.ReplaceAll(c, "-", "") {
			t.Fatalf("normalize wrong for %q", c)
		}
	}
}

func TestOtpauthURL(t *testing.T) {
	u := OtpauthURL("ABC234", "user@example.com", "HyCanvas")
	if !strings.HasPrefix(u, "otpauth://totp/") || !strings.Contains(u, "secret=ABC234") {
		t.Fatalf("otpauth url wrong: %s", u)
	}
}
