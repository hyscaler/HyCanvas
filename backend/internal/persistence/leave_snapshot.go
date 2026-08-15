// Server-authoritative fold-and-snapshot (doc 16 FR-11). When the last client
// leaves a design's realtime room, the hub's last-leave hook calls
// SnapshotFoldedUpdateLog: the journaled y-protocols update log is folded into
// the open file format ON THE SERVER (internal/crdt runs the exact client fold
// under an embedded pure-Go JS engine) and recorded as an AUTO snapshot. This
// closes the crashed-tab gap: the client-side idle/pagehide auto-snapshots are
// best-effort, and a client that dies mid-edit leaves its edits journaled but
// never materialized.
//
// Data-safety posture: a snapshot rotates the design's current pointer, so the
// fold is guarded to be strictly CATCH-UP-ONLY. It runs only when the update
// log's tail is NEWER than the design's current snapshot - i.e. exactly when a
// client died before materializing. If the current snapshot postdates the last
// journaled frame (the departing client's own leave snapshot landed, or a
// non-realtime write came in after the session), the fold is skipped, so it
// can never regress a newer state. The update log itself is never touched.
package persistence

import (
	"context"
	"encoding/json"
	"fmt"

	"hycanvas/backend/internal/crdt"
)

// SnapshotFoldedUpdateLog folds the design's full update log and records the
// result as an AUTO snapshot, iff the log tail postdates the current snapshot
// (see the package comment's data-safety posture). Returns true when a new
// snapshot version was created. Server-initiated: the design is resolved
// without a workspace scope and the snapshot is authored by nobody.
func (s *Service) SnapshotFoldedUpdateLog(ctx context.Context, designID string) (bool, error) {
	d, err := s.getDesign(ctx, designID)
	if err != nil {
		return false, ErrNotFound
	}
	if d.DeletedAt != nil {
		return false, nil // trashed mid-session: nothing to materialize
	}

	// Collect every journaled MAIN-lineage frame, oldest first (checkpoint row +
	// tail deltas fold transparently, same as the client scrubber). Branch rows
	// are excluded: a branch's state is its own lineage and must never leak into
	// the design's materialized main state.
	mainScope := []crdtScope{{branchID: nil, capSeq: -1}}
	var frames [][]byte
	var lastAt int64
	after := int64(0)
	for {
		rows, err := s.listUpdateRows(ctx, designID, mainScope, after, updateLogPageSize)
		if err != nil {
			return false, fmt.Errorf("list update log: %w", err)
		}
		if len(rows) == 0 {
			break
		}
		for _, r := range rows {
			frames = append(frames, r.update)
			after = r.seq
			if t := r.createdAt.UnixMilli(); t > lastAt {
				lastAt = t
			}
		}
		if len(rows) < updateLogPageSize {
			break
		}
	}
	if len(frames) == 0 {
		return false, nil // never edited over realtime
	}

	// Catch-up guard: if the design's current snapshot is at least as new as the
	// last journaled frame, a client (or another writer) already materialized
	// this state or a newer one - do not rotate current backwards. Ties skip:
	// prefer a missed no-op over any chance of regression.
	if d.CurrentSnapshot != nil {
		if cur, err := s.getSnapshot(ctx, *d.CurrentSnapshot); err == nil && cur.CreatedAt.UnixMilli() >= lastAt {
			return false, nil
		}
	}

	folded, err := crdt.FoldUpdatesContext(ctx, frames)
	if err != nil {
		return false, fmt.Errorf("fold update log: %w", err)
	}
	var file DesignFile
	if err := json.Unmarshal(folded, &file); err != nil {
		return false, fmt.Errorf("folded file not JSON: %w", err)
	}
	// Snapshot re-validates the file (the same 422 boundary as client saves), so
	// a corrupt or truncated fold can never persist; AUTO dedups unchanged
	// content against the current snapshot.
	prev := ""
	if d.CurrentSnapshot != nil {
		prev = *d.CurrentSnapshot
	}
	rec, err := s.Snapshot(ctx, designID, d.WorkspaceID, file, KindAuto, nil, nil)
	if err != nil {
		return false, fmt.Errorf("snapshot folded state: %w", err)
	}
	return rec.ID != prev, nil
}
