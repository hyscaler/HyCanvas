package sharing

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/persistence"
)

// TestEmailGrantNeedsVerifiedEmail_DB: a design shared to an email address
// applies to an account with that email only once the account has proven it.
// Password signup does not, so the first person to register the address must
// not inherit the share.
func TestEmailGrantNeedsVerifiedEmail_DB(t *testing.T) {
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
	owner, ws, _, err := acct.Signup(ctx, "grant-owner+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup owner: %v", err)
	}
	designID := uuid.NewString()
	if _, err := tx.Exec(ctx, `INSERT INTO "designs" (id,"workspace_id",title,"updated_at") VALUES ($1,$2,'Shared',now())`, designID, ws.ID); err != nil {
		t.Fatalf("design: %v", err)
	}
	svc := NewService(tx, persistence.NewService(tx), nil, nil)

	addr := "client+" + uuid.NewString() + "@example.com"
	if _, err := svc.AddGrant(ctx, designID, owner.ID, AddGrantInput{Principal: Principal{Kind: "email", ID: addr}, Mode: "edit"}); err != nil {
		t.Fatalf("AddGrant: %v", err)
	}

	squatter, _, _, err := acct.Signup(ctx, addr, "attacker-password", "Squatter")
	if err != nil {
		t.Fatalf("signup squatter: %v", err)
	}
	got, err := svc.GetAccess(ctx, designID, squatter.ID)
	if err != nil {
		t.Fatalf("GetAccess: %v", err)
	}
	if len(got.Capabilities) != 0 {
		t.Fatalf("an unverified account must not use an email share: %+v", got)
	}

	if _, err := tx.Exec(ctx, `UPDATE "users" SET "email_verified" = true WHERE id = $1`, squatter.ID); err != nil {
		t.Fatalf("verify: %v", err)
	}
	got, err = svc.GetAccess(ctx, designID, squatter.ID)
	if err != nil || len(got.Capabilities) == 0 {
		t.Fatalf("a verified account should get the email share: %+v err=%v", got, err)
	}
}
