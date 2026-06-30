package accountdata

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/persistence"
	"hycanvas/backend/internal/storage"
)

func stripSchema(dsn string) string {
	for _, sep := range []string{"?schema=", "&schema="} {
		if i := strings.Index(dsn, sep); i >= 0 {
			return dsn[:i]
		}
	}
	return dsn
}

func TestAccountData_ExportAndDelete(t *testing.T) {
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

	store, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatalf("storage: %v", err)
	}
	acct := accounts.NewService(tx, "test-jwt-secret")
	persist := persistence.NewService(tx).WithStorage(store)
	svc := NewService(tx, acct, persist)

	owner, ws, _, err := acct.Signup(ctx, "acct+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	if _, err := persist.Create(ctx, ws.ID, "Design A", nil, &owner.ID); err != nil {
		t.Fatalf("create design: %v", err)
	}

	// Export includes the personal workspace + the design, never the password hash.
	bundle, err := svc.Export(ctx, owner.ID)
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	if len(bundle.Workspaces) != 1 || !bundle.Workspaces[0].Owner || bundle.Workspaces[0].Kind != "personal" {
		t.Fatalf("workspaces: %+v", bundle.Workspaces)
	}
	if len(bundle.Designs) != 1 || bundle.Designs[0].Title != "Design A" {
		t.Fatalf("designs: %+v", bundle.Designs)
	}
	if _, leaked := bundle.Profile["passwordHash"]; leaked {
		t.Fatal("export must not leak passwordHash")
	}

	// Delete requires the correct password.
	if err := svc.Delete(ctx, owner.ID, "wrong-password", ""); err == nil {
		t.Fatal("delete with wrong password should fail")
	}
	if err := svc.Delete(ctx, owner.ID, "a-strong-password", ""); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	// The user, their sole-member workspace, and its design are gone.
	var n int
	_ = tx.QueryRow(ctx, `SELECT count(*) FROM "users" WHERE id = $1`, owner.ID).Scan(&n)
	if n != 0 {
		t.Fatalf("user not deleted: %d", n)
	}
	_ = tx.QueryRow(ctx, `SELECT count(*) FROM "workspaces" WHERE id = $1`, ws.ID).Scan(&n)
	if n != 0 {
		t.Fatalf("sole-member workspace not deleted: %d", n)
	}
}

func TestAccountData_DeleteSharedWorkspaceTransfersOwnership(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping DB integration test")
	}
	ctx := context.Background()
	conn, _ := pgx.Connect(ctx, stripSchema(dsn))
	defer conn.Close(ctx)
	tx, _ := conn.Begin(ctx)
	defer func() { _ = tx.Rollback(ctx) }()

	acct := accounts.NewService(tx, "test-jwt-secret")
	persist := persistence.NewService(tx)
	svc := NewService(tx, acct, persist)

	owner, _, _, _ := acct.Signup(ctx, "o+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	teamWS, err := acct.CreateWorkspace(ctx, owner.ID, "Team", "team")
	if err != nil {
		t.Fatalf("CreateWorkspace: %v", err)
	}
	// A second active member of the team.
	other, _, _, _ := acct.Signup(ctx, "m+"+uuid.NewString()+"@example.com", "a-strong-password", "Member")
	if _, err := tx.Exec(ctx,
		`INSERT INTO "workspace_members" (id,"workspace_id","user_id",role,status,"joined_at","updated_at") VALUES ($1,$2,$3,'ADMIN','ACTIVE',now(),now())`,
		uuid.NewString(), teamWS.ID, other.ID); err != nil {
		t.Fatalf("add member: %v", err)
	}

	if err := svc.Delete(ctx, owner.ID, "a-strong-password", ""); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	// Shared workspace survives; ownership moved to the remaining admin.
	var newOwner string
	if err := tx.QueryRow(ctx, `SELECT "owner_id" FROM "workspaces" WHERE id = $1`, teamWS.ID).Scan(&newOwner); err != nil {
		t.Fatalf("workspace should survive: %v", err)
	}
	if newOwner != other.ID {
		t.Fatalf("ownership not transferred: got %s want %s", newOwner, other.ID)
	}
}
