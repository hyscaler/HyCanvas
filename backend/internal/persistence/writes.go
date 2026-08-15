// Save/load lifecycle, version history, branches, trash, and recovery (doc 04).
// Snapshots are content-addressed blobs in storage; the Design row's
// currentSnapshotId points at the latest. All methods are workspace-scoped: a
// design that does not belong to the workspace reports NotFound so cross-
// workspace probing is impossible.
package persistence

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// ErrNotFound is returned when a design/snapshot/version does not exist or is
// not visible to the workspace.
var ErrNotFound = errors.New("not found")

// ErrNoStorage is returned when a write-lifecycle method is called on a service
// constructed without a storage driver.
var ErrNoStorage = errors.New("persistence storage driver not configured")

// requireDesign loads a design row scoped to a workspace. Trashed designs are
// hidden unless includeTrashed.
func (s *Service) requireDesign(ctx context.Context, designID, workspaceID string, includeTrashed bool) (designRow, error) {
	d, err := s.getDesign(ctx, designID)
	if err != nil {
		return designRow{}, ErrNotFound
	}
	if d.WorkspaceID != workspaceID {
		return designRow{}, ErrNotFound
	}
	if d.DeletedAt != nil && !includeTrashed {
		return designRow{}, ErrNotFound
	}
	return d, nil
}

// writeSnapshot serializes the file, stores the content-addressed blob, and
// records snapshot + version, then points the design at the new snapshot.
func (s *Service) writeSnapshot(ctx context.Context, designID string, file DesignFile, kind SnapshotKind, label, authorID *string) (snapshotRow, versionRow, error) {
	if s.storage == nil {
		return snapshotRow{}, versionRow{}, ErrNoStorage
	}
	buf, err := serialize(file)
	if err != nil {
		return snapshotRow{}, versionRow{}, err
	}
	sum := checksum(buf)
	put, err := s.storage.Put(snapshotKey(designID, sum), buf) // content-addressed: dedups blobs
	if err != nil {
		return snapshotRow{}, versionRow{}, err
	}
	sv := schemaVersionOf(file)
	snap, err := s.createSnapshot(ctx, createSnapshotInput{
		designID: designID, blobURL: put.Key, checksum: sum, schemaVersion: sv,
		sizeBytes: put.Size, kind: kind, authorID: authorID,
	})
	if err != nil {
		return snapshotRow{}, versionRow{}, err
	}
	ver, err := s.createVersion(ctx, createVersionInput{designID: designID, snapshotID: snap.ID, label: label, authorID: authorID})
	if err != nil {
		return snapshotRow{}, versionRow{}, err
	}
	if _, err := s.updateDesign(ctx, designID, designPatch{currentSnapshotID: &snap.ID, schemaVersion: &sv}); err != nil {
		return snapshotRow{}, versionRow{}, err
	}
	return snap, ver, nil
}

// readFile loads + integrity-checks a snapshot blob. Returns nil when the blob
// is missing, corrupt (checksum mismatch), unparseable, or structurally invalid.
func (s *Service) readFile(ctx context.Context, snap snapshotRow) DesignFile {
	buf, err := s.storage.Get(snap.BlobURL)
	if err != nil || buf == nil {
		return nil
	}
	if checksum(buf) != snap.Checksum {
		return nil
	}
	var file DesignFile
	if err := json.Unmarshal(buf, &file); err != nil {
		return nil
	}
	if !validFile(file) {
		return nil
	}
	return file
}

// --- create / load -------------------------------------------------------

// Create makes a new design + its first snapshot (a blank design, or one seeded
// from `from`).
func (s *Service) Create(ctx context.Context, workspaceID, title string, from DesignFile, authorID *string) (DesignRecord, error) {
	if s.storage == nil {
		return DesignRecord{}, ErrNoStorage
	}
	if title == "" {
		title = "Untitled design"
	}
	var docKind *string
	if from != nil {
		// Validate a client-supplied seed file BEFORE inserting the design row, so a
		// malformed `from` is rejected (ErrInvalidFile -> 422) without leaving an
		// orphan design with no snapshot. The probe id satisfies the id check; the
		// real id is assigned by withID below.
		if err := validateForWrite(withID(from, "create-probe")); err != nil {
			return DesignRecord{}, err
		}
		if k := docKindOf(from); k != "" {
			docKind = &k
		}
	}
	d, err := s.createDesign(ctx, createDesignInput{
		workspaceID: workspaceID, title: title, schemaVersion: currentSchemaVersion,
		docKind: docKind, createdByID: authorID,
	})
	if err != nil {
		return DesignRecord{}, err
	}
	file := from
	if file == nil {
		file = createBlankDesign(d.ID, title)
	}
	file = withID(file, d.ID)
	file["title"] = title
	if _, _, err := s.writeSnapshot(ctx, d.ID, file, KindCheckpoint, nil, authorID); err != nil {
		// Compensating cleanup: without a first snapshot the design row is a
		// ghost card that lists on the dashboard but can never open. Row deletes
		// cascade to any partial snapshot/version rows; blob deletion is
		// best-effort (content-addressed, so an orphan blob is harmless).
		// Detached from the request context: a client disconnect mid-write is a
		// primary cause of the failure, and the cleanup must still run then.
		cctx := context.WithoutCancel(ctx)
		if snaps, lerr := s.listSnapshots(cctx, d.ID); lerr == nil {
			for _, snap := range snaps {
				_ = s.storage.Delete(snap.BlobURL)
			}
		}
		_ = s.hardDeleteDesign(cctx, d.ID)
		return DesignRecord{}, err
	}
	fresh, err := s.getDesign(ctx, d.ID)
	if err != nil {
		return DesignRecord{}, err
	}
	return toRecord(fresh), nil
}

// LoadFile returns the design's current file, recovering an older valid snapshot
// when the current blob is unreadable (doc 04 FR-13).
func (s *Service) LoadFile(ctx context.Context, designID, workspaceID string) (LoadResult, error) {
	return s.loadFile(ctx, designID, workspaceID, false)
}

// LoadFileIncludingTrashed also serves designs sitting in the trash. Reserved
// for read-only, member-facing surfaces (the Trash view's preview thumbnails,
// where restore decisions need to see the design); every editing and export
// path keeps using LoadFile so trashed designs stay inaccessible there until
// restored.
func (s *Service) LoadFileIncludingTrashed(ctx context.Context, designID, workspaceID string) (LoadResult, error) {
	return s.loadFile(ctx, designID, workspaceID, true)
}

func (s *Service) loadFile(ctx context.Context, designID, workspaceID string, includeTrashed bool) (LoadResult, error) {
	if s.storage == nil {
		return LoadResult{}, ErrNoStorage
	}
	d, err := s.requireDesign(ctx, designID, workspaceID, includeTrashed)
	if err != nil {
		return LoadResult{}, err
	}
	if d.CurrentSnapshot == nil {
		return LoadResult{}, ErrNotFound
	}
	var file DesignFile
	recovered := false
	if cur, err := s.getSnapshot(ctx, *d.CurrentSnapshot); err == nil {
		file = s.readFile(ctx, cur)
	}
	if file == nil {
		snaps, err := s.listSnapshots(ctx, designID)
		if err != nil {
			return LoadResult{}, err
		}
		for _, snap := range snaps {
			if d.CurrentSnapshot != nil && snap.ID == *d.CurrentSnapshot {
				continue
			}
			if candidate := s.readFile(ctx, snap); candidate != nil {
				file = candidate
				recovered = true
				break
			}
		}
	}
	if file == nil {
		return LoadResult{}, ErrNotFound
	}
	// Forward-migrate an older stored file to the current schema (the Go service
	// is the sole backend, so it migrates rather than round-tripping verbatim).
	return LoadResult{Record: toRecord(d), File: migrateFile(file), Recovered: recovered}, nil
}

// Snapshot records a new snapshot/version of the file. AUTO snapshots whose
// content is unchanged from the current snapshot are deduped (doc 04 FR-14).
func (s *Service) Snapshot(ctx context.Context, designID, workspaceID string, file DesignFile, kind SnapshotKind, label, authorID *string) (SnapshotRecord, error) {
	if s.storage == nil {
		return SnapshotRecord{}, ErrNoStorage
	}
	d, err := s.requireDesign(ctx, designID, workspaceID, false)
	if err != nil {
		return SnapshotRecord{}, err
	}
	stored := withID(file, designID)
	if err := validateForWrite(stored); err != nil {
		return SnapshotRecord{}, err // ErrInvalidFile: reject before it persists
	}
	buf, err := serialize(stored)
	if err != nil {
		return SnapshotRecord{}, err
	}
	sum := checksum(buf)
	if kind == KindAuto && d.CurrentSnapshot != nil {
		if cur, err := s.getSnapshot(ctx, *d.CurrentSnapshot); err == nil && cur.Checksum == sum {
			return toSnapshotRecord(cur), nil
		}
	}
	snap, _, err := s.writeSnapshot(ctx, designID, stored, kind, label, authorID)
	if err != nil {
		return SnapshotRecord{}, err
	}
	return toSnapshotRecord(snap), nil
}

// --- versions ------------------------------------------------------------

const versionPageSize = 50

// VersionPage is the paginated version-history result.
type VersionPage struct {
	Items      []VersionEntry `json:"items"`
	NextCursor *string        `json:"nextCursor,omitempty"`
}

func (s *Service) ListVersions(ctx context.Context, designID, workspaceID, cursor string) (VersionPage, error) {
	if _, err := s.requireDesign(ctx, designID, workspaceID, false); err != nil {
		return VersionPage{}, err
	}
	var before *time.Time
	if cursor != "" {
		if t, err := time.Parse(time.RFC3339Nano, cursor); err == nil {
			before = &t
		}
	}
	rows, err := s.listVersionRows(ctx, designID, versionPageSize+1, before)
	if err != nil {
		return VersionPage{}, err
	}
	hasMore := len(rows) > versionPageSize
	if hasMore {
		rows = rows[:versionPageSize]
	}
	// Resolve author names + snapshot kinds in one batch each.
	idset := map[string]bool{}
	for _, v := range rows {
		if v.AuthorID != nil {
			idset[*v.AuthorID] = true
		}
	}
	ids := make([]string, 0, len(idset))
	for id := range idset {
		ids = append(ids, id)
	}
	names, err := s.getUserNames(ctx, ids)
	if err != nil {
		return VersionPage{}, err
	}
	snaps, err := s.listSnapshots(ctx, designID)
	if err != nil {
		return VersionPage{}, err
	}
	kindBySnap := map[string]SnapshotKind{}
	for _, sn := range snaps {
		kindBySnap[sn.ID] = sn.Kind
	}
	items := make([]VersionEntry, 0, len(rows))
	for _, v := range rows {
		name := ""
		if v.AuthorID != nil {
			name = names[*v.AuthorID]
		}
		items = append(items, toVersionEntry(v, name, kindBySnap[v.SnapshotID]))
	}
	page := VersionPage{Items: items}
	if hasMore && len(items) > 0 {
		last := items[len(items)-1].CreatedAt
		page.NextCursor = &last
	}
	return page, nil
}

func (s *Service) fileForVersion(ctx context.Context, designID, versionID string) (DesignFile, error) {
	v, err := s.getVersion(ctx, versionID)
	if err != nil || v.DesignID != designID {
		return nil, ErrNotFound
	}
	snap, err := s.getSnapshot(ctx, v.SnapshotID)
	if err != nil {
		return nil, ErrNotFound
	}
	file := s.readFile(ctx, snap)
	if file == nil {
		return nil, ErrNotFound
	}
	// Forward-migrate like loadFile does: a version snapshot written by an older
	// build must preview, diff, restore, and branch as a current-schema file
	// (migrations are forward-only and idempotent, so this never alters
	// already-current files).
	return migrateFile(file), nil
}

// VersionFile returns a historical version's file (read-only), workspace-scoped.
func (s *Service) VersionFile(ctx context.Context, designID, workspaceID, versionID string) (DesignFile, error) {
	if _, err := s.requireDesign(ctx, designID, workspaceID, false); err != nil {
		return nil, err
	}
	return s.fileForVersion(ctx, designID, versionID)
}

// Diff computes the structural diff from one version to another (or to the
// current file). A diff against current is cached on the from-version.
func (s *Service) Diff(ctx context.Context, designID, workspaceID, fromVersionID, toVersionID string) (DiffSummary, error) {
	if _, err := s.requireDesign(ctx, designID, workspaceID, false); err != nil {
		return DiffSummary{}, err
	}
	fromFile, err := s.fileForVersion(ctx, designID, fromVersionID)
	if err != nil {
		return DiffSummary{}, err
	}
	var toFile DesignFile
	if toVersionID != "" {
		toFile, err = s.fileForVersion(ctx, designID, toVersionID)
		if err != nil {
			return DiffSummary{}, err
		}
	} else {
		loaded, err := s.LoadFile(ctx, designID, workspaceID)
		if err != nil {
			return DiffSummary{}, err
		}
		toFile = loaded.File
	}
	summary := computeDiff(fromFile, toFile)
	if toVersionID == "" {
		_ = s.setVersionDiff(ctx, fromVersionID, summary)
	}
	return summary, nil
}

// Restore records a new "restore" snapshot from a prior version (non-destructive).
func (s *Service) Restore(ctx context.Context, designID, workspaceID, versionID string, authorID *string) (VersionEntry, error) {
	if _, err := s.requireDesign(ctx, designID, workspaceID, false); err != nil {
		return VersionEntry{}, err
	}
	file, err := s.fileForVersion(ctx, designID, versionID)
	if err != nil {
		return VersionEntry{}, err
	}
	label := "Restored from version " + versionID
	_, ver, err := s.writeSnapshot(ctx, designID, withID(file, designID), KindRestore, &label, authorID)
	if err != nil {
		return VersionEntry{}, err
	}
	return toVersionEntry(ver, "", KindRestore), nil
}

// Branch forks a design from a version into a new design (FR-10).
func (s *Service) Branch(ctx context.Context, designID, workspaceID, versionID, title string, authorID *string) (DesignRecord, error) {
	if _, err := s.requireDesign(ctx, designID, workspaceID, false); err != nil {
		return DesignRecord{}, err
	}
	file, err := s.fileForVersion(ctx, designID, versionID)
	if err != nil {
		return DesignRecord{}, err
	}
	if title == "" {
		title = "Untitled copy"
	}
	var docKind *string
	if k := docKindOf(file); k != "" {
		docKind = &k
	}
	src, ver := designID, versionID
	newDesign, err := s.createDesign(ctx, createDesignInput{
		workspaceID: workspaceID, title: title, schemaVersion: schemaVersionOf(file),
		docKind: docKind, createdByID: authorID, sourceDesignID: &src, sourceVersionID: &ver,
	})
	if err != nil {
		return DesignRecord{}, err
	}
	branched := withID(file, newDesign.ID)
	branched["title"] = title
	if _, _, err := s.writeSnapshot(ctx, newDesign.ID, branched, KindBranch, nil, authorID); err != nil {
		return DesignRecord{}, err
	}
	fresh, err := s.getDesign(ctx, newDesign.ID)
	if err != nil {
		return DesignRecord{}, err
	}
	return toRecord(fresh), nil
}

// ListBranches returns designs forked from this design (FR-10).
func (s *Service) ListBranches(ctx context.Context, designID, workspaceID string) ([]BranchEntry, error) {
	if _, err := s.requireDesign(ctx, designID, workspaceID, false); err != nil {
		return nil, err
	}
	rows, err := s.listBranchRows(ctx, designID)
	if err != nil {
		return nil, err
	}
	out := make([]BranchEntry, 0, len(rows))
	for _, d := range rows {
		out = append(out, BranchEntry{
			ID: d.ID, Title: d.Title, SourceDesignID: d.SourceDesignID, SourceVersionID: d.SourceVersionID,
			CreatedAt: d.CreatedAt.UTC().Format(iso), UpdatedAt: d.UpdatedAt.UTC().Format(iso),
		})
	}
	return out, nil
}

// --- trash + rename ------------------------------------------------------

func (s *Service) SoftDelete(ctx context.Context, designID, workspaceID string) error {
	if _, err := s.requireDesign(ctx, designID, workspaceID, false); err != nil {
		return err
	}
	now := time.Now()
	purge := now.Add(retentionDays * 24 * time.Hour)
	_, err := s.updateDesign(ctx, designID, designPatch{deletedAtSet: true, deletedAt: &now, purgeAfter: &purge})
	return err
}

func (s *Service) RestoreFromTrash(ctx context.Context, designID, workspaceID string) error {
	if _, err := s.requireDesign(ctx, designID, workspaceID, true); err != nil {
		return err
	}
	_, err := s.updateDesign(ctx, designID, designPatch{deletedAtSet: true, deletedAt: nil, purgeAfter: nil})
	return err
}

func (s *Service) ListTrash(ctx context.Context, workspaceID string) ([]DesignRecord, error) {
	rows, err := s.listTrashRows(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	out := make([]DesignRecord, 0, len(rows))
	for _, d := range rows {
		out = append(out, toRecord(d))
	}
	return out, nil
}

func (s *Service) Rename(ctx context.Context, designID, workspaceID, title string) (DesignRecord, error) {
	if _, err := s.requireDesign(ctx, designID, workspaceID, false); err != nil {
		return DesignRecord{}, err
	}
	d, err := s.updateDesign(ctx, designID, designPatch{title: &title})
	if err != nil {
		return DesignRecord{}, err
	}
	return toRecord(d), nil
}

// Purge hard-deletes a design and its (content-addressed, possibly shared)
// snapshot blobs (FR-9, worker-invoked).
func (s *Service) Purge(ctx context.Context, designID, workspaceID string) error {
	if s.storage == nil {
		return ErrNoStorage
	}
	if _, err := s.requireDesign(ctx, designID, workspaceID, true); err != nil {
		return err
	}
	snaps, err := s.listSnapshots(ctx, designID)
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, snap := range snaps {
		if seen[snap.BlobURL] {
			continue
		}
		seen[snap.BlobURL] = true
		_ = s.storage.Delete(snap.BlobURL)
	}
	return s.hardDeleteDesign(ctx, designID)
}

// AppendUpdate journals a realtime document update to the DesignUpdateLog
// (doc 16): the per-design seq is the running max + 1, the Yjs update bytes are
// stored inline. Best-effort durability journal alongside snapshots.
func (s *Service) AppendUpdate(ctx context.Context, designID, branchID string, update []byte, authorID string) error {
	var author *string
	if authorID != "" {
		author = &authorID
	}
	// branchID "" journals to the main lineage (branch_id NULL). seq is assigned
	// from the DESIGN-global max across all lineages, which keeps every branch's
	// combined parent-prefix + own-rows stream in one ascending seq order (the
	// property ListBranchUpdates' single-cursor paging relies on).
	var branch *string
	if branchID != "" {
		branch = &branchID
	}
	const q = `INSERT INTO "design_update_logs" ("design_id", "branch_id", seq, update, "author_id")
		VALUES ($1, $4, (SELECT COALESCE(MAX(seq),0)+1 FROM "design_update_logs" WHERE "design_id" = $1), $2, $3)`
	_, err := s.db.Exec(ctx, q, designID, update, author, branch)
	return err
}

// AppendCheckpoint journals a CRDT FULL-STATE update (client-produced via Yjs
// encodeStateAsUpdate) as a checkpoint row and compacts the log within ITS OWN
// lineage scope (doc 16 FR-11): older rows of the same scope are deleted, so
// the scope stays bounded - a checkpoint plus the deltas since - and the
// history scrubber folds checkpoint-then-tail (the full-state row reconstructs
// the base on the same CRDT identity space before the tail deltas apply).
// Insert + delete run as one data-modifying CTE, so the checkpoint is never
// deleted by its own compaction and the two can't interleave.
//
// BRANCH SAFETY (FR-10): compaction never deletes rows at or below the newest
// fork point of a dependent branch. A branch's base is the parent lineage's
// prefix up to forked_from_seq; deleting any of those rows would corrupt the
// branch's fold (the checkpoint's full state is too new to substitute - it
// includes edits the branch forked before). The guard keeps the needed prefix
// and compacts only the rows past it.
func (s *Service) AppendCheckpoint(ctx context.Context, designID, branchID string, update []byte, authorID string) error {
	var author *string
	if authorID != "" {
		author = &authorID
	}
	var branch *string
	if branchID != "" {
		branch = &branchID
	}
	// Compaction and branch creation must not interleave: a branch created
	// while this statement runs would not be visible to the fork guard below,
	// and its base prefix would be deleted out from under it. Both paths take
	// the same design-scoped transaction lock, so one always sees the other.
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockDesignLineage(ctx, tx, designID); err != nil {
		return err
	}
	const q = `WITH ins AS (
		INSERT INTO "design_update_logs" ("design_id", "branch_id", seq, update, "author_id", "is_checkpoint")
		VALUES ($1, $4, (SELECT COALESCE(MAX(seq),0)+1 FROM "design_update_logs" WHERE "design_id" = $1), $2, $3, true)
		RETURNING seq
	)
	DELETE FROM "design_update_logs"
	WHERE "design_id" = $1 AND "branch_id" IS NOT DISTINCT FROM $4
		AND seq < (SELECT seq FROM ins)
		AND seq > COALESCE((SELECT MAX("forked_from_seq") FROM "design_branches"
			WHERE "design_id" = $1 AND "parent_branch_id" IS NOT DISTINCT FROM $4), 0)`
	if _, err := tx.Exec(ctx, q, designID, update, author, branch); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// lockDesignLineage takes a transaction-scoped advisory lock keyed on the
// design, serializing the two writers that can invalidate each other's view of
// the update log: checkpoint compaction (which deletes a prefix) and branch
// creation (which claims one as its base). Released on commit or rollback.
func lockDesignLineage(ctx context.Context, tx pgx.Tx, designID string) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "design-lineage:"+designID)
	return err
}

// --- DTO mappers ---------------------------------------------------------

func toRecord(d designRow) DesignRecord {
	return DesignRecord{
		ID: d.ID, WorkspaceID: d.WorkspaceID, Title: d.Title, SchemaVersion: d.SchemaVersion,
		DocKind: d.DocKind, CurrentSnapshot: d.CurrentSnapshot,
		CreatedAt: d.CreatedAt.UTC().Format(iso), UpdatedAt: d.UpdatedAt.UTC().Format(iso),
		DeletedAt: isoPtr(d.DeletedAt), PurgeAfter: isoPtr(d.PurgeAfter),
		SourceDesignID: d.SourceDesignID, SourceVersionID: d.SourceVersionID,
	}
}

func toSnapshotRecord(r snapshotRow) SnapshotRecord {
	return SnapshotRecord{
		ID: r.ID, DesignID: r.DesignID, BlobURL: r.BlobURL, Checksum: r.Checksum,
		SchemaVersion: r.SchemaVersion, SizeBytes: r.SizeBytes, AuthorID: r.AuthorID,
		CreatedAt: r.CreatedAt.UTC().Format(iso), Kind: r.Kind,
	}
}

func toVersionEntry(v versionRow, authorName string, kind SnapshotKind) VersionEntry {
	var author *VersionAuthor
	if v.AuthorID != nil && authorName != "" {
		author = &VersionAuthor{ID: *v.AuthorID, Name: authorName}
	}
	return VersionEntry{
		ID: v.ID, DesignID: v.DesignID, SnapshotID: v.SnapshotID, Label: v.Label,
		AuthorID: v.AuthorID, Author: author, Kind: kind,
		CreatedAt: v.CreatedAt.UTC().Format(iso), DiffSummary: v.DiffSummary,
	}
}
