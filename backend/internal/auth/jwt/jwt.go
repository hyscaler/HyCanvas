// Package jwt signs and verifies HS256 access tokens compatible with the NestJS
// backend's jose-based tokens (doc 15): claims include sub (user id) and sid
// (session id); the algorithm is pinned to HS256 so a forged header cannot
// downgrade it. Tokens are interchangeable across the Go/Node split during the
// strangler migration because both use the same JWT_SECRET and claim shape.
package jwt

import (
	"errors"
	"time"

	jwtv5 "github.com/golang-jwt/jwt/v5"
)

// Claims are the access-token claims (a superset is tolerated on verify).
type Claims struct {
	Sub string // user id
	Sid string // session id (access tokens carry one; MFA challenge tokens do not)
	Aud string // audience (MFA challenge tokens set one; access tokens do not)
}

// Sign issues an HS256 token valid for ttl, mirroring signJwt().
func Sign(sub, sid, secret string, ttl time.Duration) (string, error) {
	now := time.Now()
	claims := jwtv5.MapClaims{
		"sub": sub,
		"sid": sid,
		"iat": now.Unix(),
		"exp": now.Add(ttl).Unix(),
	}
	return jwtv5.NewWithClaims(jwtv5.SigningMethodHS256, claims).SignedString([]byte(secret))
}

// SignAudience issues an HS256 token carrying an audience and no session id
// (used for the short-lived MFA challenge token, aud "mfa"), mirroring signJwt
// with an aud claim.
func SignAudience(sub, aud, secret string, ttl time.Duration) (string, error) {
	now := time.Now()
	claims := jwtv5.MapClaims{
		"sub": sub,
		"aud": aud,
		"iat": now.Unix(),
		"exp": now.Add(ttl).Unix(),
	}
	return jwtv5.NewWithClaims(jwtv5.SigningMethodHS256, claims).SignedString([]byte(secret))
}

// Verify validates an HS256 token (algorithm pinned) and returns its claims.
func Verify(token, secret string) (*Claims, error) {
	parsed, err := jwtv5.Parse(token, func(t *jwtv5.Token) (any, error) {
		if _, ok := t.Method.(*jwtv5.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return []byte(secret), nil
	}, jwtv5.WithValidMethods([]string{"HS256"}))
	if err != nil || !parsed.Valid {
		return nil, errors.New("invalid or expired token")
	}
	mc, ok := parsed.Claims.(jwtv5.MapClaims)
	if !ok {
		return nil, errors.New("invalid claims")
	}
	sub, _ := mc["sub"].(string)
	if sub == "" {
		return nil, errors.New("missing sub")
	}
	c := &Claims{Sub: sub}
	if sid, ok := mc["sid"].(string); ok {
		c.Sid = sid
	}
	if aud, ok := mc["aud"].(string); ok {
		c.Aud = aud
	}
	return c, nil
}
