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
	if _, err := tx.Exec(ctx, `INSERT INTO "designs" (id,"workspace_id",title,"updated_at") VALUES ($1,$2,'Shared',now())`, designID, ws.ID); err != nil {
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

// TestSharing_Hardening_DB covers the share-flow hardening: input validation,
// re-invite upsert, readable principals, and link deletion. Skips without a DB.
func TestSharing_Hardening_DB(t *testing.T) {
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
	owner, ws, _, err := acct.Signup(ctx, "h-owner+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup owner: %v", err)
	}
	outsider, _, _, err := acct.Signup(ctx, "h-outsider+"+uuid.NewString()+"@example.com", "a-strong-password", "Outsider")
	if err != nil {
		t.Fatalf("signup outsider: %v", err)
	}

	designID := uuid.NewString()
	if _, err := tx.Exec(ctx, `INSERT INTO "designs" (id,"workspace_id",title,"updated_at") VALUES ($1,$2,'Shared',now())`, designID, ws.ID); err != nil {
		t.Fatalf("design: %v", err)
	}
	svc := NewService(tx, persistence.NewService(tx), nil, nil)

	// Self-invite is rejected.
	if _, err := svc.AddGrant(ctx, designID, owner.ID, AddGrantInput{Principal: Principal{Kind: "user", ID: owner.ID}, Mode: "edit"}); err != ErrBadRequest {
		t.Fatalf("self-invite should be ErrBadRequest, got %v", err)
	}
	// An unknown user id is rejected (no dangling grant).
	if _, err := svc.AddGrant(ctx, designID, owner.ID, AddGrantInput{Principal: Principal{Kind: "user", ID: uuid.NewString()}, Mode: "edit"}); err != ErrBadRequest {
		t.Fatalf("unknown user id should be ErrBadRequest, got %v", err)
	}
	// A malformed email is rejected.
	if _, err := svc.AddGrant(ctx, designID, owner.ID, AddGrantInput{Principal: Principal{Kind: "email", ID: "not-an-email"}, Mode: "view"}); err != ErrBadRequest {
		t.Fatalf("bad email should be ErrBadRequest, got %v", err)
	}

	// Grant the outsider, then re-invite at a higher mode: the second call must
	// update in place (no unique-constraint 500) and leave a single grant.
	if _, err := svc.AddGrant(ctx, designID, owner.ID, AddGrantInput{Principal: Principal{Kind: "user", ID: outsider.ID}, Mode: "comment"}); err != nil {
		t.Fatalf("first invite: %v", err)
	}
	reinvited, err := svc.AddGrant(ctx, designID, owner.ID, AddGrantInput{Principal: Principal{Kind: "user", ID: outsider.ID}, Mode: "edit"})
	if err != nil {
		t.Fatalf("re-invite: %v", err)
	}
	if reinvited.Mode != authz.ModeEdit {
		t.Fatalf("re-invite should update mode to edit, got %s", reinvited.Mode)
	}

	// The sharing view shows one grant with a readable name + email (not a raw id).
	view, err := svc.GetSharing(ctx, designID, owner.ID)
	if err != nil {
		t.Fatalf("GetSharing: %v", err)
	}
	if len(view.Grants) != 1 {
		t.Fatalf("re-invite must leave exactly one grant, got %d", len(view.Grants))
	}
	g := view.Grants[0]
	if g.Principal.Name != "Outsider" || g.Principal.Email == "" {
		t.Fatalf("grant principal should carry name+email, got %+v", g.Principal)
	}

	// DeleteLink removes the link entirely.
	link, err := svc.CreateLink(ctx, designID, owner.ID, CreateLinkInput{Mode: "view"})
	if err != nil {
		t.Fatalf("CreateLink: %v", err)
	}
	if err := svc.DeleteLink(ctx, link.ID, owner.ID); err != nil {
		t.Fatalf("DeleteLink: %v", err)
	}
	if _, err := svc.getLink(ctx, link.ID); err != ErrNotFound {
		t.Fatalf("deleted link should be gone, got %v", err)
	}
}

// TestSharing_AccessRequests_DB covers request-access (request, list, approve)
// plus owner attribution + inviter name enrichment. Skips without a DB.
func TestSharing_AccessRequests_DB(t *testing.T) {
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
	owner, ws, _, err := acct.Signup(ctx, "ar-owner+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup owner: %v", err)
	}
	outsider, _, _, err := acct.Signup(ctx, "ar-outsider+"+uuid.NewString()+"@example.com", "a-strong-password", "Outsider")
	if err != nil {
		t.Fatalf("signup outsider: %v", err)
	}

	designID := uuid.NewString()
	// createdById is set so owner attribution resolves.
	if _, err := tx.Exec(ctx, `INSERT INTO "designs" (id,"workspace_id",title,"created_by_id","updated_at") VALUES ($1,$2,'Shared',$3,now())`, designID, ws.ID, owner.ID); err != nil {
		t.Fatalf("design: %v", err)
	}
	svc := NewService(tx, persistence.NewService(tx), nil, nil)

	// Owner attribution: the sharing view names the creator.
	view, err := svc.GetSharing(ctx, designID, owner.ID)
	if err != nil {
		t.Fatalf("GetSharing: %v", err)
	}
	if view.Owner == nil || view.Owner.Name != "Owner" {
		t.Fatalf("owner attribution missing/wrong: %+v", view.Owner)
	}

	// The outsider (no access) requests edit access.
	req, err := svc.RequestAccess(ctx, designID, outsider.ID, "edit", "please let me in")
	if err != nil {
		t.Fatalf("RequestAccess: %v", err)
	}
	if req.Status != "pending" || req.Requester.Name != "Outsider" || req.Mode != authz.ModeEdit {
		t.Fatalf("request wrong: %+v", req)
	}

	// The owner sees one pending request.
	pending, err := svc.ListAccessRequests(ctx, designID, owner.ID)
	if err != nil || len(pending) != 1 {
		t.Fatalf("ListAccessRequests wrong: %d err=%v", len(pending), err)
	}
	// An outsider cannot list requests (no share capability).
	if _, err := svc.ListAccessRequests(ctx, designID, outsider.ID); err != ErrForbidden {
		t.Fatalf("outsider list should be forbidden, got %v", err)
	}

	// Owner approves at a downgraded mode (comment).
	commentMode := "comment"
	resolved, err := svc.ResolveAccessRequest(ctx, req.ID, owner.ID, true, &commentMode)
	if err != nil {
		t.Fatalf("ResolveAccessRequest: %v", err)
	}
	if resolved.Status != "granted" {
		t.Fatalf("resolved status: %s", resolved.Status)
	}
	out, _ := svc.GetAccess(ctx, designID, outsider.ID)
	if out.Mode != authz.ModeComment {
		t.Fatalf("approved outsider should have comment, got %s", out.Mode)
	}
	// No pending requests remain.
	if pending, _ := svc.ListAccessRequests(ctx, designID, owner.ID); len(pending) != 0 {
		t.Fatalf("approved request should no longer be pending, got %d", len(pending))
	}

	// The grant created by the approval is attributed to the owner.
	view2, _ := svc.GetSharing(ctx, designID, owner.ID)
	if len(view2.Grants) != 1 || view2.Grants[0].InvitedByName != "Owner" {
		t.Fatalf("approval grant should be attributed to Owner: %+v", view2.Grants)
	}

	// Requesting access the outsider already holds is rejected; a higher tier is allowed.
	if _, err := svc.RequestAccess(ctx, designID, outsider.ID, "view", ""); err != ErrBadRequest {
		t.Fatalf("request for already-held access should be ErrBadRequest, got %v", err)
	}
	if _, err := svc.RequestAccess(ctx, designID, outsider.ID, "edit", ""); err != nil {
		t.Fatalf("request for higher access should succeed, got %v", err)
	}

	// A user with NO access requesting the default "view" tier must succeed
	// (authz.Resolve defaults Mode to "view" with zero capabilities; the guard
	// must key off the capability, not the mode).
	stranger, _, _, err := acct.Signup(ctx, "ar-stranger+"+uuid.NewString()+"@example.com", "a-strong-password", "Stranger")
	if err != nil {
		t.Fatalf("signup stranger: %v", err)
	}
	if _, err := svc.RequestAccess(ctx, designID, stranger.ID, "view", ""); err != nil {
		t.Fatalf("no-access user requesting view should succeed, got %v", err)
	}
}

// TestSharing_RoleAssignAuthz_DB verifies a share-only member cannot escalate a
// principal by attaching a custom role via AddGrant/UpdateGrant; only a
// manage-roles holder can. Skips without a DB.
func TestSharing_RoleAssignAuthz_DB(t *testing.T) {
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
	owner, ws, _, err := acct.Signup(ctx, "ra-owner+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup owner: %v", err)
	}
	member, _, _, err := acct.Signup(ctx, "ra-member+"+uuid.NewString()+"@example.com", "a-strong-password", "Member")
	if err != nil {
		t.Fatalf("signup member: %v", err)
	}
	target, _, _, err := acct.Signup(ctx, "ra-target+"+uuid.NewString()+"@example.com", "a-strong-password", "Target")
	if err != nil {
		t.Fatalf("signup target: %v", err)
	}
	// Make `member` a MEMBER of the owner's workspace (has share, not manage-roles).
	if _, err := tx.Exec(ctx,
		`INSERT INTO "workspace_members" (id,"workspace_id","user_id",role,status,"joined_at","updated_at") VALUES ($1,$2,$3,'MEMBER','ACTIVE', now(), now())`,
		uuid.NewString(), ws.ID, member.ID); err != nil {
		t.Fatalf("seed member: %v", err)
	}

	designID := uuid.NewString()
	if _, err := tx.Exec(ctx, `INSERT INTO "designs" (id,"workspace_id",title,"updated_at") VALUES ($1,$2,'Shared',now())`, designID, ws.ID); err != nil {
		t.Fatalf("design: %v", err)
	}
	svc := NewService(tx, persistence.NewService(tx), nil, nil)

	// A powerful custom role (carries manage-roles).
	role, err := svc.CreateRole(ctx, ws.ID, owner.ID, "Superuser", []string{"manage-roles"}, nil)
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}

	// The member has share (can invite) but NOT manage-roles: attaching the role
	// via AddGrant must be forbidden.
	if _, err := svc.AddGrant(ctx, designID, member.ID, AddGrantInput{Principal: Principal{Kind: "user", ID: target.ID}, Mode: "comment", RoleID: &role.ID}); err != ErrForbidden {
		t.Fatalf("member AddGrant with roleId should be forbidden, got %v", err)
	}

	// A plain grant (no role) by the member is allowed; then attaching the role
	// via UpdateGrant must also be forbidden.
	grant, err := svc.AddGrant(ctx, designID, member.ID, AddGrantInput{Principal: Principal{Kind: "user", ID: target.ID}, Mode: "comment"})
	if err != nil {
		t.Fatalf("member plain AddGrant: %v", err)
	}
	if _, err := svc.UpdateGrant(ctx, grant.ID, member.ID, nil, &role.ID, true); err != ErrForbidden {
		t.Fatalf("member UpdateGrant with roleId should be forbidden, got %v", err)
	}

	// The owner (manage-roles) can attach the role.
	if _, err := svc.UpdateGrant(ctx, grant.ID, owner.ID, nil, &role.ID, true); err != nil {
		t.Fatalf("owner UpdateGrant with roleId should succeed, got %v", err)
	}
}
