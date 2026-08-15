package persistence

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/storage"
)

// loadFoldFixture reads the crdt package's generated fixture: real journaled
// y-protocols frames plus the DesignFile the client fold produces for them.
func loadFoldFixture(t *testing.T) (frames [][]byte, expected map[string]any) {
	t.Helper()
	raw, err := os.ReadFile("../crdt/testdata/fixture.json")
	if err != nil {
		t.Fatalf("read crdt fixture: %v", err)
	}
	var fx struct {
		Updates  []string       `json:"updates"`
		Expected map[string]any `json:"expected"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("parse crdt fixture: %v", err)
	}
	for _, u := range fx.Updates {
		b, err := base64.StdEncoding.DecodeString(u)
		if err != nil {
			t.Fatalf("decode frame: %v", err)
		}
		frames = append(frames, b)
	}
	return frames, fx.Expected
}

// TestSnapshotFoldedUpdateLog_DB: the server-authoritative last-leave fold
// (doc 16 FR-11). With journaled frames NEWER than the current snapshot, the
// fold materializes an AUTO snapshot of the folded state and rotates the
// design's current pointer; a second call is a no-op (current now postdates
// the log tail); a snapshot landing after the log tail suppresses the fold
// entirely (catch-up-only guard). DATABASE_URL-gated.
func TestSnapshotFoldedUpdateLog_DB(t *testing.T) {
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
	owner, ws, _, err := acct.Signup(ctx, "fold-owner+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	svc := NewService(tx).WithStorage(store)
	rec, err := svc.Create(ctx, ws.ID, "Folded", nil, &owner.ID)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// No updates journaled: nothing to fold.
	if created, err := svc.SnapshotFoldedUpdateLog(ctx, rec.ID); err != nil || created {
		t.Fatalf("empty log fold = (%v, %v), want (false, nil)", created, err)
	}

	// Journal real frames. Inside this wrapping test transaction now() is frozen
	// (every row would share one timestamp and the tie-skipping guard would
	// suppress the fold), so BACKDATE the creation snapshot instead - in
	// production each insert commits separately and orders naturally.
	frames, expected := loadFoldFixture(t)
	for i, f := range frames {
		if err := svc.AppendUpdate(ctx, rec.ID, "", f, owner.ID); err != nil {
			t.Fatalf("AppendUpdate %d: %v", i, err)
		}
	}
	d0, err := svc.getDesign(ctx, rec.ID)
	if err != nil || d0.CurrentSnapshot == nil {
		t.Fatalf("getDesign: %v (snapshot=%v)", err, d0.CurrentSnapshot)
	}
	if _, err := tx.Exec(ctx, `UPDATE "design_snapshots" SET "created_at" = now() - interval '1 minute' WHERE id = $1`, *d0.CurrentSnapshot); err != nil {
		t.Fatalf("backdate creation snapshot: %v", err)
	}

	created, err := svc.SnapshotFoldedUpdateLog(ctx, rec.ID)
	if err != nil {
		t.Fatalf("SnapshotFoldedUpdateLog: %v", err)
	}
	if !created {
		t.Fatal("expected the fold to create a snapshot (log tail newer than current)")
	}

	// The design's CURRENT file is now the folded state.
	d, err := svc.getDesign(ctx, rec.ID)
	if err != nil || d.CurrentSnapshot == nil {
		t.Fatalf("getDesign after fold: %v (snapshot=%v)", err, d.CurrentSnapshot)
	}
	snap, err := svc.getSnapshot(ctx, *d.CurrentSnapshot)
	if err != nil {
		t.Fatalf("getSnapshot: %v", err)
	}
	if snap.Kind != KindAuto {
		t.Fatalf("fold snapshot kind = %q, want auto", snap.Kind)
	}
	got := svc.readFile(ctx, snap)
	if got == nil {
		t.Fatal("folded snapshot blob unreadable")
	}
	// Spot-check the folded content matches the client fold: page + both nodes.
	pages, _ := got["pages"].([]any)
	wantPages, _ := expected["pages"].([]any)
	if len(pages) != len(wantPages) || len(pages) != 1 {
		t.Fatalf("folded pages = %d, want %d", len(pages), len(wantPages))
	}
	pg, _ := pages[0].(map[string]any)
	children, _ := pg["children"].([]any)
	if len(children) != 2 {
		t.Fatalf("folded children = %d, want 2 (shape + text)", len(children))
	}

	// Second fold: current snapshot now postdates the log tail - catch-up guard
	// makes it a no-op.
	if created, err := svc.SnapshotFoldedUpdateLog(ctx, rec.ID); err != nil || created {
		t.Fatalf("re-fold = (%v, %v), want (false, nil)", created, err)
	}

	// A newer explicit snapshot (a client save after the last journaled frame)
	// suppresses the fold: the guard must never rotate current backwards.
	// Forward-date it explicitly (frozen now() again).
	newer := got
	newer["title"] = "client saved after the session"
	saved, err := svc.Snapshot(ctx, rec.ID, ws.ID, newer, KindNamed, nil, &owner.ID)
	if err != nil {
		t.Fatalf("newer snapshot: %v", err)
	}
	if _, err := tx.Exec(ctx, `UPDATE "design_snapshots" SET "created_at" = now() + interval '1 minute' WHERE id = $1`, saved.ID); err != nil {
		t.Fatalf("forward-date newer snapshot: %v", err)
	}
	if created, err := svc.SnapshotFoldedUpdateLog(ctx, rec.ID); err != nil || created {
		t.Fatalf("fold past a newer save = (%v, %v), want (false, nil)", created, err)
	}
	d2, _ := svc.getDesign(ctx, rec.ID)
	cur, err := svc.getSnapshot(ctx, *d2.CurrentSnapshot)
	if err != nil || cur.Kind != KindNamed {
		t.Fatalf("current must remain the newer save (kind=%v, err=%v)", cur.Kind, err)
	}
}
