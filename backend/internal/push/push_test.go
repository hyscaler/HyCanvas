package push

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	webpush "github.com/SherClockHolmes/webpush-go"

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

func TestPushConfig(t *testing.T) {
	t.Setenv("VAPID_PUBLIC_KEY", "")
	t.Setenv("VAPID_PRIVATE_KEY", "")
	s := NewService(nil)
	if s.IsEnabled() {
		t.Fatal("should be disabled without VAPID keys")
	}
	// Disabled Send is a no-op returning 0 (nil db never touched).
	if n := s.Send(context.Background(), "u", Payload{Title: "x"}); n != 0 {
		t.Fatalf("disabled send should be 0, got %d", n)
	}

	priv, pub, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		t.Fatalf("vapid keys: %v", err)
	}
	t.Setenv("VAPID_PUBLIC_KEY", pub)
	t.Setenv("VAPID_PRIVATE_KEY", priv)
	s2 := NewService(nil)
	if !s2.IsEnabled() || s2.PublicKey() != pub {
		t.Fatalf("should be enabled with the public key exposed")
	}
}

func TestPush_DB(t *testing.T) {
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
	owner, _, _, err := acct.Signup(ctx, "push+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	s := NewService(tx)
	endpoint := "https://push.example.com/" + uuid.NewString()

	if err := s.Subscribe(ctx, owner.ID, endpoint, "p256dh-key", "auth-key"); err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	var count int
	_ = tx.QueryRow(ctx, `SELECT count(*) FROM "PushSubscription" WHERE "userId" = $1 AND endpoint = $2`, owner.ID, endpoint).Scan(&count)
	if count != 1 {
		t.Fatalf("subscription not stored: %d", count)
	}
	// Re-subscribe with the same endpoint is idempotent (upsert).
	if err := s.Subscribe(ctx, owner.ID, endpoint, "p2", "a2"); err != nil {
		t.Fatalf("re-subscribe: %v", err)
	}
	_ = tx.QueryRow(ctx, `SELECT count(*) FROM "PushSubscription" WHERE endpoint = $1`, endpoint).Scan(&count)
	if count != 1 {
		t.Fatalf("re-subscribe should upsert, got %d rows", count)
	}
	// Incomplete subscription rejected.
	if err := s.Subscribe(ctx, owner.ID, "", "", ""); err == nil {
		t.Fatal("incomplete subscription should error")
	}
	// Unsubscribe removes it.
	if err := s.Unsubscribe(ctx, endpoint); err != nil {
		t.Fatalf("Unsubscribe: %v", err)
	}
	_ = tx.QueryRow(ctx, `SELECT count(*) FROM "PushSubscription" WHERE endpoint = $1`, endpoint).Scan(&count)
	if count != 0 {
		t.Fatalf("unsubscribe should remove the row, got %d", count)
	}
}
