package jwt

import (
	"testing"
	"time"
)

// Token produced by the NestJS backend's jose signer (HS256, secret
// "test-jwt-secret", claims sub=user-1 sid=sess-1). If Go verifies it, the two
// services' access tokens are interchangeable.
const nodeToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEiLCJzaWQiOiJzZXNzLTEiLCJpYXQiOjE3ODE1OTYwMTQsImV4cCI6NDc4MTU5NjAxNH0.LdSuREoKHH-Blb1-akd0vd8GrDfoWk2ad38cQ1H_7xY"

func TestVerify_NodeToken(t *testing.T) {
	c, err := Verify(nodeToken, "test-jwt-secret")
	if err != nil {
		t.Fatalf("failed to verify a Node-issued token: %v", err)
	}
	if c.Sub != "user-1" || c.Sid != "sess-1" {
		t.Fatalf("claim mismatch: sub=%q sid=%q", c.Sub, c.Sid)
	}
	if _, err := Verify(nodeToken, "wrong-secret"); err == nil {
		t.Fatal("token verified under the wrong secret (must fail)")
	}
}

func TestSignVerify_RoundTrip(t *testing.T) {
	tok, err := Sign("u42", "s99", "sekret", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	c, err := Verify(tok, "sekret")
	if err != nil {
		t.Fatal(err)
	}
	if c.Sub != "u42" || c.Sid != "s99" {
		t.Fatalf("round-trip mismatch: %+v", c)
	}
}

func TestVerify_Expired(t *testing.T) {
	tok, err := Sign("u", "s", "sekret", -time.Minute) // already expired
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Verify(tok, "sekret"); err == nil {
		t.Fatal("expired token verified (must fail)")
	}
}
