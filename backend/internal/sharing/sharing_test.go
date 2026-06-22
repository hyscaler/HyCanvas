package sharing

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/authz"
	"hycanvas/backend/internal/persistence"
)

func stripSchema(dsn string) string {
	for _, sep := range []string{"?schema=", "&schema="} {
		if i := strings.Index(dsn, sep); i >= 0 {
			return dsn[:i]
		}
	}
	return dsn
}

// stubFiles is a fixed design file for the ResolveLinkFile test.
type stubFiles struct{ file any }

func (s stubFiles) LoadFileForDesign(ctx context.Context, designID string) (any, error) {
	return s.file, nil
}

func TestSharing_DB(t *testing.T) {
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
	owner, ws, _, err := acct.Signup(ctx, "share-owner+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup owner: %v", err)
	}
	// A second account that is NOT a member of the workspace.
	outsider, _, _, err := acct.Signup(ctx, "share-outsider+"+uuid.NewString()+"@example.com", "a-strong-password", "Outsider")
	if err != nil {
		t.Fatalf("signup outsider: %v", err)
	}

	designID := uuid.NewString()
	if _, err := tx.Exec(ctx, `INSERT INTO "Design" (id,"workspaceId",title,"updatedAt") VALUES ($1,$2,'Shared',now())`, designID, ws.ID); err != nil {
		t.Fatalf("design: %v", err)
	}

	svc := NewService(tx, persistence.NewService(tx), nil, nil)

	// Owner resolves to edit + share capability.
	access, err := svc.GetAccess(ctx, designID, owner.ID)
	if err != nil {
		t.Fatalf("owner access: %v", err)
	}
	if access.Mode != authz.ModeEdit || !has(access, authz.CapShare) {
		t.Fatalf("owner should have edit+share: %+v", access)
	}

	// Outsider (no membership, no grant) has no access.
	out, err := svc.GetAccess(ctx, designID, outsider.ID)
	if err != nil {
		t.Fatalf("outsider access: %v", err)
	}
	if len(out.Capabilities) != 0 {
		t.Fatalf("outsider must have no capabilities: %+v", out)
	}

	// Outsider cannot share (no share capability).
	if _, err := svc.AddGrant(ctx, designID, outsider.ID, AddGrantInput{Principal: Principal{Kind: "user", ID: outsider.ID}, Mode: "edit"}); err != ErrForbidden {
		t.Fatalf("outsider AddGrant should be forbidden, got %v", err)
	}

	// Owner grants the outsider comment access.
	grant, err := svc.AddGrant(ctx, designID, owner.ID, AddGrantInput{Principal: Principal{Kind: "user", ID: outsider.ID}, Mode: "comment"})
	if err != nil {
		t.Fatalf("AddGrant: %v", err)
	}
	if grant.Mode != authz.ModeComment {
		t.Fatalf("grant mode: %s", grant.Mode)
	}

	// Now the outsider resolves to comment.
	out2, err := svc.GetAccess(ctx, designID, outsider.ID)
	if err != nil || out2.Mode != authz.ModeComment || !has(out2, authz.CapComment) {
		t.Fatalf("granted outsider should have comment: %+v err=%v", out2, err)
	}

	// Update grant to edit.
	editMode := "edit"
	if _, err := svc.UpdateGrant(ctx, grant.ID, owner.ID, &editMode, nil, false); err != nil {
		t.Fatalf("UpdateGrant: %v", err)
	}
	out3, _ := svc.GetAccess(ctx, designID, outsider.ID)
	if out3.Mode != authz.ModeEdit {
		t.Fatalf("grant update to edit failed: %+v", out3)
	}

	// Share link: create, resolve, password + expiry behavior.
	link, err := svc.CreateLink(ctx, designID, owner.ID, CreateLinkInput{Mode: "view", Password: "s3cret"})
	if err != nil {
		t.Fatalf("CreateLink: %v", err)
	}
	if !link.HasPassword {
		t.Fatalf("link should have password")
	}
	if _, err := svc.ResolveLink(ctx, link.Token, ResolveLinkOpts{}); err != ErrLinkPassword {
		t.Fatalf("missing password should fail, got %v", err)
	}
	if _, err := svc.ResolveLink(ctx, link.Token, ResolveLinkOpts{Password: "wrong"}); err != ErrLinkPassword {
		t.Fatalf("wrong password should fail, got %v", err)
	}
	resolved, err := svc.ResolveLink(ctx, link.Token, ResolveLinkOpts{Password: "s3cret"})
	if err != nil || resolved.DesignID != designID || resolved.Mode != authz.ModeView {
		t.Fatalf("correct password resolve failed: %+v err=%v", resolved, err)
	}

	// With a Files hook, ResolveLinkFile returns the resolved link + design file.
	svc.WithFiles(stubFiles{file: map[string]any{"id": designID, "pages": []any{}}})
	rf, err := svc.ResolveLinkFile(ctx, link.Token, ResolveLinkOpts{Password: "s3cret"})
	if err != nil {
		t.Fatalf("ResolveLinkFile: %v", err)
	}
	if rf.DesignID != designID || rf.Mode != authz.ModeView || rf.File == nil {
		t.Fatalf("resolve link file wrong: %+v", rf)
	}

	// Rotate invalidates the old token.
	rotated, err := svc.RotateLink(ctx, link.ID, owner.ID)
	if err != nil {
		t.Fatalf("RotateLink: %v", err)
	}
	if rotated.Token == link.Token {
		t.Fatalf("rotate should change token")
	}
	if _, err := svc.ResolveLink(ctx, link.Token, ResolveLinkOpts{Password: "s3cret"}); err != ErrLinkNotAvail {
		t.Fatalf("old token should be unavailable, got %v", err)
	}

	// Disable -> unavailable.
	disabled := true
	if _, err := svc.UpdateLink(ctx, link.ID, owner.ID, UpdateLinkInput{Disabled: &disabled}); err != nil {
		t.Fatalf("UpdateLink disable: %v", err)
	}
	if _, err := svc.ResolveLink(ctx, rotated.Token, ResolveLinkOpts{Password: "s3cret"}); err != ErrLinkNotAvail {
		t.Fatalf("disabled link should be unavailable, got %v", err)
	}

	// Custom roles: owner has manage-roles; create/list/delete.
	role, err := svc.CreateRole(ctx, ws.ID, owner.ID, "Reviewer", []string{"approve"}, nil)
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}
	roles, err := svc.ListRoles(ctx, ws.ID, owner.ID)
	if err != nil || len(roles) != 1 || roles[0].ID != role.ID {
		t.Fatalf("ListRoles wrong: %+v err=%v", roles, err)
	}
	// Outsider cannot manage roles.
	if _, err := svc.ListRoles(ctx, ws.ID, outsider.ID); err != ErrForbidden {
		t.Fatalf("outsider ListRoles should be forbidden, got %v", err)
	}

	// Sharing dialog payload reflects the grant + link + role.
	view, err := svc.GetSharing(ctx, designID, owner.ID)
	if err != nil {
		t.Fatalf("GetSharing: %v", err)
	}
	if len(view.Grants) != 1 || len(view.Links) != 1 || len(view.CustomRoles) != 1 {
		t.Fatalf("sharing view counts wrong: grants=%d links=%d roles=%d", len(view.Grants), len(view.Links), len(view.CustomRoles))
	}

	// Remove grant -> outsider loses access.
	if err := svc.RemoveGrant(ctx, grant.ID, owner.ID); err != nil {
		t.Fatalf("RemoveGrant: %v", err)
	}
	out4, _ := svc.GetAccess(ctx, designID, outsider.ID)
	if len(out4.Capabilities) != 0 {
		t.Fatalf("after removal outsider should have no access: %+v", out4)
	}
}
