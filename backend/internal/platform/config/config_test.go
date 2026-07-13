package config

import "testing"

func TestEnvBoolDefaultsAndOverrides(t *testing.T) {
	cases := []struct {
		set  string // "" means unset
		def  bool
		want bool
	}{
		{"", true, true},
		{"", false, false},
		{"true", false, true},
		{"false", true, false},
		{"yes", true, true},    // junk keeps the default
		{"0", true, true},      // only "true"/"false" flip it
		{"TRUE", false, false}, // case-sensitive by design
	}
	for _, c := range cases {
		if c.set == "" {
			t.Setenv("AUTH_TEST_FLAG", "")
		} else {
			t.Setenv("AUTH_TEST_FLAG", c.set)
		}
		if got := envBool("AUTH_TEST_FLAG", c.def); got != c.want {
			t.Errorf("envBool(set=%q, def=%v) = %v, want %v", c.set, c.def, got, c.want)
		}
	}
}

func TestLoadAuthPolicyDefaultsPreserveBehavior(t *testing.T) {
	// With nothing set, every method except magic-link signup is on, matching the
	// behavior before the feature existed.
	t.Setenv("DATABASE_URL", "postgres://x") // satisfy the required check
	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	p := c.Auth
	if !(p.PasswordLogin && p.PasswordSignup && p.MagicLinkLogin && p.OidcLogin && p.OidcSignup) {
		t.Errorf("default policy should have those five on: %+v", p)
	}
	if p.MagicLinkSignup {
		t.Error("magic-link signup should default off (new behavior)")
	}
}

func TestLoadAuthPolicyOidcOnly(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x")
	t.Setenv("AUTH_PASSWORD_LOGIN_ENABLED", "false")
	t.Setenv("AUTH_PASSWORD_SIGNUP_ENABLED", "false")
	t.Setenv("AUTH_MAGICLINK_LOGIN_ENABLED", "false")
	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	p := c.Auth
	if p.PasswordLogin || p.PasswordSignup || p.MagicLinkLogin {
		t.Errorf("OIDC-only config should disable password + magic-link login: %+v", p)
	}
	if !p.OidcLogin || !p.OidcSignup {
		t.Errorf("OIDC-only config should leave OIDC on: %+v", p)
	}
}
