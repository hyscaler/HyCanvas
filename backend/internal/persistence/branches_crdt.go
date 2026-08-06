// True in-CRDT named branches (doc 16 FR-10). A CRDT branch lives INSIDE one
// design: its state is the parent lineage's update log folded up to
// forked_from_seq plus the branch's own branch-scoped rows. All rows share the
// design-global seq space and the same Yjs identity space, so a branch's full
// lineage is a single seq-ordered stream (parent prefix rows all predate the
// fork, branch rows all postdate it) and the client folds it exactly like main
// history - no new fold machinery. Distinct from the older fork model
// (ListBranches), which copies a version into a NEW design.
package persistence

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ErrInvalidBranch marks a bad branch request (empty name, unknown parent,
// fork point past the lineage head); handlers map it to 422.
var ErrInvalidBranch = errors.New("invalid branch")

const maxBranchNameLen = 120

// crdtBranchLineageDepth bounds the parent walk; nesting deeper than this is
// refused at creation, so resolution can never loop or recurse unboundedly.
const crdtBranchLineageDepth = 16

// CrdtBranch is a named in-CRDT branch of a design.
type CrdtBranch struct {
	ID             string  `json:"id"`
	DesignID       string  `json:"designId"`
	Name           string  `json:"name"`
	ForkedFromSeq  int64   `json:"forkedFromSeq"`
	ParentBranchID *string `json:"parentBranchId,omitempty"`
	CreatedByID    *string `json:"createdById,omitempty"`
	CreatedAt      string  `json:"createdAt"`
}

type crdtBranchRow struct {
	id            string
	designID      string
	name          string
	forkedFromSeq int64
	parentID      *string
	createdByID   *string
	createdAt     time.Time
}

func toCrdtBranch(r crdtBranchRow) CrdtBranch {
	return CrdtBranch{
		ID: r.id, DesignID: r.designID, Name: r.name, ForkedFromSeq: r.forkedFromSeq,
		ParentBranchID: r.parentID, CreatedByID: r.createdByID,
		CreatedAt: r.createdAt.UTC().Format(iso),
	}
}

const crdtBranchCols = `id,"design_id",name,"forked_from_seq","parent_branch_id","created_by_id","created_at"`

func scanCrdtBranch(row pgx.Row) (crdtBranchRow, error) {
	var r crdtBranchRow
	err := row.Scan(&r.id, &r.designID, &r.name, &r.forkedFromSeq, &r.parentID, &r.createdByID, &r.createdAt)
	return r, err
}

// CreateCrdtBranch forks a named branch at forkedFromSeq of the parent lineage
// (parentBranchID nil = the main lineage). The fork point must not exceed the
// parent lineage's current head, so a branch can never claim history that does
// not exist.
func (s *Service) CreateCrdtBranch(ctx context.Context, designID, workspaceID, name string, forkedFromSeq int64, parentBranchID, authorID *string) (CrdtBranch, error) {
	if _, err := s.requireDesign(ctx, designID, workspaceID, false); err != nil {
		return CrdtBranch{}, err
	}
	name = strings.TrimSpace(name)
	if name == "" || len(name) > maxBranchNameLen {
		return CrdtBranch{}, fmt.Errorf("%w: name must be 1-%d characters", ErrInvalidBranch, maxBranchNameLen)
	}
	if forkedFromSeq < 0 {
		return CrdtBranch{}, fmt.Errorf("%w: negative fork seq", ErrInvalidBranch)
	}
	if parentBranchID != nil {
		parent, err := s.getCrdtBranch(ctx, designID, *parentBranchID)
		if err != nil {
			return CrdtBranch{}, fmt.Errorf("%w: unknown parent branch", ErrInvalidBranch)
		}
		// Bound nesting up front so lineage resolution stays trivially finite.
		if _, err := s.crdtLineageScopes(ctx, designID, parent.id); err != nil {
			return CrdtBranch{}, err
		}
		depth, err := s.crdtBranchDepth(ctx, designID, parent.id)
		if err != nil {
			return CrdtBranch{}, err
		}
		if depth+1 >= crdtBranchLineageDepth {
			return CrdtBranch{}, fmt.Errorf("%w: branch nesting too deep", ErrInvalidBranch)
		}
	}
	// Take the design's lineage lock for the rest of this call: compaction
	// deletes the very prefix a fork point names, so the checks below and the
	// INSERT must not straddle a concurrent AppendCheckpoint.
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return CrdtBranch{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockDesignLineage(ctx, tx, designID); err != nil {
		return CrdtBranch{}, err
	}
	// The fork point must exist in the parent lineage (0 = fork from the empty
	// beginning, always valid).
	if forkedFromSeq > 0 {
		var head int64
		if err := tx.QueryRow(ctx,
			`SELECT COALESCE(MAX(seq),0) FROM "design_update_logs"
			 WHERE "design_id" = $1 AND "branch_id" IS NOT DISTINCT FROM $2`,
			designID, parentBranchID).Scan(&head); err != nil {
			return CrdtBranch{}, err
		}
		if forkedFromSeq > head {
			return CrdtBranch{}, fmt.Errorf("%w: fork seq %d past lineage head %d", ErrInvalidBranch, forkedFromSeq, head)
		}
		// The fork's base must still EXIST. Compaction writes a full-state
		// checkpoint and deletes the rows below it (bar the prefix a dependent
		// branch already needed), and it can run repeatedly, so the surviving
		// history is not one clean prefix: it is a series of retained islands
		// separated by holes. Reconstructing which islands are foldable from
		// SQL alone is not worth getting subtly wrong, so the rule is the
		// conservative one: once a lineage has been compacted, a new branch may
		// only fork at or after its newest checkpoint, which is by construction
		// a complete full-state base. An uncompacted lineage (no checkpoint
		// row) still forks anywhere at or below its head, as before.
		var checkpoint int64
		if err := tx.QueryRow(ctx,
			`SELECT COALESCE(MAX(seq),0) FROM "design_update_logs"
			 WHERE "design_id" = $1 AND "branch_id" IS NOT DISTINCT FROM $2 AND "is_checkpoint"`,
			designID, parentBranchID).Scan(&checkpoint); err != nil {
			return CrdtBranch{}, err
		}
		if checkpoint > 0 && forkedFromSeq < checkpoint {
			return CrdtBranch{}, fmt.Errorf("%w: fork seq %d predates the lineage's newest checkpoint at %d; that history has been compacted away, so branch from %d or later", ErrInvalidBranch, forkedFromSeq, checkpoint, checkpoint)
		}
	}
	const q = `INSERT INTO "design_branches" (id,"design_id",name,"forked_from_seq","parent_branch_id","created_by_id")
		VALUES ($1,$2,$3,$4,$5,$6) RETURNING ` + crdtBranchCols
	r, err := scanCrdtBranch(tx.QueryRow(ctx, q, uuid.NewString(), designID, name, forkedFromSeq, parentBranchID, authorID))
	if err != nil {
		return CrdtBranch{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CrdtBranch{}, err
	}
	return toCrdtBranch(r), nil
}

// ListCrdtBranches returns the design's in-CRDT branches, oldest first.
func (s *Service) ListCrdtBranches(ctx context.Context, designID, workspaceID string) ([]CrdtBranch, error) {
	if _, err := s.requireDesign(ctx, designID, workspaceID, false); err != nil {
		return nil, err
	}
	rows, err := s.db.Query(ctx, `SELECT `+crdtBranchCols+` FROM "design_branches" WHERE "design_id" = $1 ORDER BY "created_at", id`, designID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CrdtBranch{}
	for rows.Next() {
		r, err := scanCrdtBranch(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, toCrdtBranch(r))
	}
	return out, rows.Err()
}

// GetCrdtBranch resolves one branch, workspace-scoped (for handler validation).
func (s *Service) GetCrdtBranch(ctx context.Context, designID, workspaceID, branchID string) (CrdtBranch, error) {
	if _, err := s.requireDesign(ctx, designID, workspaceID, false); err != nil {
		return CrdtBranch{}, err
	}
	r, err := s.getCrdtBranch(ctx, designID, branchID)
	if err != nil {
		return CrdtBranch{}, err
	}
	return toCrdtBranch(r), nil
}

// BranchBelongsToDesign is the cheap existence check the realtime gateway uses
// before admitting a branch room join (design authorization happened already).
func (s *Service) BranchBelongsToDesign(ctx context.Context, designID, branchID string) bool {
	_, err := s.getCrdtBranch(ctx, designID, branchID)
	return err == nil
}

func (s *Service) getCrdtBranch(ctx context.Context, designID, branchID string) (crdtBranchRow, error) {
	// Validate the id shape BEFORE querying: the column is uuid-typed, so a
	// garbage id (e.g. a hostile ?branch= param) would otherwise raise a cast
	// error - noisy in production and transaction-poisoning under a wrapping tx.
	if _, err := uuid.Parse(branchID); err != nil {
		return crdtBranchRow{}, ErrNotFound
	}
	r, err := scanCrdtBranch(s.db.QueryRow(ctx,
		`SELECT `+crdtBranchCols+` FROM "design_branches" WHERE id = $1 AND "design_id" = $2`, branchID, designID))
	if errors.Is(err, pgx.ErrNoRows) {
		return crdtBranchRow{}, ErrNotFound
	}
	return r, err
}

func (s *Service) crdtBranchDepth(ctx context.Context, designID, branchID string) (int, error) {
	depth := 0
	cur := branchID
	for cur != "" {
		if depth >= crdtBranchLineageDepth {
			return depth, fmt.Errorf("%w: branch nesting too deep", ErrInvalidBranch)
		}
		r, err := s.getCrdtBranch(ctx, designID, cur)
		if err != nil {
			return depth, err
		}
		depth++
		if r.parentID == nil {
			break
		}
		cur = *r.parentID
	}
	return depth, nil
}

// crdtScope is one lineage segment: rows of `branchID` (nil = main) capped at
// `capSeq` (<0 = uncapped, the leaf segment).
type crdtScope struct {
	branchID *string
	capSeq   int64
}

// crdtLineageScopes resolves a branch's full lineage, root first: main capped
// at the first fork, each ancestor branch capped at its child's fork point,
// the branch itself uncapped. branchID "" yields the single uncapped main
// scope (plain history).
func (s *Service) crdtLineageScopes(ctx context.Context, designID, branchID string) ([]crdtScope, error) {
	if branchID == "" {
		return []crdtScope{{branchID: nil, capSeq: -1}}, nil
	}
	// Walk leaf -> root, then reverse. Each visited branch's rows are capped by
	// the fork seq of the CHILD below it (the leaf is uncapped).
	var reversed []crdtScope
	capSeq := int64(-1)
	cur := branchID
	for i := 0; ; i++ {
		if i >= crdtBranchLineageDepth {
			return nil, fmt.Errorf("%w: branch lineage too deep or cyclic", ErrInvalidBranch)
		}
		r, err := s.getCrdtBranch(ctx, designID, cur)
		if err != nil {
			return nil, err
		}
		id := r.id
		reversed = append(reversed, crdtScope{branchID: &id, capSeq: capSeq})
		capSeq = r.forkedFromSeq
		if r.parentID == nil {
			break
		}
		cur = *r.parentID
	}
	reversed = append(reversed, crdtScope{branchID: nil, capSeq: capSeq})
	out := make([]crdtScope, 0, len(reversed))
	for i := len(reversed) - 1; i >= 0; i-- {
		out = append(out, reversed[i])
	}
	return out, nil
}

// crdtScopeHead returns the highest seq present in one scope's own rows (0 when
// the scope has none). Used to validate fork points.
func (s *Service) crdtScopeHead(ctx context.Context, designID string, branchID *string) (int64, error) {
	var head int64
	err := s.db.QueryRow(ctx,
		`SELECT COALESCE(MAX(seq),0) FROM "design_update_logs" WHERE "design_id" = $1 AND "branch_id" IS NOT DISTINCT FROM $2`,
		designID, branchID).Scan(&head)
	return head, err
}

// scopeConds renders the lineage scopes as a SQL predicate over ($1=designID)
// rows, appending bind args after the given offset. Each segment matches its
// branch (IS NOT DISTINCT FROM handles main's NULL) within its seq cap.
func scopeConds(scopes []crdtScope, args *[]any) string {
	parts := make([]string, 0, len(scopes))
	for _, sc := range scopes {
		*args = append(*args, sc.branchID)
		cond := fmt.Sprintf(`("branch_id" IS NOT DISTINCT FROM $%d`, len(*args))
		if sc.capSeq >= 0 {
			*args = append(*args, sc.capSeq)
			cond += fmt.Sprintf(` AND seq <= $%d`, len(*args))
		}
		cond += ")"
		parts = append(parts, cond)
	}
	return "(" + strings.Join(parts, " OR ") + ")"
}
