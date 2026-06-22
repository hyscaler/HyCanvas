// Package totp ports the @hc/authz MFA primitives (doc 15 FR-5): RFC 6238 TOTP
// over RFC 4226 HOTP (HMAC-SHA1, 6 digits, 30s step), plus single-use recovery
// codes. Pure functions; the backend stores the secret encrypted at rest and the
// recovery codes hashed. Verified byte-for-byte compatible with the Node
// implementation so a secret enrolled on one service verifies on the other.
package totp

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/binary"
	"net/url"
	"regexp"
	"strings"
)

const (
	stepSeconds = 30
	digits      = 6
	base32Alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567" // RFC 4648, no padding
)

func base32Encode(buf []byte) string {
	var bits, value uint
	var out strings.Builder
	for _, b := range buf {
		value = (value << 8) | uint(b)
		bits += 8
		for bits >= 5 {
			out.WriteByte(base32Alpha[(value>>(bits-5))&31])
			bits -= 5
		}
	}
	if bits > 0 {
		out.WriteByte(base32Alpha[(value<<(5-bits))&31])
	}
	return out.String()
}

func base32Decode(input string) ([]byte, bool) {
	clean := strings.ToUpper(strings.TrimRight(strings.Join(strings.Fields(input), ""), "="))
	var bits, value uint
	var out []byte
	for _, ch := range clean {
		idx := strings.IndexRune(base32Alpha, ch)
		if idx == -1 {
			return nil, false
		}
		value = (value << 5) | uint(idx)
		bits += 5
		if bits >= 8 {
			out = append(out, byte((value>>(bits-8))&0xff))
			bits -= 8
		}
	}
	return out, true
}

// GenerateSecret returns a fresh TOTP secret as a base32 string (default 20
// bytes / 160 bits, the RFC 6238 reference size).
func GenerateSecret() (string, error) {
	buf := make([]byte, 20)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base32Encode(buf), nil
}

// hotp computes the RFC 4226 HOTP for a counter.
func hotp(secret []byte, counter uint64) string {
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], counter)
	mac := hmac.New(sha1.New, secret)
	mac.Write(buf[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	bin := (uint32(sum[offset]&0x7f) << 24) |
		(uint32(sum[offset+1]) << 16) |
		(uint32(sum[offset+2]) << 8) |
		uint32(sum[offset+3])
	mod := uint32(1)
	for i := 0; i < digits; i++ {
		mod *= 10
	}
	code := bin % mod
	s := itoa(int(code))
	for len(s) < digits {
		s = "0" + s
	}
	return s
}

// Code returns the current TOTP code for a base32 secret at timeMs (ms epoch),
// mirroring the Node totp(secret, time). Returns ("", false) on a bad secret.
func Code(secret string, timeMs int64) (string, bool) {
	key, ok := base32Decode(secret)
	if !ok {
		return "", false
	}
	return hotp(key, uint64(timeMs/1000/stepSeconds)), true
}

var sixDigits = regexp.MustCompile(`^\d{6}$`)

// Verify checks a submitted code against the secret, accepting codes within
// `window` steps of `timeMs` (clock skew). timeMs is ms epoch.
func Verify(secret, code string, window int, timeMs int64) bool {
	normalized := strings.Join(strings.Fields(code), "")
	if !sixDigits.MatchString(normalized) {
		return false
	}
	key, ok := base32Decode(secret)
	if !ok {
		return false
	}
	counter := timeMs / 1000 / stepSeconds
	for i := -window; i <= window; i++ {
		c := counter + int64(i)
		if c < 0 {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(hotp(key, uint64(c))), []byte(normalized)) == 1 {
			return true
		}
	}
	return false
}

// GenerateRecoveryCodes returns n single-use recovery codes formatted like
// "abcd-efgh-ijkl". The caller hashes these before storage.
func GenerateRecoveryCodes(n int) ([]string, error) {
	codes := make([]string, 0, n)
	for i := 0; i < n; i++ {
		buf := make([]byte, 8)
		if _, err := rand.Read(buf); err != nil {
			return nil, err
		}
		raw := strings.ToLower(base32Encode(buf))[:12]
		codes = append(codes, raw[0:4]+"-"+raw[4:8]+"-"+raw[8:12])
	}
	return codes, nil
}

var nonAlnum = regexp.MustCompile(`[^a-z0-9]+`)

// NormalizeRecoveryCode lowercases a recovery code and strips separators.
func NormalizeRecoveryCode(code string) string {
	return nonAlnum.ReplaceAllString(strings.ToLower(code), "")
}

// OtpauthURL builds the otpauth:// URI authenticator apps consume.
func OtpauthURL(secret, label, issuer string) string {
	acct := url.QueryEscape(issuer) + ":" + url.QueryEscape(label)
	params := url.Values{}
	params.Set("secret", secret)
	params.Set("issuer", issuer)
	params.Set("algorithm", "SHA1")
	params.Set("digits", itoa(digits))
	params.Set("period", itoa(stepSeconds))
	return "otpauth://totp/" + acct + "?" + params.Encode()
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
