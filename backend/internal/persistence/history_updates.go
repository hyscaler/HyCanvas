// CRDT edit-history update log (doc 16 FR-9, the history "time machine").
// The append-only DesignUpdateLog (journaled by the realtime hub) is served in
// seq order so a client can fold the raw Yjs update frames into an ephemeral
// Y.Doc and preview/scrub any point in history. The interactive scrubber folds
// client-side (where Yjs lives); the SERVER can now also fold when it must -
// internal/crdt embeds the same fold under a pure-Go JS engine (see
// leave_snapshot.go for the last-leave materialization) - so here we only page
// out the opaque frames with author + timestamp metadata.
package persistence

import (
	"context"
	"encoding/base64"
	"fmt"
	"time"
)

// UpdateLogEntry is one journaled realtime update: a base64-encoded y-protocols
// update frame (the exact bytes the hub journaled) plus its author and time.
type UpdateLogEntry struct {
	Seq        int64   `json:"seq"`
	AuthorID   *string `json:"authorId,omitempty"`
	AuthorName string  `json:"authorName,omitempty"`
	Update     string  `json:"update"` // base64 y-protocols sync update (type 2)
	CreatedAt  string  `json:"createdAt"`
	// IsCheckpoint marks a full-state row that begins a compacted log; the client
	// folds from it as the base, then applies the tail deltas (FR-11).
	IsCheckpoint bool `json:"isCheckpoint,omitempty"`
}

// UpdateLogPage is a forward-paginated, ascending-seq slice of the update log.
type UpdateLogPage struct {
	Items   []UpdateLogEntry `json:"items"`
	NextSeq *int64           `json:"nextSeq,omitempty"` // pass back as afterSeq for the next page
}

const updateLogPageSize = 500

// ListUpdates returns the MAIN lineage's rows with seq > afterSeq in ascending
// seq order (oldest first, the order a client folds them), workspace-scoped.
// afterSeq = 0 starts from the beginning of history.
func (s *Service) ListUpdates(ctx context.Context, designID, workspaceID string, afterSeq int64, limit int) (UpdateLogPage, error) {
	return s.ListBranchUpdates(ctx, designID, workspaceID, "", afterSeq, limit)
}

// ListBranchUpdates is ListUpdates for an in-CRDT branch lineage (doc 16
// FR-10): the parent lineage's prefix (rows up to each fork point) followed by
// the branch's own rows. All rows share the design-global seq space and every
// prefix row predates the fork, so the combined stream is a single ascending
// seq order and pages with the same afterSeq cursor as main history. branchID
// "" is the main lineage.
func (s *Service) ListBranchUpdates(ctx context.Context, designID, workspaceID, branchID string, afterSeq int64, limit int) (UpdateLogPage, error) {
	if _, err := s.requireDesign(ctx, designID, workspaceID, false); err != nil {
		return UpdateLogPage{}, err
	}
	scopes, err := s.crdtLineageScopes(ctx, designID, branchID)
	if err != nil {
		return UpdateLogPage{}, err
	}
	if limit <= 0 || limit > updateLogPageSize {
		limit = updateLogPageSize
	}
	rows, err := s.listUpdateRows(ctx, designID, scopes, afterSeq, limit+1)
	if err != nil {
		return UpdateLogPage{}, err
	}
	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}
	idset := map[string]bool{}
	for _, r := range rows {
		if r.authorID != nil {
			idset[*r.authorID] = true
		}
	}
	ids := make([]string, 0, len(idset))
	for id := range idset {
		ids = append(ids, id)
	}
	names, err := s.getUserNames(ctx, ids)
	if err != nil {
		return UpdateLogPage{}, err
	}
	items := make([]UpdateLogEntry, 0, len(rows))
	for _, r := range rows {
		name := ""
		if r.authorID != nil {
			name = names[*r.authorID]
		}
		items = append(items, UpdateLogEntry{
			Seq:          r.seq,
			AuthorID:     r.authorID,
			AuthorName:   name,
			Update:       base64.StdEncoding.EncodeToString(r.update),
			CreatedAt:    r.createdAt.UTC().Format(iso),
			IsCheckpoint: r.isCheckpoint,
		})
	}
	page := UpdateLogPage{Items: items}
	if hasMore && len(items) > 0 {
		last := items[len(items)-1].Seq
		page.NextSeq = &last
	}
	return page, nil
}

type updateLogRow struct {
	seq          int64
	update       []byte
	blobURL      *string
	authorID     *string
	createdAt    time.Time
	isCheckpoint bool
}

func (s *Service) listUpdateRows(ctx context.Context, designID string, scopes []crdtScope, afterSeq int64, limit int) ([]updateLogRow, error) {
	// id is the tiebreak so a same-seq pair (possible under the racy MAX(seq)+1
	// assignment with no unique constraint) folds in a stable, deterministic order.
	// The scope predicate selects the lineage: main (branch NULL, uncapped) or a
	// branch's parent-prefix segments plus its own rows (branches_crdt.go).
	args := []any{designID, afterSeq, limit}
	q := `SELECT seq, update, "blob_url", "author_id", "created_at", "is_checkpoint" FROM "design_update_logs"
		WHERE "design_id" = $1 AND seq > $2 AND ` + scopeConds(scopes, &args) + `
		ORDER BY seq ASC, id ASC LIMIT $3`
	rows, err := s.db.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []updateLogRow
	for rows.Next() {
		var r updateLogRow
		if err := rows.Scan(&r.seq, &r.update, &r.blobURL, &r.authorID, &r.createdAt, &r.isCheckpoint); err != nil {
			return nil, err
		}
		// AppendUpdate journals inline; if a row ever offloaded a large update to
		// storage (blobUrl set, update null), rehydrate it. A miss here is NOT
		// best-effort: the client folds these frames as a causal CRDT chain, so a
		// dropped frame silently corrupts every later edit that depends on it. Fail
		// the whole page instead, so the fold gets every frame or a surfaced error,
		// never a silent gap. (The local driver returns (nil,nil) for a missing key,
		// so an empty buffer is also a miss.)
		if len(r.update) == 0 && r.blobURL != nil && *r.blobURL != "" {
			if s.storage == nil {
				return nil, fmt.Errorf("update log seq %d offloaded to %q but no storage driver", r.seq, *r.blobURL)
			}
			buf, err := s.storage.Get(*r.blobURL)
			if err != nil {
				return nil, fmt.Errorf("update log seq %d: fetch journaled blob %q: %w", r.seq, *r.blobURL, err)
			}
			if len(buf) == 0 {
				return nil, fmt.Errorf("update log seq %d: journaled blob %q missing", r.seq, *r.blobURL)
			}
			r.update = buf
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
