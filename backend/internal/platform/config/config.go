// Package config loads typed service configuration from the environment. The Go
// service is the whole backend (REST under /api/v1, the /realtime WebSocket, and
// the statically-exported frontend), so it owns the application port and serves
// the UI directly.
package config

import (
	"errors"
	"os"
	"path/filepath"

	"github.com/joho/godotenv"
)

// ErrDatabaseURLMissing marks the one config failure that is not fatal for
// cmd/api: an unset DATABASE_URL means "unconfigured" and triggers the
// first-run setup wizard instead of an exit.
var ErrDatabaseURLMissing = errors.New("DATABASE_URL is required")

type Config struct {
	Port string
	// BindHost narrows the listen interface (e.g. 127.0.0.1 behind a reverse
	// proxy on the same host). Empty binds all interfaces.
	BindHost    string
	DatabaseURL string
	JWTSecret   string
	AISecret    string
	// PublicDir is the directory of the exported Next.js frontend to serve. Empty
	// disables static serving (API-only, e.g. local dev with `next dev`).
	PublicDir string
	// AutoMigrate applies pending SQL migrations on boot (default true).
	AutoMigrate bool
	// Auth gates which sign-in methods and account-creation paths are available.
	Auth AuthPolicy
}

// AuthPolicy is the per-instance switchboard for authentication. Each method has
// an independent login and signup toggle, so an operator can run, for example,
// OIDC-only (password + magic-link off) without a code change. The zero value is
// all-off; Load() fills it from env with defaults that preserve prior behavior.
type AuthPolicy struct {
	PasswordLogin   bool // AUTH_PASSWORD_LOGIN_ENABLED   (default true)
	PasswordSignup  bool // AUTH_PASSWORD_SIGNUP_ENABLED  (default true)
	MagicLinkLogin  bool // AUTH_MAGICLINK_LOGIN_ENABLED  (default true)
	MagicLinkSignup bool // AUTH_MAGICLINK_SIGNUP_ENABLED (default false; creates accounts)
	OidcLogin       bool // AUTH_OIDC_LOGIN_ENABLED       (default true; effective only when OIDC configured)
	OidcSignup      bool // AUTH_OIDC_SIGNUP_ENABLED      (default true; effective only when OIDC configured)
}

// Load reads and validates configuration. DATABASE_URL is required.
func Load() (Config, error) {
	loadDotEnv()
	c := Config{
		// PORT is the conventional deploy variable (compose, PaaS); GO_API_PORT
		// remains accepted for continuity. Defaults to 8005, the single app port.
		Port:        getenv("PORT", getenv("GO_API_PORT", "8005")),
		BindHost:    os.Getenv("BIND_HOST"),
		DatabaseURL: os.Getenv("DATABASE_URL"),
		JWTSecret:   os.Getenv("JWT_SECRET"),
		AISecret:    os.Getenv("AI_SECRET"),
		PublicDir:   getenv("PUBLIC_DIR", "./public"),
		AutoMigrate: os.Getenv("DB_AUTO_MIGRATE") != "false",
		Auth: AuthPolicy{
			PasswordLogin:   envBool("AUTH_PASSWORD_LOGIN_ENABLED", true),
			PasswordSignup:  envBool("AUTH_PASSWORD_SIGNUP_ENABLED", true),
			MagicLinkLogin:  envBool("AUTH_MAGICLINK_LOGIN_ENABLED", true),
			MagicLinkSignup: envBool("AUTH_MAGICLINK_SIGNUP_ENABLED", false),
			OidcLogin:       envBool("AUTH_OIDC_LOGIN_ENABLED", true),
			OidcSignup:      envBool("AUTH_OIDC_SIGNUP_ENABLED", true),
		},
	}
	if c.DatabaseURL == "" {
		return c, ErrDatabaseURLMissing
	}
	return c, nil
}

// envBool reads a boolean env var. Only the exact strings "true" and "false"
// flip it; anything else (including empty) keeps the default, so a partially set
// deployment never silently disables a method by typo.
func envBool(key string, def bool) bool {
	switch os.Getenv(key) {
	case "true":
		return true
	case "false":
		return false
	default:
		return def
	}
}

// loadDotEnv loads a .env file if one is present, so the production binary runs
// standalone (`./dist/hycanvas`) with no Node dotenv-cli wrapper, matching
// how it runs under Docker and the service daemon. It checks the working directory then the
// parent (so running from the repo root or from dist/ both find the root .env).
// godotenv never overrides variables already set in the environment, so a real
// deployment (Docker/CI, which inject env directly) is unaffected even if a
// stray .env exists. Absent .env is a no-op.
func loadDotEnv() {
	for _, p := range []string{".env", filepath.Join("..", ".env")} {
		if _, err := os.Stat(p); err == nil {
			_ = godotenv.Load(p)
			return
		}
	}
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
