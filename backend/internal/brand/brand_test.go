package brand

import (
	"context"
	"encoding/json"
	"errors"
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

// fakeStarterAssets stands in for the uploads service: it records what the
// seeding stores and hands back one id per file.
type fakeStarterAssets struct {
	stored []string
}

func (f *fakeStarterAssets) StoreStarterAsset(_ context.Context, workspaceID, ownerID, filename string, data []byte) (string, error) {
	if workspaceID == "" || ownerID == "" || len(data) == 0 {
		return "", errors.New("bad store call")
	}
	f.stored = append(f.stored, filename)
	return "asset-" + strings.TrimSuffix(filename, ".png"), nil
}

// The starter kit lands once, as the default, in a workspace with no kit; a
// workspace that has a kit is only marked; the workspace hook seeds signup's
// and CreateWorkspace's workspaces; the boot-time pass visits the rest.
func TestStarterKitSeeding_DB(t *testing.T) {
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

	assets := &fakeStarterAssets{}
	svc := NewService(tx).WithStarterAssets(assets)
	acct := accounts.NewService(tx, "test-jwt-secret")

	// A workspace made before the hook existed: nothing seeded yet.
	owner, ws, _, err := acct.Signup(ctx, "starter-owner+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	seeded, err := svc.SeedStarterKit(ctx, ws.ID, owner.ID)
	if err != nil || !seeded {
		t.Fatalf("SeedStarterKit = %v, %v", seeded, err)
	}
	if len(assets.stored) != 6 || assets.stored[0] != "HyCanvas logo.png" || assets.stored[1] != "HyCanvas logo on dark.png" {
		t.Fatalf("stored = %v", assets.stored)
	}
	kits, err := svc.ListKits(ctx, ws.ID, owner.ID)
	if err != nil || len(kits) != 1 {
		t.Fatalf("kits = %+v, %v", kits, err)
	}
	kit := kits[0]
	if kit.Name != "HyCanvas" || !kit.IsDefault || kit.Version != 1 || kit.Controls.LockColors || kit.Controls.LintPolicy != "warn" {
		t.Fatalf("seeded kit = %+v", kit)
	}
	// JSONB comes back reformatted, so read the content rather than match it.
	var logos []struct {
		AssetID  string            `json:"assetId"`
		Variants map[string]string `json:"variants"`
	}
	if err := json.Unmarshal(kit.Logos, &logos); err != nil || len(logos) != 4 || logos[0].AssetID != "asset-HyCanvas logo" || logos[0].Variants["dark"] != "asset-HyCanvas logo on dark" {
		t.Fatalf("logos = %s (%v)", kit.Logos, err)
	}
	var palettes []struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(kit.Palettes, &palettes); err != nil || len(palettes) != 2 || palettes[0].Name != "Brand" {
		t.Fatalf("palettes = %s (%v)", kit.Palettes, err)
	}
	var voice struct {
		Tone []string `json:"tone"`
	}
	if err := json.Unmarshal(kit.Voice, &voice); err != nil || len(voice.Tone) == 0 {
		t.Fatalf("voice = %s (%v)", kit.Voice, err)
	}
	versions, err := svc.ListVersions(ctx, kit.ID, owner.ID)
	if err != nil || len(versions) != 1 || versions[0].Version != 1 || versions[0].AuthorID != nil {
		t.Fatalf("versions = %+v, %v", versions, err)
	}
	var visited bool
	if err := tx.QueryRow(ctx, `SELECT "brand_seeded_at" IS NOT NULL FROM "workspaces" WHERE id = $1`, ws.ID).Scan(&visited); err != nil || !visited {
		t.Fatalf("visit not recorded: %v %v", visited, err)
	}

	// Again: nothing happens, even after the owner deletes the kit.
	if seeded, err := svc.SeedStarterKit(ctx, ws.ID, owner.ID); err != nil || seeded {
		t.Fatalf("second seed = %v, %v", seeded, err)
	}
	if err := svc.DeleteKit(ctx, kit.ID, owner.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if n, err := svc.SeedStarterKits(ctx); err != nil {
		t.Fatalf("pass: %v", err)
	} else if kits, _ := svc.ListKits(ctx, ws.ID, owner.ID); len(kits) != 0 {
		t.Fatalf("the pass brought a deleted starter kit back (%d seeded)", n)
	}

	// A workspace that already has a kit of its own is left alone.
	team, err := acct.CreateWorkspace(ctx, owner.ID, "Branded", "team")
	if err != nil {
		t.Fatalf("create team: %v", err)
	}
	own, err := svc.CreateKit(ctx, team.ID, owner.ID, "Ours", nil)
	if err != nil {
		t.Fatalf("own kit: %v", err)
	}
	before := len(assets.stored)
	if seeded, err := svc.SeedStarterKit(ctx, team.ID, owner.ID); err != nil || seeded {
		t.Fatalf("seed over own kit = %v, %v", seeded, err)
	}
	if kits, _ := svc.ListKits(ctx, team.ID, owner.ID); len(kits) != 1 || kits[0].ID != own.ID || !kits[0].IsDefault {
		t.Fatalf("own kit disturbed: %+v", kits)
	}
	if len(assets.stored) != before {
		t.Fatalf("artwork stored for a workspace that was not seeded")
	}

	// An empty kit still carrying the default name is a placeholder, not the
	// workspace's brand: the starter kit lands beside it and takes the default.
	placeholderWS, err := acct.CreateWorkspace(ctx, owner.ID, "Placeholder", "team")
	if err != nil {
		t.Fatalf("create placeholder ws: %v", err)
	}
	placeholder, err := svc.CreateKit(ctx, placeholderWS.ID, owner.ID, "", nil)
	if err != nil || placeholder.Name != "Untitled brand kit" || !placeholder.IsDefault {
		t.Fatalf("placeholder kit = %+v, %v", placeholder, err)
	}
	if seeded, err := svc.SeedStarterKit(ctx, placeholderWS.ID, owner.ID); err != nil || !seeded {
		t.Fatalf("seed beside placeholder = %v, %v", seeded, err)
	}
	if kits, _ := svc.ListKits(ctx, placeholderWS.ID, owner.ID); len(kits) != 2 || kits[0].Name != "HyCanvas" || !kits[0].IsDefault || kits[1].ID != placeholder.ID || kits[1].IsDefault {
		t.Fatalf("placeholder workspace kits = %+v", kits)
	}

	// The hook seeds the workspaces the accounts service creates.
	acct.WithWorkspaceHook(func(ctx context.Context, workspaceID, ownerID string) {
		if _, err := svc.SeedStarterKit(ctx, workspaceID, ownerID); err != nil {
			t.Errorf("hook: %v", err)
		}
	})
	late, lateWS, _, err := acct.Signup(ctx, "starter-late+"+uuid.NewString()+"@example.com", "a-strong-password", "Late")
	if err != nil {
		t.Fatalf("late signup: %v", err)
	}
	if kits, err := svc.ListKits(ctx, lateWS.ID, late.ID); err != nil || len(kits) != 1 || kits[0].Name != "HyCanvas" || !kits[0].IsDefault {
		t.Fatalf("signup workspace kits = %+v, %v", kits, err)
	}
	team2, err := acct.CreateWorkspace(ctx, late.ID, "Second", "team")
	if err != nil {
		t.Fatalf("create team2: %v", err)
	}
	if kits, err := svc.ListKits(ctx, team2.ID, late.ID); err != nil || len(kits) != 1 || kits[0].Name != "HyCanvas" {
		t.Fatalf("team workspace kits = %+v, %v", kits, err)
	}
}
