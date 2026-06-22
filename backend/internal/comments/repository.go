// SQL access for comments + tasks, against the Prisma-managed tables "Comment",
// "CommentReaction", and "CommentMention" (quoted identifiers, camelCase
// columns). The anchor is a JSONB column stored/loaded as the Anchor struct.
package comments

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const isoFmt = "2006-01-02T15:04:05.000Z07:00"

// DBTX is the query surface (satisfied by *pgxpool.Pool and pgx.Tx).
type DBTX interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Anchor is where a comment is pinned (FR-1). Stored verbatim as JSONB.
type Anchor struct {
	Kind     string   `json:"kind"`
	PageID   *string  `json:"pageId,omitempty"`
	NodeID   *string  `json:"nodeId,omitempty"`
	X        *float64 `json:"x,omitempty"`
	Y        *float64 `json:"y,omitempty"`
	W        *float64 `json:"w,omitempty"`
	H        *float64 `json:"h,omitempty"`
	TimeMs   *float64 `json:"timeMs,omitempty"`
	Orphaned bool     `json:"orphaned,omitempty"`
}

// CommentRow mirrors the Comment table.
type CommentRow struct {
	ID             string
	DesignID       string
	ParentID       *string
	AuthorID       *string
	AuthorName     string
	Anchor         Anchor
	Body           string
	ResolvedAt     *time.Time
	ResolvedByID   *string
	EditedAt       *time.Time
	TaskAssigneeID *string
	TaskStatus     *string
	TaskDueAt      *time.Time
	CreatedAt      time.Time
}

// ReactionRow mirrors the CommentReaction table.
type ReactionRow struct {
	CommentID string
	UserID    string
	Emoji     string
}

// MentionRow mirrors the CommentMention table.
type MentionRow struct {
	CommentID string
	UserID    string
}

func isoPtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.UTC().Format(isoFmt)
	return &s
}

func parseTime(s string) (time.Time, error) {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, nil
		}
	}
	return time.Time{}, errors.New("invalid time")
}

const commentCols = `id, "designId", "parentId", "authorId", "authorName", anchor, body,
	"resolvedAt", "resolvedById", "editedAt", "taskAssigneeId", "taskStatus", "taskDueAt", "createdAt"`

func scanComment(row pgx.Row) (CommentRow, error) {
	var c CommentRow
	var anchorRaw []byte
	err := row.Scan(&c.ID, &c.DesignID, &c.ParentID, &c.AuthorID, &c.AuthorName, &anchorRaw, &c.Body,
		&c.ResolvedAt, &c.ResolvedByID, &c.EditedAt, &c.TaskAssigneeID, &c.TaskStatus, &c.TaskDueAt, &c.CreatedAt)
	if err != nil {
		return c, err
	}
	if len(anchorRaw) > 0 {
		_ = json.Unmarshal(anchorRaw, &c.Anchor)
	}
	return c, nil
}

func (s *Service) createComment(ctx context.Context, in CommentRow) (CommentRow, error) {
	anchorRaw, err := json.Marshal(in.Anchor)
	if err != nil {
		return CommentRow{}, err
	}
	const q = `INSERT INTO "Comment" (id,"designId","parentId","authorId","authorName",anchor,body)
		VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ` + commentCols
	return scanComment(s.db.QueryRow(ctx, q, uuid.NewString(), in.DesignID, in.ParentID, in.AuthorID, in.AuthorName, anchorRaw, in.Body))
}

func (s *Service) getComment(ctx context.Context, id string) (CommentRow, error) {
	c, err := scanComment(s.db.QueryRow(ctx, `SELECT `+commentCols+` FROM "Comment" WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return CommentRow{}, ErrNotFound
	}
	return c, err
}

func (s *Service) listCommentsForDesign(ctx context.Context, designID string) ([]CommentRow, error) {
	rows, err := s.db.Query(ctx, `SELECT `+commentCols+` FROM "Comment" WHERE "designId" = $1 ORDER BY "createdAt"`, designID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collectComments(rows)
}

func (s *Service) listTasksForAssignee(ctx context.Context, userID string, status *string) ([]CommentRow, error) {
	// Root task comments (taskStatus set) assigned to the user, optionally
	// filtered by status.
	const q = `SELECT ` + commentCols + ` FROM "Comment"
		WHERE "taskAssigneeId" = $1 AND "taskStatus" IS NOT NULL
		  AND ($2::text IS NULL OR "taskStatus" = $2)
		ORDER BY "createdAt"`
	rows, err := s.db.Query(ctx, q, userID, status)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collectComments(rows)
}

func collectComments(rows pgx.Rows) ([]CommentRow, error) {
	var out []CommentRow
	for rows.Next() {
		c, err := scanComment(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// commentPatch carries an UpdateComment change. The *Set flags select which
// column groups to write; nil values within a selected group clear the column.
type commentPatch struct {
	body        *string
	editedAtSet bool
	resolvedSet bool
	resolved    bool
	resolvedBy  *string

	taskSet      bool
	taskAssignee *string
	taskStatus   *string
	taskDueAt    *time.Time
}

func (s *Service) updateComment(ctx context.Context, id string, p commentPatch) error {
	// Build the column set incrementally so an omitted group is left untouched.
	set := []string{}
	args := []any{id}
	add := func(expr string, val any) {
		args = append(args, val)
		set = append(set, expr+placeholder(len(args)))
	}
	if p.body != nil {
		add(`body = `, *p.body)
	}
	if p.editedAtSet {
		now := time.Now()
		add(`"editedAt" = `, now)
	}
	if p.resolvedSet {
		if p.resolved {
			now := time.Now()
			add(`"resolvedAt" = `, now)
			add(`"resolvedById" = `, p.resolvedBy)
		} else {
			add(`"resolvedAt" = `, nil)
			add(`"resolvedById" = `, nil)
		}
	}
	if p.taskSet {
		add(`"taskAssigneeId" = `, p.taskAssignee)
		add(`"taskStatus" = `, p.taskStatus)
		add(`"taskDueAt" = `, p.taskDueAt)
	}
	if len(set) == 0 {
		return nil
	}
	q := `UPDATE "Comment" SET ` + join(set, ", ") + ` WHERE id = $1`
	_, err := s.db.Exec(ctx, q, args...)
	return err
}

func (s *Service) deleteComment(ctx context.Context, id string) error {
	// Replies/reactions/mentions cascade via the Prisma-defined FKs.
	_, err := s.db.Exec(ctx, `DELETE FROM "Comment" WHERE id = $1`, id)
	return err
}

// --- reactions -----------------------------------------------------------

func (s *Service) listReactions(ctx context.Context, commentIDs []string) ([]ReactionRow, error) {
	if len(commentIDs) == 0 {
		return nil, nil
	}
	rows, err := s.db.Query(ctx, `SELECT "commentId","userId",emoji FROM "CommentReaction" WHERE "commentId" = ANY($1) ORDER BY "createdAt"`, commentIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ReactionRow
	for rows.Next() {
		var r ReactionRow
		if err := rows.Scan(&r.CommentID, &r.UserID, &r.Emoji); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Service) hasReaction(ctx context.Context, commentID, userID, emoji string) (bool, error) {
	var one int
	err := s.db.QueryRow(ctx, `SELECT 1 FROM "CommentReaction" WHERE "commentId"=$1 AND "userId"=$2 AND emoji=$3`, commentID, userID, emoji).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (s *Service) addReaction(ctx context.Context, commentID, userID, emoji string) error {
	_, err := s.db.Exec(ctx,
		`INSERT INTO "CommentReaction" (id,"commentId","userId",emoji) VALUES ($1,$2,$3,$4)
		 ON CONFLICT ("commentId","userId",emoji) DO NOTHING`,
		uuid.NewString(), commentID, userID, emoji)
	return err
}

func (s *Service) removeReaction(ctx context.Context, commentID, userID, emoji string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM "CommentReaction" WHERE "commentId"=$1 AND "userId"=$2 AND emoji=$3`, commentID, userID, emoji)
	return err
}

// --- mentions ------------------------------------------------------------

func (s *Service) listMentions(ctx context.Context, commentIDs []string) ([]MentionRow, error) {
	if len(commentIDs) == 0 {
		return nil, nil
	}
	rows, err := s.db.Query(ctx, `SELECT "commentId","userId" FROM "CommentMention" WHERE "commentId" = ANY($1)`, commentIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MentionRow
	for rows.Next() {
		var m MentionRow
		if err := rows.Scan(&m.CommentID, &m.UserID); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Service) listMentionsForUser(ctx context.Context, userID string) ([]MentionRow, error) {
	rows, err := s.db.Query(ctx, `SELECT "commentId","userId" FROM "CommentMention" WHERE "userId" = $1 ORDER BY "createdAt" DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MentionRow
	for rows.Next() {
		var m MentionRow
		if err := rows.Scan(&m.CommentID, &m.UserID); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// setMentions replaces the comment's mention set (idempotent per user).
func (s *Service) setMentions(ctx context.Context, commentID string, userIDs []string) error {
	if _, err := s.db.Exec(ctx, `DELETE FROM "CommentMention" WHERE "commentId" = $1`, commentID); err != nil {
		return err
	}
	for _, uid := range userIDs {
		if _, err := s.db.Exec(ctx,
			`INSERT INTO "CommentMention" (id,"commentId","userId") VALUES ($1,$2,$3)
			 ON CONFLICT ("commentId","userId") DO NOTHING`,
			uuid.NewString(), commentID, uid); err != nil {
			return err
		}
	}
	return nil
}

// --- workspace members (for mentionable people) --------------------------

func (s *Service) listWorkspaceMemberIDs(ctx context.Context, workspaceID string) ([]string, error) {
	rows, err := s.db.Query(ctx, `SELECT "userId" FROM "WorkspaceMember" WHERE "workspaceId" = $1 AND status = 'ACTIVE'`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// --- tiny string helpers (avoid importing strings just for join) ---------

func placeholder(n int) string {
	return "$" + itoa(n)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

func join(parts []string, sep string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += sep
		}
		out += p
	}
	return out
}
