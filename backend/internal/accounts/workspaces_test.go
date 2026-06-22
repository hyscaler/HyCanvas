package accounts

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func wsStripSchema(dsn string) string {
	for _, sep := range []string{"?schema=", "&schema="} {
		if i := strings.Index(dsn, sep); i >= 0 {
			return dsn[:i]
		}
	}
	return dsn
}

func TestWorkspaces_ListAndCreate(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping DB integration test")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, wsStripSchema(dsn))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer conn.Close(ctx)
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	svc := NewService(tx, "test-jwt-secret")
	user, personal, _, err := svc.Signup(ctx, "ws+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}

	// Fresh user has exactly their personal workspace, as owner, kind lowercased.
	list, err := svc.ListWorkspaces(ctx, user.ID)
	if err != nil {
		t.Fatalf("ListWorkspaces: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("expected 1 workspace, got %d", len(list))
	}
	if list[0].ID != personal.ID || list[0].Kind != "personal" || list[0].Role != "owner" {
		t.Fatalf("unexpected personal workspace: %+v", list[0])
	}

	// Create a team workspace: kind defaults are honored, creator is owner.
	team, err := svc.CreateWorkspace(ctx, user.ID, "Acme Team", "")
	if err != nil {
		t.Fatalf("CreateWorkspace: %v", err)
	}
	if team.Kind != "team" || team.Name != "Acme Team" || team.OwnerID != user.ID {
		t.Fatalf("unexpected created workspace: %+v", team)
	}

	// It now appears in the list with the owner role.
	list, err = svc.ListWorkspaces(ctx, user.ID)
	if err != nil {
		t.Fatalf("ListWorkspaces (2): %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("expected 2 workspaces, got %d", len(list))
	}
	var found *WorkspaceWithRole
	for i := range list {
		if list[i].ID == team.ID {
			found = &list[i]
		}
	}
	if found == nil || found.Role != "owner" || found.Kind != "team" {
		t.Fatalf("created team not listed correctly: %+v", found)
	}

	// Personal workspaces cannot be created explicitly.
	if _, err := svc.CreateWorkspace(ctx, user.ID, "Nope", "personal"); err == nil {
		t.Fatal("creating a personal workspace should error")
	}
	// Invalid kinds are rejected.
	if _, err := svc.CreateWorkspace(ctx, user.ID, "Nope", "galaxy"); err == nil {
		t.Fatal("invalid kind should error")
	}
}
