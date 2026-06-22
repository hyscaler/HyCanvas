// Package config loads typed service configuration from the environment. The Go
// service is the whole backend (REST under /api/v1, the /realtime WebSocket, and
// the statically-exported frontend), so it owns the application port and serves
// the UI directly.
package config

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/joho/godotenv"
)

type Config struct {
	Port        string
	DatabaseURL string
	JWTSecret   string
	AISecret    string
	// PublicDir is the directory of the exported Next.js frontend to serve. Empty
	// disables static serving (API-only, e.g. local dev with `next dev`).
	PublicDir string
	// AutoMigrate applies pending SQL migrations on boot (default true).
	AutoMigrate bool
}

// Load reads and validates configuration. DATABASE_URL is required.
func Load() (Config, error) {
	loadDotEnv()
	c := Config{
		// PORT is the conventional deploy variable (compose, PM2, PaaS); GO_API_PORT
		// remains accepted for continuity. Defaults to 8005, the single app port.
		Port:        getenv("PORT", getenv("GO_API_PORT", "8005")),
		DatabaseURL: os.Getenv("DATABASE_URL"),
		JWTSecret:   os.Getenv("JWT_SECRET"),
		AISecret:    os.Getenv("AI_SECRET"),
		PublicDir:   getenv("PUBLIC_DIR", "./public"),
		AutoMigrate: os.Getenv("DB_AUTO_MIGRATE") != "false",
	}
	if c.DatabaseURL == "" {
		return c, fmt.Errorf("DATABASE_URL is required")
	}
	return c, nil
}

// loadDotEnv loads a .env file if one is present, so the production binary runs
// standalone (`./dist/hycanvas`) with no Node dotenv-cli wrapper, matching
// how it runs under Docker and PM2. It checks the working directory then the
// parent (so running from the repo root or from dist/ both find the root .env).
// godotenv never overrides variables already set in the environment, so a real
// deployment (Docker/PM2/CI, which inject env directly) is unaffected even if a
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
