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

func TestWorkspaces_Delete(t *testing.T) {
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
	owner, personal, _, err := svc.Signup(ctx, "wsdel+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup owner: %v", err)
	}
	member, _, _, err := svc.Signup(ctx, "wsdelm+"+uuid.NewString()+"@example.com", "a-strong-password", "Member")
	if err != nil {
		t.Fatalf("signup member: %v", err)
	}
	team, err := svc.CreateWorkspace(ctx, owner.ID, "Doomed Team", "team")
	if err != nil {
		t.Fatalf("CreateWorkspace: %v", err)
	}
	// Seed a member and a design so we can prove the cascade.
	if _, err := tx.Exec(ctx,
		`INSERT INTO "WorkspaceMember" (id,"workspaceId","userId",role,status,"joinedAt","updatedAt") VALUES ($1,$2,$3,'MEMBER','ACTIVE', now(), now())`,
		uuid.NewString(), team.ID, member.ID); err != nil {
		t.Fatalf("seed member: %v", err)
	}
	designID := uuid.NewString()
	if _, err := tx.Exec(ctx, `INSERT INTO "Design" (id,"workspaceId",title,"updatedAt") VALUES ($1,$2,'D',now())`, designID, team.ID); err != nil {
		t.Fatalf("seed design: %v", err)
	}

	// A non-owner member cannot delete the workspace.
	if err := svc.DeleteWorkspace(ctx, member.ID, team.ID); err != ErrForbidden {
		t.Fatalf("member delete should be ErrForbidden, got %v", err)
	}
	// The personal workspace cannot be deleted.
	if err := svc.DeleteWorkspace(ctx, owner.ID, personal.ID); err != ErrBadRequest {
		t.Fatalf("personal delete should be ErrBadRequest, got %v", err)
	}

	// The owner deletes the team workspace; it cascades to members + designs.
	if err := svc.DeleteWorkspace(ctx, owner.ID, team.ID); err != nil {
		t.Fatalf("owner DeleteWorkspace: %v", err)
	}
	list, err := svc.ListWorkspaces(ctx, owner.ID)
	if err != nil || len(list) != 1 || list[0].ID != personal.ID {
		t.Fatalf("after delete owner should have only personal, got %+v err=%v", list, err)
	}
	var designs, members int
	_ = tx.QueryRow(ctx, `SELECT count(*) FROM "Design" WHERE "workspaceId"=$1`, team.ID).Scan(&designs)
	_ = tx.QueryRow(ctx, `SELECT count(*) FROM "WorkspaceMember" WHERE "workspaceId"=$1`, team.ID).Scan(&members)
	if designs != 0 || members != 0 {
		t.Fatalf("cascade incomplete: designs=%d members=%d", designs, members)
	}
}

func TestUpdateProfile_DB(t *testing.T) {
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
	user, _, _, err := svc.Signup(ctx, "prof+"+uuid.NewString()+"@example.com", "a-strong-password", "Old Name")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}

	// Name + locale update.
	name, locale := "New Name", "fr-FR"
	v, err := svc.UpdateProfile(ctx, user.ID, UpdateProfileInput{Name: &name, Locale: &locale})
	if err != nil || v.Name != "New Name" || v.Locale != "fr-FR" {
		t.Fatalf("update name/locale wrong: %+v err=%v", v, err)
	}

	// Blank name is rejected.
	blank := "   "
	if _, err := svc.UpdateProfile(ctx, user.ID, UpdateProfileInput{Name: &blank}); err != ErrInvalidSignup {
		t.Fatalf("blank name should be ErrInvalidSignup, got %v", err)
	}

	// Avatar set then cleared.
	av := "https://example.com/a.png"
	v, _ = svc.UpdateProfile(ctx, user.ID, UpdateProfileInput{AvatarURL: &av})
	if v.AvatarURL == nil || *v.AvatarURL != av {
		t.Fatalf("avatar not set: %+v", v.AvatarURL)
	}
	empty := ""
	v, _ = svc.UpdateProfile(ctx, user.ID, UpdateProfileInput{AvatarURL: &empty})
	if v.AvatarURL != nil {
		t.Fatalf("avatar should be cleared, got %v", *v.AvatarURL)
	}
	// Name survived the avatar-only updates (COALESCE leaves it).
	if v.Name != "New Name" {
		t.Fatalf("name should persist across avatar updates, got %q", v.Name)
	}
}
