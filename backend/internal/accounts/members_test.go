package accounts

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Integration test for workspace member + invitation management, in a
// rolled-back transaction. Skipped without DATABASE_URL.
func TestMembersAndInvites_DB(t *testing.T) {
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

	svc := NewService(tx, "test-jwt-secret")

	owner, _, _, err := svc.Signup(ctx, "owner+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup owner: %v", err)
	}
	invitee, _, _, err := svc.Signup(ctx, "invitee+"+uuid.NewString()+"@example.com", "a-strong-password", "Invitee")
	if err != nil {
		t.Fatalf("signup invitee: %v", err)
	}

	// Owner creates a TEAM workspace.
	ws, err := svc.CreateWorkspace(ctx, owner.ID, "Team", "team")
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}

	// Inviting to a PERSONAL workspace is refused.
	personal, _ := svc.ListWorkspaces(ctx, owner.ID)
	var personalID string
	for _, w := range personal {
		if w.Kind == "personal" {
			personalID = w.ID
		}
	}
	if personalID != "" {
		if _, _, err := svc.Invite(ctx, owner.ID, personalID, invitee.Email, "member"); err != ErrForbidden {
			t.Fatalf("invite to personal workspace must be forbidden, got %v", err)
		}
	}

	// Invite the invitee as a member.
	inv, token, err := svc.Invite(ctx, owner.ID, ws.ID, invitee.Email, "member")
	if err != nil {
		t.Fatalf("invite: %v", err)
	}
	if inv.Role != "member" || token == "" {
		t.Fatalf("unexpected invite result: %+v token=%q", inv, token)
	}

	// A wrong-email account cannot accept this invite.
	if _, err := svc.AcceptInvitation(ctx, owner.ID, token); err != ErrInviteEmailMismatch {
		t.Fatalf("accept by wrong email must mismatch, got %v", err)
	}

	// Invitee accepts: becomes an active member.
	m, err := svc.AcceptInvitation(ctx, invitee.ID, token)
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	if m.Role != "member" || m.Status != "active" {
		t.Fatalf("unexpected membership: %+v", m)
	}

	// Re-accepting the same (now used) token fails.
	if _, err := svc.AcceptInvitation(ctx, invitee.ID, token); err != ErrInviteInvalid {
		t.Fatalf("re-accept must be invalid, got %v", err)
	}

	// Roster shows both.
	members, err := svc.ListMembers(ctx, owner.ID, ws.ID)
	if err != nil || len(members) != 2 {
		t.Fatalf("expected 2 members, got %d (%v)", len(members), err)
	}

	// A plain member cannot invite (needs admin+).
	if _, _, err := svc.Invite(ctx, invitee.ID, ws.ID, "x+"+uuid.NewString()+"@example.com", "member"); err != ErrForbidden {
		t.Fatalf("member invite must be forbidden, got %v", err)
	}

	// An admin cannot invite at a role above their own (owner).
	if err := svc.ChangeMemberRole(ctx, owner.ID, ws.ID, invitee.ID, "admin"); err != nil {
		t.Fatalf("promote to admin: %v", err)
	}
	if _, _, err := svc.Invite(ctx, invitee.ID, ws.ID, "y+"+uuid.NewString()+"@example.com", "owner"); err != ErrForbidden {
		t.Fatalf("admin inviting an owner must be forbidden, got %v", err)
	}

	// Last-owner protection: the sole owner cannot leave or be demoted.
	if err := svc.RemoveMember(ctx, owner.ID, ws.ID, owner.ID); err != ErrLastOwner {
		t.Fatalf("sole owner leaving must be ErrLastOwner, got %v", err)
	}
	if err := svc.ChangeMemberRole(ctx, owner.ID, ws.ID, owner.ID, "admin"); err != ErrLastOwner {
		t.Fatalf("demoting the last owner must be ErrLastOwner, got %v", err)
	}

	// Promote invitee to owner, then the original owner can leave.
	if err := svc.ChangeMemberRole(ctx, owner.ID, ws.ID, invitee.ID, "owner"); err != nil {
		t.Fatalf("promote invitee to owner: %v", err)
	}
	if err := svc.RemoveMember(ctx, owner.ID, ws.ID, owner.ID); err != nil {
		t.Fatalf("owner leave after transfer: %v", err)
	}

	// Invitations: invite, list pending, revoke.
	inv2, _, err := svc.Invite(ctx, invitee.ID, ws.ID, "z+"+uuid.NewString()+"@example.com", "member")
	if err != nil {
		t.Fatalf("invite2: %v", err)
	}
	pending, err := svc.ListInvitations(ctx, invitee.ID, ws.ID)
	if err != nil || len(pending) != 1 {
		t.Fatalf("expected 1 pending invite, got %d (%v)", len(pending), err)
	}
	if err := svc.RevokeInvitation(ctx, invitee.ID, ws.ID, inv2.ID); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if again, _ := svc.ListInvitations(ctx, invitee.ID, ws.ID); len(again) != 0 {
		t.Fatalf("expected 0 pending after revoke, got %d", len(again))
	}
}
