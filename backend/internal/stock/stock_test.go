package stock

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/accounts"
)

func stripSchema(dsn string) string {
	for _, sep := range []string{"?schema=", "&schema="} {
		if i := strings.Index(dsn, sep); i >= 0 {
			return dsn[:i]
		}
	}
	return dsn
}

func TestSeedAndSearch(t *testing.T) {
	if len(seed.Stock) < 10 || len(seed.Collections) < 1 {
		t.Fatalf("seed not loaded: %d assets, %d collections", len(seed.Stock), len(seed.Collections))
	}
	// Empty query returns everything.
	if got := searchStock(seed.Stock, Query{}); len(got) != len(seed.Stock) {
		t.Fatalf("empty query should match all: %d", len(got))
	}
	// A kind filter narrows results and only returns that kind.
	photos := searchStock(seed.Stock, Query{Kind: "photo"})
	if len(photos) == 0 {
		t.Fatal("expected some photo assets")
	}
	for _, a := range photos {
		if str(a["kind"]) != "photo" {
			t.Fatalf("kind filter leaked: %v", a["kind"])
		}
	}
	// proxyURLAllowed: allowlisted https host ok; others rejected.
	s := &Service{}
	if !s.proxyURLAllowed("https://picsum.photos/id/1/600") {
		t.Fatal("allowlisted host should pass")
	}
	if s.proxyURLAllowed("https://evil.example.com/x.png") || s.proxyURLAllowed("http://picsum.photos/x") {
		t.Fatal("non-allowlisted host / non-https should be rejected")
	}
}

func TestStock_DB(t *testing.T) {
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

	acct := accounts.NewService(tx, "test-jwt-secret")
	owner, _, _, err := acct.Signup(ctx, "stock+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	svc := NewService(tx)
	id := seed.Stock[0]["id"].(string)

	// Toggle favorite on, then it appears in favorites + flags search results.
	on, err := svc.ToggleFavorite(ctx, owner.ID, id)
	if err != nil || !on {
		t.Fatalf("toggle on: %v %v", on, err)
	}
	favs, _ := svc.ListFavorites(ctx, owner.ID)
	if len(favs) != 1 || favs[0]["id"] != id || favs[0]["favorited"] != true {
		t.Fatalf("favorites wrong: %+v", favs)
	}
	res, _ := svc.Search(ctx, Query{}, owner.ID)
	for _, a := range res {
		if a["id"] == id && a["favorited"] != true {
			t.Fatalf("search should flag the favorite")
		}
	}
	// Toggle off.
	if off, _ := svc.ToggleFavorite(ctx, owner.ID, id); off {
		t.Fatal("toggle off should return false")
	}
	if favs, _ := svc.ListFavorites(ctx, owner.ID); len(favs) != 0 {
		t.Fatalf("favorites should be empty after toggle off")
	}

	// Recents: record two. (The test runs in one transaction, so now() is frozen
	// and usedAt ties; assert membership, not order, which the runtime gets right.)
	id2 := seed.Stock[1]["id"].(string)
	_ = svc.RecordRecent(ctx, owner.ID, id)
	_ = svc.RecordRecent(ctx, owner.ID, id2)
	recents, _ := svc.ListRecents(ctx, owner.ID)
	got := map[string]bool{}
	for _, a := range recents {
		got[a["id"].(string)] = true
	}
	if len(recents) != 2 || !got[id] || !got[id2] {
		t.Fatalf("recents wrong: %+v", recents)
	}
	// Unknown id rejected.
	if err := svc.RecordRecent(ctx, owner.ID, "nope"); err != ErrNotFound {
		t.Fatalf("unknown recent should be NotFound, got %v", err)
	}
}
