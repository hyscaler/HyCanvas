package persistence

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/storage"
)

// computeDiff must surface doc.meta changes: the meta-backed document kinds
// (video, doc, sheet) keep their entire content there, so a node-tree-only
// diff reports zero changes for real edits.
func TestComputeDiffMetaChanged(t *testing.T) {
	base := func(meta map[string]any) DesignFile {
		return DesignFile{
			"schemaVersion": float64(currentSchemaVersion),
			"pages":         []any{map[string]any{"id": "p1", "children": []any{}}},
			"meta":          meta,
		}
	}
	from := base(map[string]any{"video": map[string]any{"fps": float64(30)}})
	same := base(map[string]any{"video": map[string]any{"fps": float64(30)}})
	changed := base(map[string]any{"video": map[string]any{"fps": float64(60)}})

	if d := computeDiff(from, same); d.MetaChanged {
		t.Fatalf("identical meta reported changed: %+v", d)
	}
	d := computeDiff(from, changed)
	if !d.MetaChanged {
		t.Fatalf("video meta edit not reported: %+v", d)
	}
	if d.NodesAdded+d.NodesRemoved+d.NodesChanged+d.PagesAdded+d.PagesRemoved != 0 {
		t.Fatalf("meta-only edit should not count node changes: %+v", d)
	}
	// nil vs present meta counts as a change too
	if d := computeDiff(base(nil), changed); !d.MetaChanged {
		t.Fatalf("nil->meta not reported: %+v", d)
	}
}

// failPutStorage fails every Put, to force the first-snapshot write to fail.
type failPutStorage struct{ storage.Driver }

func (f failPutStorage) Put(string, []byte) (storage.PutResult, error) {
	return storage.PutResult{}, errors.New("storage down")
}

func TestVersionHistory_DB(t *testing.T) {
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
	owner, ws, _, err := acct.Signup(ctx, "vh-owner+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	svc := NewService(tx).WithStorage(store)

	rec, err := svc.Create(ctx, ws.ID, "History design", nil, &owner.ID)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// --- a version stored at an OLD schema must come back migrated ---------
	// (Preview, diff, restore, and branch all read through fileForVersion; an
	// unmigrated old snapshot would render a broken document in the client.)
	// The node carries a v5-style animations array, which mapNodesV6 rewrites:
	// if any version-read path skipped migration, the same node would compare
	// unequal between a version file and the migrated current file.
	oldFile := DesignFile{
		"id":            rec.ID,
		"schemaVersion": float64(4), // pre-v5, so the v5->v6 node transform runs
		"title":         "History design",
		"pages": []any{map[string]any{
			"id": "p1", "width": float64(1080), "height": float64(1080),
			"children": []any{map[string]any{
				"id": "n1", "type": "rect",
				"animations": []any{map[string]any{"type": "fadeIn", "durationMs": float64(300)}},
			}},
		}},
		"meta": map[string]any{"video": map[string]any{"fps": float64(30), "tracks": []any{}}},
	}
	if _, _, err := svc.writeSnapshot(ctx, rec.ID, oldFile, KindCheckpoint, nil, &owner.ID); err != nil {
		t.Fatalf("writeSnapshot old-schema: %v", err)
	}
	page, err := svc.ListVersions(ctx, rec.ID, ws.ID, "")
	if err != nil || len(page.Items) == 0 {
		t.Fatalf("ListVersions: %v (%d items)", err, len(page.Items))
	}
	// The old-schema version is the one whose file we just wrote; find it by
	// probing each version's file for our meta marker.
	var oldVersionID, blankVersionID string
	for _, v := range page.Items {
		f, ferr := svc.VersionFile(ctx, rec.ID, ws.ID, v.ID)
		if ferr != nil {
			t.Fatalf("VersionFile %s: %v", v.ID, ferr)
		}
		if sv := schemaVersionOf(f); sv != currentSchemaVersion {
			t.Fatalf("version %s served at schema %d, want %d (unmigrated)", v.ID, sv, currentSchemaVersion)
		}
		if meta := asObj(f["meta"]); asObj(meta["video"]) != nil {
			oldVersionID = v.ID
		} else {
			blankVersionID = v.ID
		}
	}
	if oldVersionID == "" || blankVersionID == "" {
		t.Fatalf("versions not found via VersionFile (old=%q blank=%q)", oldVersionID, blankVersionID)
	}

	// --- phantom-change check: the old-schema version against the CURRENT ---
	// file, which is the same snapshot (writeSnapshot repointed current). Both
	// sides must migrate identically, so the animated node and the file must
	// diff as completely unchanged; any unmigrated side would report the node
	// as changed.
	self, err := svc.Diff(ctx, rec.ID, ws.ID, oldVersionID, "")
	if err != nil {
		t.Fatalf("Diff to current: %v", err)
	}
	if self.NodesChanged != 0 || self.NodesAdded != 0 || self.NodesRemoved != 0 || self.MetaChanged {
		t.Fatalf("schema migration produced a phantom diff against itself: %+v", self)
	}

	// --- real-change check: old version vs the blank first version must ----
	// report the removed node and the meta difference (video timeline vs none).
	sum, err := svc.Diff(ctx, rec.ID, ws.ID, oldVersionID, blankVersionID)
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if sum.NodesRemoved != 1 || sum.NodesAdded != 0 || sum.NodesChanged != 0 {
		t.Fatalf("old->blank should remove exactly the one node: %+v", sum)
	}
	if !sum.MetaChanged {
		t.Fatalf("meta diff (video meta vs blank) not reported: %+v", sum)
	}

	// --- restore round-trips the old version as the current file -----------
	if _, err := svc.Restore(ctx, rec.ID, ws.ID, oldVersionID, &owner.ID); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	loaded, err := svc.LoadFile(ctx, rec.ID, ws.ID)
	if err != nil {
		t.Fatalf("LoadFile after restore: %v", err)
	}
	if schemaVersionOf(loaded.File) != currentSchemaVersion {
		t.Fatalf("restored file schema %d, want %d", schemaVersionOf(loaded.File), currentSchemaVersion)
	}
	if asObj(asObj(loaded.File["meta"])["video"]) == nil {
		t.Fatal("restored file lost meta.video")
	}

	// --- a failed first snapshot must not leave a ghost design row ---------
	failSvc := NewService(tx).WithStorage(failPutStorage{store})
	if _, err := failSvc.Create(ctx, ws.ID, "Ghost design", nil, &owner.ID); err == nil {
		t.Fatal("Create with failing storage should error")
	}
	list, err := svc.ListByWorkspace(ctx, ws.ID, 50)
	if err != nil {
		t.Fatalf("ListByWorkspace: %v", err)
	}
	for _, d := range list {
		if d.Title == "Ghost design" {
			t.Fatal("failed create left a ghost design row")
		}
	}
}
