package accounts

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"strconv"
	"strings"
	"time"
)

// Magic-link signup tokens (AUTH_MAGICLINK_SIGNUP_ENABLED).
//
// A sign-in magic link is a random token stored in `verification_tokens`, keyed
// to an existing user. A sign-up link has no user yet, so it cannot use that
// table. Instead it is a self-contained, HMAC-signed token carrying the email
// and an expiry: nothing is written until the link is redeemed, so an
// un-clicked link leaves no account and cannot squat an address.
//
// Replay is safe by construction: the first redeem creates the account and signs
// in; a second redeem finds the now-existing account and simply signs in. The
// short TTL bounds the window regardless.

const magicSignupPrefix = "ms1."

// signMagicSignupToken builds a signed token for `email`, valid for the magic
// TTL. Format: ms1.<b64url(email|expiryUnix)>.<b64url(hmac)>.
func (s *Service) signMagicSignupToken(email string) string {
	email = strings.ToLower(strings.TrimSpace(email))
	exp := time.Now().Add(ttlFor("magic")).Unix()
	payload := email + "|" + strconv.FormatInt(exp, 10)
	body := base64.RawURLEncoding.EncodeToString([]byte(payload))
	return magicSignupPrefix + body + "." + base64.RawURLEncoding.EncodeToString(s.magicSignupMAC(body))
}

// parseMagicSignupToken verifies a signup token and returns its email. ok is
// false for a malformed signature, a non-signup token, or an expired one.
func (s *Service) parseMagicSignupToken(raw string) (email string, ok bool) {
	if !strings.HasPrefix(raw, magicSignupPrefix) {
		return "", false
	}
	parts := strings.SplitN(strings.TrimPrefix(raw, magicSignupPrefix), ".", 2)
	if len(parts) != 2 {
		return "", false
	}
	body, sig := parts[0], parts[1]
	want := s.magicSignupMAC(body)
	got, err := base64.RawURLEncoding.DecodeString(sig)
	if err != nil || !hmac.Equal(got, want) {
		return "", false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil {
		return "", false
	}
	fields := strings.SplitN(string(decoded), "|", 2)
	if len(fields) != 2 {
		return "", false
	}
	exp, err := strconv.ParseInt(fields[1], 10, 64)
	if err != nil || time.Now().Unix() > exp {
		return "", false
	}
	return fields[0], true
}

func (s *Service) magicSignupMAC(body string) []byte {
	m := hmac.New(sha256.New, []byte(s.jwtSecret))
	m.Write([]byte("magic-signup:" + body))
	return m.Sum(nil)
}
