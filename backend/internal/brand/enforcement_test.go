package brand

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/persistence"
	"hycanvas/backend/internal/sharing"
	"hycanvas/backend/internal/storage"
)

func designWithColor(r, g, b float64, fontFamily string) map[string]any {
	solid := map[string]any{"type": "solid", "color": map[string]any{"srgb": map[string]any{"r": r, "g": g, "b": b, "a": 1.0}}}
	node := map[string]any{"id": "n1", "type": "shape", "shape": "rect", "fills": []any{solid}}
	if fontFamily != "" {
		node = map[string]any{"id": "t1", "type": "text", "content": []any{
			map[string]any{"runs": []any{map[string]any{"text": "x", "style": map[string]any{"fontFamily": fontFamily}}}},
		}}
	}
	return map[string]any{"pages": []any{map[string]any{"id": "p1", "children": []any{node}}}}
}

func TestBrandValidateSnapshot_DB(t *testing.T) {
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

	store, _ := storage.NewLocal(t.TempDir())
	acct := accounts.NewService(tx, "test-jwt-secret")
	owner, ws, _, err := acct.Signup(ctx, "be-owner+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup owner: %v", err)
	}
	member, _, _, err := acct.Signup(ctx, "be-member+"+uuid.NewString()+"@example.com", "a-strong-password", "Member")
	if err != nil {
		t.Fatalf("signup member: %v", err)
	}
	addMember(ctx, t, tx, ws.ID, member.ID, "MEMBER")

	persist := persistence.NewService(tx).WithStorage(store)
	sh := sharing.NewService(tx, persist, nil, nil)
	svc := NewService(tx).WithDesignScope(sh, persist)

	rec, err := persist.Create(ctx, ws.ID, "Doc", nil, &owner.ID)
	if err != nil {
		t.Fatalf("create design: %v", err)
	}

	// A kit locking colors to a red-only palette, assigned to the design.
	palettes := json.RawMessage(`[{"id":"p","name":"P","colors":[{"value":{"srgb":{"r":1,"g":0,"b":0,"a":1}}}]}]`)
	controls := json.RawMessage(`{"lockColors":true}`)
	kit, err := svc.CreateKit(ctx, ws.ID, owner.ID, "Locked", nil)
	if err != nil {
		t.Fatalf("create kit: %v", err)
	}
	if _, err := svc.UpdateKit(ctx, kit.ID, owner.ID, UpdateInput{Palettes: palettes, ControlsRaw: controls}); err != nil {
		t.Fatalf("update kit: %v", err)
	}
	if _, err := svc.AssignDesignBrand(ctx, rec.ID, owner.ID, kit.ID); err != nil {
		t.Fatalf("assign brand: %v", err)
	}

	// A member saving an in-kit (red) design passes.
	if err := svc.ValidateSnapshot(ctx, rec.ID, ws.ID, member.ID, designWithColor(1, 0, 0, "")); err != nil {
		t.Fatalf("in-kit save should pass: %v", err)
	}
	// A member saving an off-kit (blue) design is rejected.
	err = svc.ValidateSnapshot(ctx, rec.ID, ws.ID, member.ID, designWithColor(0, 0, 1, ""))
	if !errors.Is(err, ErrBrandLocked) {
		t.Fatalf("off-kit member save should be ErrBrandLocked, got %v", err)
	}
	// The owner (manage-brand) is never constrained by the lock.
	if err := svc.ValidateSnapshot(ctx, rec.ID, ws.ID, owner.ID, designWithColor(0, 0, 1, "")); err != nil {
		t.Fatalf("owner save should bypass the lock: %v", err)
	}
}
