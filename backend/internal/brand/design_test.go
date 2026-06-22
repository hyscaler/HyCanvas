package brand

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/persistence"
	"hycanvas/backend/internal/sharing"
	"hycanvas/backend/internal/storage"
)

func TestBrandDesignScoped_DB(t *testing.T) {
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
	owner, ws, _, err := acct.Signup(ctx, "bd-owner+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	member, _, _, err := acct.Signup(ctx, "bd-member+"+uuid.NewString()+"@example.com", "a-strong-password", "Member")
	if err != nil {
		t.Fatalf("signup member: %v", err)
	}
	addMember(ctx, t, tx, ws.ID, member.ID, "MEMBER")

	persist := persistence.NewService(tx).WithStorage(store)
	sh := sharing.NewService(tx, persist, nil, nil)
	svc := NewService(tx).WithDesignScope(sh, persist)

	// Create a design (via persistence) and a brand kit (via brand).
	rec, err := persist.Create(ctx, ws.ID, "Design", nil, &owner.ID)
	if err != nil {
		t.Fatalf("create design: %v", err)
	}
	kit, err := svc.CreateKit(ctx, ws.ID, owner.ID, "Primary", nil)
	if err != nil {
		t.Fatalf("create kit: %v", err)
	}

	// A member (no manage-brand) cannot assign a kit.
	if _, err := svc.AssignDesignBrand(ctx, rec.ID, member.ID, kit.ID); err != ErrForbidden {
		t.Fatalf("member assign should be Forbidden, got %v", err)
	}

	// Owner assigns the kit -> resolves to it, canManage true.
	rb, err := svc.AssignDesignBrand(ctx, rec.ID, owner.ID, kit.ID)
	if err != nil {
		t.Fatalf("AssignDesignBrand: %v", err)
	}
	if rb.Kit == nil || rb.Kit.ID != kit.ID || !rb.CanManage || rb.PinnedVersion != nil {
		t.Fatalf("resolved brand wrong: %+v", rb)
	}

	// A member resolves the same kit but canManage is false.
	rbMember, err := svc.ResolveDesignBrand(ctx, rec.ID, member.ID)
	if err != nil || rbMember.Kit == nil || rbMember.CanManage {
		t.Fatalf("member resolve wrong: %+v err=%v", rbMember, err)
	}

	// Advance the kit (v1 -> v2) by adding a palette, then pin the design to v1.
	palettes := json.RawMessage(`[{"id":"p","name":"P","colors":[{"hex":"#000"}]}]`)
	if _, err := svc.UpdateKit(ctx, kit.ID, owner.ID, UpdateInput{Palettes: palettes}); err != nil {
		t.Fatalf("UpdateKit: %v", err)
	}
	rbPinned, err := svc.SetDesignBrandVersion(ctx, rec.ID, owner.ID, 1)
	if err != nil {
		t.Fatalf("SetDesignBrandVersion: %v", err)
	}
	if rbPinned.PinnedVersion == nil || *rbPinned.PinnedVersion != 1 {
		t.Fatalf("pin not set: %+v", rbPinned.PinnedVersion)
	}
	// Pinned to v1 -> the resolved kit is the v1 snapshot (version 1, empty palette).
	if rbPinned.Kit.Version != 1 || countColors(rbPinned.Kit.Palettes) != 0 {
		t.Fatalf("pinned kit should resolve to v1: version=%d colors=%d", rbPinned.Kit.Version, countColors(rbPinned.Kit.Palettes))
	}

	// A pinned design reports no brand update.
	upd, err := svc.BrandUpdates(ctx, rec.ID, owner.ID)
	if err != nil || upd.HasUpdate || !upd.Pinned {
		t.Fatalf("pinned updates wrong: %+v err=%v", upd, err)
	}

	// Clear the pin (track latest) -> resolves to v2 (with the palette).
	rbTrack, err := svc.SetDesignBrandVersion(ctx, rec.ID, owner.ID, -1)
	if err != nil {
		t.Fatalf("clear pin: %v", err)
	}
	if rbTrack.PinnedVersion != nil || rbTrack.Kit.Version != 2 {
		t.Fatalf("tracking should resolve latest v2: %+v", rbTrack)
	}

	// Tracking + advanced past reviewed -> hasUpdate, with a palette change noted.
	upd2, err := svc.BrandUpdates(ctx, rec.ID, owner.ID)
	if err != nil {
		t.Fatalf("BrandUpdates: %v", err)
	}
	if !upd2.HasUpdate || upd2.LatestVersion != 2 || len(upd2.Changes) == 0 {
		t.Fatalf("tracking updates wrong: %+v", upd2)
	}

	// Mark reviewed -> banner clears.
	if _, err := svc.MarkBrandReviewed(ctx, rec.ID, owner.ID); err != nil {
		t.Fatalf("MarkBrandReviewed: %v", err)
	}
	upd3, _ := svc.BrandUpdates(ctx, rec.ID, owner.ID)
	if upd3.HasUpdate {
		t.Fatalf("after review should have no update: %+v", upd3)
	}

	// Locked regions round-trip.
	rbLocked, err := svc.SetDesignLockedRegions(ctx, rec.ID, owner.ID, []string{"n1", "n2"}, nil, false)
	if err != nil {
		t.Fatalf("SetDesignLockedRegions: %v", err)
	}
	if len(rbLocked.LockedRegions) != 2 {
		t.Fatalf("locked regions wrong: %+v", rbLocked.LockedRegions)
	}

	// Clearing the assignment drops the pin + reviewed marker.
	rbClear, err := svc.AssignDesignBrand(ctx, rec.ID, owner.ID, "")
	if err != nil {
		t.Fatalf("clear assignment: %v", err)
	}
	// With no assignment and a workspace default kit, it falls back to the default.
	if rbClear.PinnedVersion != nil {
		t.Fatalf("clear should drop pin: %+v", rbClear.PinnedVersion)
	}
}
