package brand

import (
	"context"
	"encoding/json"
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

func addMember(ctx context.Context, t *testing.T, tx pgx.Tx, workspaceID, userID, role string) {
	t.Helper()
	if _, err := tx.Exec(ctx,
		`INSERT INTO "workspace_members" (id,"workspace_id","user_id",role,status,"joined_at","updated_at")
		 VALUES ($1,$2,$3,$4,'ACTIVE',now(),now())`,
		uuid.NewString(), workspaceID, userID, role); err != nil {
		t.Fatalf("addMember(%s): %v", role, err)
	}
}

func TestBrand_DB(t *testing.T) {
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
	owner, ws, _, err := acct.Signup(ctx, "brand-owner+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup owner: %v", err)
	}
	// A plain member lacks manage-brand.
	member, _, _, err := acct.Signup(ctx, "brand-member+"+uuid.NewString()+"@example.com", "a-strong-password", "Member")
	if err != nil {
		t.Fatalf("signup member: %v", err)
	}
	addMember(ctx, t, tx, ws.ID, member.ID, "MEMBER")
	outsider, _, _, err := acct.Signup(ctx, "brand-out+"+uuid.NewString()+"@example.com", "a-strong-password", "Outsider")
	if err != nil {
		t.Fatalf("signup outsider: %v", err)
	}

	svc := NewService(tx)

	// A member cannot create a kit (no manage-brand).
	if _, err := svc.CreateKit(ctx, ws.ID, member.ID, "Nope", nil); err != ErrForbidden {
		t.Fatalf("member create should be Forbidden, got %v", err)
	}
	// An outsider is not even a member.
	if _, err := svc.ListKits(ctx, ws.ID, outsider.ID); err != ErrForbidden {
		t.Fatalf("outsider list should be Forbidden, got %v", err)
	}

	// Owner creates the first kit -> becomes default at v1.
	kit, err := svc.CreateKit(ctx, ws.ID, owner.ID, "Primary", nil)
	if err != nil {
		t.Fatalf("CreateKit: %v", err)
	}
	if !kit.IsDefault || kit.Version != 1 || kit.Controls.LintPolicy != "warn" {
		t.Fatalf("first kit defaults wrong: %+v", kit)
	}
	if string(kit.Palettes) != "[]" || string(kit.Voice) != "null" {
		t.Fatalf("content defaults wrong: palettes=%s voice=%s", kit.Palettes, kit.Voice)
	}

	// Update contents + lock controls -> version advances to 2.
	palettes := json.RawMessage(`[{"id":"p1","name":"Brand","colors":[{"hex":"#ff0000"}]}]`)
	controls := json.RawMessage(`{"lockColors":true}`)
	updated, err := svc.UpdateKit(ctx, kit.ID, owner.ID, UpdateInput{Palettes: palettes, ControlsRaw: controls})
	if err != nil {
		t.Fatalf("UpdateKit: %v", err)
	}
	if updated.Version != 2 || !updated.Controls.LockColors || updated.Controls.LintPolicy != "warn" {
		t.Fatalf("update wrong: %+v", updated.Controls)
	}
	if !json.Valid(updated.Palettes) || string(updated.Palettes) == "[]" {
		t.Fatalf("palettes not stored: %s", updated.Palettes)
	}

	// A member still cannot update.
	if _, err := svc.UpdateKit(ctx, kit.ID, member.ID, UpdateInput{Name: ptr("Hijack")}); err != ErrForbidden {
		t.Fatalf("member update should be Forbidden, got %v", err)
	}
	// But a member CAN read (membership-gated).
	if _, err := svc.GetKit(ctx, kit.ID, member.ID); err != nil {
		t.Fatalf("member read should succeed: %v", err)
	}

	// Versions: v1 and v2 recorded, newest first.
	versions, err := svc.ListVersions(ctx, kit.ID, owner.ID)
	if err != nil || len(versions) != 2 || versions[0].Version != 2 || versions[1].Version != 1 {
		t.Fatalf("versions wrong: %+v err=%v", versions, err)
	}

	// Restore to v1 -> contents revert (palettes empty again), version advances to 3.
	restored, err := svc.RestoreVersion(ctx, kit.ID, owner.ID, 1)
	if err != nil {
		t.Fatalf("RestoreVersion: %v", err)
	}
	if restored.Version != 3 || restored.Controls.LockColors {
		t.Fatalf("restore wrong: version=%d lockColors=%v", restored.Version, restored.Controls.LockColors)
	}
	if string(restored.Palettes) != "[]" {
		t.Fatalf("restore should revert palettes, got %s", restored.Palettes)
	}

	// Second kit, made default -> first kit loses default.
	kit2, err := svc.CreateKit(ctx, ws.ID, owner.ID, "Secondary", ptrBool(true))
	if err != nil {
		t.Fatalf("CreateKit 2: %v", err)
	}
	if !kit2.IsDefault {
		t.Fatalf("kit2 should be default")
	}
	again, _ := svc.GetKit(ctx, kit.ID, owner.ID)
	if again.IsDefault {
		t.Fatalf("first kit should no longer be default")
	}

	// Set first kit default again -> kit2 loses it.
	if _, err := svc.SetDefault(ctx, kit.ID, owner.ID); err != nil {
		t.Fatalf("SetDefault: %v", err)
	}
	k2, _ := svc.GetKit(ctx, kit2.ID, owner.ID)
	if k2.IsDefault {
		t.Fatalf("kit2 should lose default after SetDefault(kit1)")
	}

	// Delete kit2.
	if err := svc.DeleteKit(ctx, kit2.ID, owner.ID); err != nil {
		t.Fatalf("DeleteKit: %v", err)
	}
	if _, err := svc.GetKit(ctx, kit2.ID, owner.ID); err != ErrNotFound {
		t.Fatalf("deleted kit should be NotFound, got %v", err)
	}

	// Workspace list now has one kit (the default Primary).
	kits, err := svc.ListKits(ctx, ws.ID, owner.ID)
	if err != nil || len(kits) != 1 || !kits[0].IsDefault {
		t.Fatalf("final list wrong: %+v err=%v", kits, err)
	}
}

func ptr(s string) *string { return &s }
func ptrBool(b bool) *bool { return &b }
