package approvals

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
	"hycanvas/backend/internal/sharing"
)

func stripSchema(dsn string) string {
	for _, sep := range []string{"?schema=", "&schema="} {
		if i := strings.Index(dsn, sep); i >= 0 {
			return dsn[:i]
		}
	}
	return dsn
}

// addMember inserts an ACTIVE workspace membership row for a user with a role.
func addMember(ctx context.Context, t *testing.T, tx pgx.Tx, workspaceID, userID, role string) {
	t.Helper()
	if _, err := tx.Exec(ctx,
		`INSERT INTO "workspace_members" (id,"workspace_id","user_id",role,status,"joined_at","updated_at")
		 VALUES ($1,$2,$3,$4,'ACTIVE',now(),now())`,
		uuid.NewString(), workspaceID, userID, role); err != nil {
		t.Fatalf("addMember(%s): %v", role, err)
	}
}

func TestResolveOutcome(t *testing.T) {
	ids := []string{"a", "b"}
	// any: one approve grants.
	if got := resolveOutcome("any", ids, []DecisionRow{{ApproverID: "a", Decision: "approve"}}); got != "approved" {
		t.Fatalf("any/one approve = %s", got)
	}
	// all: needs both.
	if got := resolveOutcome("all", ids, []DecisionRow{{ApproverID: "a", Decision: "approve"}}); got != "pending" {
		t.Fatalf("all/one approve = %s", got)
	}
	if got := resolveOutcome("all", ids, []DecisionRow{{ApproverID: "a", Decision: "approve"}, {ApproverID: "b", Decision: "approve"}}); got != "approved" {
		t.Fatalf("all/both = %s", got)
	}
	// a single reject fails either policy.
	if got := resolveOutcome("any", ids, []DecisionRow{{ApproverID: "a", Decision: "approve"}, {ApproverID: "b", Decision: "reject"}}); got != "rejected" {
		t.Fatalf("reject should fail = %s", got)
	}
	// non-approver decisions are ignored.
	if got := resolveOutcome("any", ids, []DecisionRow{{ApproverID: "c", Decision: "approve"}}); got != "pending" {
		t.Fatalf("non-approver ignored = %s", got)
	}
}

func TestApprovals_DB(t *testing.T) {
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
	owner, ws, _, err := acct.Signup(ctx, "appr-owner+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup owner: %v", err)
	}
	// An approver who is an ADMIN member (so they hold the `approve` capability).
	approver, _, _, err := acct.Signup(ctx, "appr-approver+"+uuid.NewString()+"@example.com", "a-strong-password", "Approver")
	if err != nil {
		t.Fatalf("signup approver: %v", err)
	}
	addMember(ctx, t, tx, ws.ID, approver.ID, "ADMIN")

	designID := uuid.NewString()
	if _, err := tx.Exec(ctx, `INSERT INTO "designs" (id,"workspace_id",title,"updated_at") VALUES ($1,$2,'Doc',now())`, designID, ws.ID); err != nil {
		t.Fatalf("design: %v", err)
	}

	persist := persistence.NewService(tx)
	lock := NewLockChecker(tx)
	sh := sharing.NewService(tx, persist, nil, lock)
	svc := NewService(tx, sh, acct, nil, nil)

	// No approval yet: not locked, owner can request.
	v, err := svc.GetForDesign(ctx, designID, owner.ID)
	if err != nil {
		t.Fatalf("GetForDesign: %v", err)
	}
	if v.Locked || v.Approval != nil || !v.Actions.CanRequest {
		t.Fatalf("initial state wrong: %+v", v)
	}

	// Owner requests approval (policy "all") from the approver.
	v, err = svc.Request(ctx, designID, owner.ID, RequestInput{ApproverIDs: []string{approver.ID}, Policy: "all"})
	if err != nil {
		t.Fatalf("Request: %v", err)
	}
	if v.Approval == nil || v.Approval.Status != "pending" || v.Locked {
		t.Fatalf("after request: %+v", v)
	}
	approvalID := v.Approval.ID

	// A second request must conflict (single active approval).
	if _, err := svc.Request(ctx, designID, owner.ID, RequestInput{ApproverIDs: []string{approver.ID}, Policy: "any"}); err != ErrConflict {
		t.Fatalf("second request should conflict, got %v", err)
	}

	// The owner is not a selected approver -> cannot decide.
	if _, err := svc.Decide(ctx, approvalID, owner.ID, DecideInput{Decision: "approve"}); err != ErrForbidden {
		t.Fatalf("non-approver decide should be forbidden, got %v", err)
	}

	// The approver approves -> design locks.
	v, err = svc.Decide(ctx, approvalID, approver.ID, DecideInput{Decision: "approve"})
	if err != nil {
		t.Fatalf("Decide approve: %v", err)
	}
	if !v.Locked || v.Approval.Status != "approved" {
		t.Fatalf("after approve should be locked+approved: %+v", v)
	}

	// Locked: the owner loses edit but keeps management caps (sharing capping).
	access, _ := sh.GetAccess(ctx, designID, owner.ID)
	if hasCapStr(access.Capabilities, "edit") {
		t.Fatalf("owner should lose edit under lock: %v", access.Capabilities)
	}
	if !hasCapStr(access.Capabilities, "manage-roles") {
		t.Fatalf("owner keeps manage-roles under lock: %v", access.Capabilities)
	}

	// Owner reopens (manage-roles) -> unlocked, edit restored.
	v, err = svc.Reopen(ctx, approvalID, owner.ID)
	if err != nil {
		t.Fatalf("Reopen: %v", err)
	}
	if v.Locked || v.Approval.Status != "reopened" {
		t.Fatalf("after reopen: %+v", v)
	}
	access2, _ := sh.GetAccess(ctx, designID, owner.ID)
	if !hasCapStr(access2.Capabilities, "edit") {
		t.Fatalf("edit should be restored after reopen: %v", access2.Capabilities)
	}
}

func hasCapStr(caps []authz.Capability, want string) bool {
	for _, c := range caps {
		if string(c) == want {
			return true
		}
	}
	return false
}
