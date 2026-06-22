// Command migrate applies pending SQL migrations and exits. The API server also
// migrates on boot (DB_AUTO_MIGRATE), so this is for explicit, standalone runs
// (CI, manual deploys): `go run ./cmd/migrate`.
package main

import (
	"context"
	"log"
	"os"

	"hycanvas/backend/internal/migrations"
	"hycanvas/backend/internal/platform/config"
	"hycanvas/backend/internal/platform/db"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	ctx := context.Background()
	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("connect: %v", err)
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool, migrations.FS); err != nil {
		log.Fatalf("migrate: %v", err)
	}
	log.Println("migrations up to date")
	os.Exit(0)
}
