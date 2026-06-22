package persistence

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/storage"
)

func TestPersistenceLifecycle_DB(t *testing.T) {
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
	owner, ws, _, err := acct.Signup(ctx, "pers-owner+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	svc := NewService(tx).WithStorage(store)

	// Create a blank design.
	rec, err := svc.Create(ctx, ws.ID, "My Design", nil, &owner.ID)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if rec.CurrentSnapshot == nil || rec.SchemaVersion != currentSchemaVersion {
		t.Fatalf("create record wrong: %+v", rec)
	}

	// Capture the blank (create) version id now, before more versions exist.
	// (The test runs in one transaction, so now() is frozen and createdAt ties;
	// capturing the id up front avoids relying on version ordering.)
	v0, err := svc.ListVersions(ctx, rec.ID, ws.ID, "")
	if err != nil || len(v0.Items) != 1 {
		t.Fatalf("initial versions wrong: %+v err=%v", v0.Items, err)
	}
	blankVersionID := v0.Items[0].ID

	// Load the file back; it has the blank white page.
	loaded, err := svc.LoadFile(ctx, rec.ID, ws.ID)
	if err != nil {
		t.Fatalf("LoadFile: %v", err)
	}
	if loaded.Recovered {
		t.Fatal("fresh design should not be recovered")
	}
	pages, _ := loaded.File["pages"].([]any)
	if len(pages) != 1 {
		t.Fatalf("blank design should have 1 page, got %d", len(pages))
	}

	// Save a snapshot that adds a node, then verify load reflects it.
	file := loaded.File
	page0 := pages[0].(map[string]any)
	page0["children"] = []any{map[string]any{"id": "node-1", "type": "rect"}}
	snap, err := svc.Snapshot(ctx, rec.ID, ws.ID, file, KindCheckpoint, nil, &owner.ID)
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if snap.Kind != KindCheckpoint {
		t.Fatalf("snapshot kind = %s", snap.Kind)
	}
	reloaded, _ := svc.LoadFile(ctx, rec.ID, ws.ID)
	if len(CollectNodeIDs(reloaded.File)) != 1 {
		t.Fatalf("node not persisted: %v", CollectNodeIDs(reloaded.File))
	}

	// AUTO snapshot of identical content dedups (no new version).
	before, _ := svc.ListVersions(ctx, rec.ID, ws.ID, "")
	if _, err := svc.Snapshot(ctx, rec.ID, ws.ID, reloaded.File, KindAuto, nil, &owner.ID); err != nil {
		t.Fatalf("auto snapshot: %v", err)
	}
	after, _ := svc.ListVersions(ctx, rec.ID, ws.ID, "")
	if len(after.Items) != len(before.Items) {
		t.Fatalf("auto dedup failed: %d -> %d", len(before.Items), len(after.Items))
	}

	// Versions: create (v1), checkpoint (v2). Newest first, author resolved.
	versions := after.Items
	if len(versions) != 2 {
		t.Fatalf("expected 2 versions, got %d", len(versions))
	}
	if versions[0].Author == nil || versions[0].Author.Name != "Owner" {
		t.Fatalf("author not resolved: %+v", versions[0].Author)
	}
	firstVersionID := blankVersionID // the blank create, captured up front

	// Diff from the first version to current shows the added node.
	diff, err := svc.Diff(ctx, rec.ID, ws.ID, firstVersionID, "")
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if diff.NodesAdded != 1 {
		t.Fatalf("diff should show 1 added node: %+v", diff)
	}

	// Restore the first (blank) version -> new restore version, file blank again.
	if _, err := svc.Restore(ctx, rec.ID, ws.ID, firstVersionID, &owner.ID); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	restored, _ := svc.LoadFile(ctx, rec.ID, ws.ID)
	if len(CollectNodeIDs(restored.File)) != 0 {
		t.Fatalf("restore should revert to blank: %v", CollectNodeIDs(restored.File))
	}

	// Branch from the first version into a new design.
	branch, err := svc.Branch(ctx, rec.ID, ws.ID, firstVersionID, "Branch A", &owner.ID)
	if err != nil {
		t.Fatalf("Branch: %v", err)
	}
	if branch.SourceDesignID == nil || *branch.SourceDesignID != rec.ID {
		t.Fatalf("branch lineage wrong: %+v", branch)
	}
	branches, _ := svc.ListBranches(ctx, rec.ID, ws.ID)
	if len(branches) != 1 || branches[0].ID != branch.ID {
		t.Fatalf("branches wrong: %+v", branches)
	}

	// Brand-meta: assign a kit, read it back, pin a version, locked regions.
	if err := svc.SetActiveBrandKit(ctx, rec.ID, ws.ID, "kit-123", &owner.ID); err != nil {
		t.Fatalf("SetActiveBrandKit: %v", err)
	}
	if id, _ := svc.GetActiveBrandKitID(ctx, rec.ID, ws.ID); id != "kit-123" {
		t.Fatalf("brand kit id = %q", id)
	}
	if err := svc.SetActiveBrandKitVersion(ctx, rec.ID, ws.ID, 4, &owner.ID); err != nil {
		t.Fatalf("SetActiveBrandKitVersion: %v", err)
	}
	if v, _ := svc.GetActiveBrandKitVersion(ctx, rec.ID, ws.ID); v != 4 {
		t.Fatalf("pinned version = %d", v)
	}
	if _, err := svc.SetLockedRegions(ctx, rec.ID, ws.ID, []string{"n1", "n2"}, &owner.ID); err != nil {
		t.Fatalf("SetLockedRegions: %v", err)
	}
	if locked, _ := svc.GetLockedRegions(ctx, rec.ID, ws.ID); len(locked) != 2 || locked[0] != "n1" {
		t.Fatalf("locked regions = %v", locked)
	}

	// Trash: soft-delete hides it, trash lists it, restore brings it back.
	if err := svc.SoftDelete(ctx, rec.ID, ws.ID); err != nil {
		t.Fatalf("SoftDelete: %v", err)
	}
	if _, err := svc.LoadFile(ctx, rec.ID, ws.ID); err != ErrNotFound {
		t.Fatalf("trashed design should be NotFound on load, got %v", err)
	}
	trash, _ := svc.ListTrash(ctx, ws.ID)
	foundTrash := false
	for _, d := range trash {
		if d.ID == rec.ID {
			foundTrash = true
		}
	}
	if !foundTrash {
		t.Fatalf("design not in trash: %+v", trash)
	}
	if err := svc.RestoreFromTrash(ctx, rec.ID, ws.ID); err != nil {
		t.Fatalf("RestoreFromTrash: %v", err)
	}
	if _, err := svc.LoadFile(ctx, rec.ID, ws.ID); err != nil {
		t.Fatalf("restored design should load: %v", err)
	}

	// Cross-workspace access is NotFound.
	if _, err := svc.LoadFile(ctx, rec.ID, uuid.NewString()); err != ErrNotFound {
		t.Fatalf("cross-workspace load should be NotFound, got %v", err)
	}

	// Purge hard-deletes.
	if err := svc.Purge(ctx, rec.ID, ws.ID); err != nil {
		t.Fatalf("Purge: %v", err)
	}
	if _, err := svc.getDesign(ctx, rec.ID); err != ErrNotFound {
		t.Fatalf("purged design should be gone, got %v", err)
	}
}
