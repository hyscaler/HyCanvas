package home

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/persistence"
)

func TestHome_DB(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping DB integration test")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, stripSchema(dsn))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer conn.Close(ctx)
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Seed owner + workspace (via signup) and two designs.
	acct := accounts.NewService(tx, "test-jwt-secret")
	email := "home-test+" + uuid.NewString() + "@example.com"
	user, ws, _, err := acct.Signup(ctx, email, "a-strong-password", "Home Tester")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	d1 := uuid.NewString()
	d2 := uuid.NewString()
	if _, err := tx.Exec(ctx, `INSERT INTO "designs" (id,"workspace_id",title,"updated_at") VALUES ($1,$2,'Alpha', now() - interval '1 hour')`, d1, ws.ID); err != nil {
		t.Fatalf("design1: %v", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO "designs" (id,"workspace_id",title,"updated_at") VALUES ($1,$2,'Beta', now())`, d2, ws.ID); err != nil {
		t.Fatalf("design2: %v", err)
	}

	h := NewService(tx, persistence.NewService(tx), acct)

	// Recent: both, newest (Beta) first.
	recent, err := h.Section(ctx, user.ID, ws.ID, "recent")
	if err != nil {
		t.Fatalf("recent: %v", err)
	}
	if len(recent) != 2 || recent[0].ID != d2 {
		t.Fatalf("recent order/count wrong: %+v", recent)
	}

	// Favorite Alpha; favorites section returns only it.
	starred, err := h.SetFavorite(ctx, user.ID, d1, true)
	if err != nil || !starred {
		t.Fatalf("favorite on: starred=%v err=%v", starred, err)
	}
	favs, err := h.Section(ctx, user.ID, ws.ID, "favorites")
	if err != nil || len(favs) != 1 || favs[0].ID != d1 || !favs[0].Starred {
		t.Fatalf("favorites wrong: %+v err=%v", favs, err)
	}

	// Search by title.
	res, err := h.Search(ctx, user.ID, ws.ID, "alph", nil)
	if err != nil || len(res) != 1 || res[0].ID != d1 {
		t.Fatalf("search wrong: %+v err=%v", res, err)
	}

	// Un-favorite (deterministic off).
	if starred, err := h.SetFavorite(ctx, user.ID, d1, false); err != nil || starred {
		t.Fatalf("favorite off: starred=%v err=%v", starred, err)
	}

	// A non-member cannot read the workspace's home.
	if _, err := h.Section(ctx, uuid.NewString(), ws.ID, "recent"); err == nil {
		t.Fatal("non-member must be forbidden")
	}
}

func stripSchema(dsn string) string {
	for _, sep := range []string{"?schema=", "&schema="} {
		if i := strings.Index(dsn, sep); i >= 0 {
			return dsn[:i]
		}
	}
	return dsn
}
