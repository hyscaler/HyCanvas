package approvals

import "context"

// LockChecker derives a design's approval-lock state (FR-11) directly from the
// Approval table, with no dependency on the approvals Service or the sharing
// Service. It satisfies sharing.ApprovalLock, so wiring it into the sharing
// service never forms an import cycle (sharing -> ApprovalLock interface;
// approvals.LockChecker -> DB only). A design is locked when its single active
// approval is in status 'approved'.
type LockChecker struct{ db DBTX }

// NewLockChecker builds a lock checker over the same DB handle.
func NewLockChecker(db DBTX) *LockChecker { return &LockChecker{db: db} }

// IsApprovalLocked reports whether the design has an active approved approval.
func (l *LockChecker) IsApprovalLocked(ctx context.Context, designID string) (bool, error) {
	const q = `SELECT status FROM "approvals"
		WHERE "design_id" = $1 AND status IN ('pending','approved')
		ORDER BY "created_at" DESC LIMIT 1`
	var status string
	if err := l.db.QueryRow(ctx, q, designID).Scan(&status); err != nil {
		// No active approval (ErrNoRows) -> not locked. Any other error is
		// treated as not-locked to fail open for reads; writes re-check.
		return false, nil
	}
	return status == "approved", nil
}
