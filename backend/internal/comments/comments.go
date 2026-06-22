// Package comments ports the NestJS comments + tasks module (doc 17 slice B:
// FR-1..FR-4). It is the single place comments are read and written, gated by
// the sharing access resolver:
//   - read requires `view`,
//   - create/reply/react/resolve requires `comment`,
//   - edit/delete requires being the author OR `delete` (admin/owner).
//
// Permission is always resolved server-side from the design's workspace.
//
// Deferred vs the Node original: element-anchor orphan detection (FR-1) needs
// the live design snapshot, which the persistence snapshot-load is not yet
// ported for, so anchors are never flagged orphaned (the best-effort behavior
// the Node service already falls back to on a read miss). The realtime
// comment-changed broadcast and engagement activity/notifications are optional
// nil-safe hooks (realtime stays on TS; engagement is not yet ported).
package comments

import (
	"context"
	"errors"
	"sort"
	"strings"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/authz"
	"hycanvas/backend/internal/sharing"
)

const maxBody = 10000

var anchorKinds = map[string]bool{"design": true, "page": true, "element": true, "region": true, "video": true}
var taskStatuses = map[string]bool{"open": true, "in_progress": true, "done": true}

// Errors map to RFC 7807 statuses at the HTTP layer.
var (
	ErrForbidden  = errors.New("forbidden")
	ErrNotFound   = errors.New("not found")
	ErrBadRequest = errors.New("bad request")
)

// Access resolves a caller's capabilities and enumerates per-design grants
// (sharing slice A).
type Access interface {
	GetAccess(ctx context.Context, designID, userID string) (sharing.DesignAccessView, error)
	ListDesignGrants(ctx context.Context, designID string) ([]sharing.GrantRow, error)
}

// Accounts resolves display identities.
type Accounts interface {
	GetUserByID(ctx context.Context, id string) (*accounts.AuthUser, error)
}

// Realtime broadcasts a comment-changed signal so connected clients refetch.
// Nil hook = skip (REST still works).
type Realtime interface {
	NotifyCommentChanged(ctx context.Context, designID string)
}

// Engagement records activity + notifications on each mutation (slice D). Nil
// hook = skip.
type Engagement interface {
	EmitActivity(ctx context.Context, designID, actorID, kind string, payload map[string]any)
	Notify(ctx context.Context, actorID, targetUserID, typ, designID string, payload map[string]any)
}

// Service is the comments module.
type Service struct {
	db         DBTX
	access     Access
	accounts   Accounts
	persist    PersistenceTitles
	realtime   Realtime
	engagement Engagement
	files      Files
}

// PersistenceTitles is the workspace+title lookup comments needs (satisfied by
// an adapter over the persistence service).
type PersistenceTitles interface {
	GetWorkspaceID(ctx context.Context, designID string) (string, error)
	GetTitle(ctx context.Context, designID string) (string, error)
}

// Files loads a design's live node-id set for element-anchor orphan detection
// (FR-1). Optional (attached via WithFiles); nil = orphan detection disabled,
// the best-effort fallback the Node service uses on a read miss.
type Files interface {
	NodeIDs(ctx context.Context, designID, workspaceID string) (map[string]bool, error)
}

// NewService wires the comments service. realtime and engagement may be nil.
func NewService(db DBTX, access Access, acct Accounts, persist PersistenceTitles, realtime Realtime, engagement Engagement) *Service {
	return &Service{db: db, access: access, accounts: acct, persist: persist, realtime: realtime, engagement: engagement}
}

// WithFiles attaches the live node-id loader, enabling element-anchor orphan
// detection (FR-1). Returns the same service for chaining.
func (s *Service) WithFiles(f Files) *Service {
	s.files = f
	return s
}

// liveNodeIDs loads the design's node-id set for orphan detection, or nil when
// no loader is attached or the design is unreadable (best-effort: a nil set
// never flags a comment as orphaned).
func (s *Service) liveNodeIDs(ctx context.Context, designID, workspaceID string) map[string]bool {
	if s.files == nil {
		return nil
	}
	ids, err := s.files.NodeIDs(ctx, designID, workspaceID)
	if err != nil {
		return nil
	}
	return ids
}

// isOrphaned reports whether an element anchor points at a node that no longer
// exists (FR-1). Only element anchors orphan; a nil id-set never orphans.
func isOrphaned(a Anchor, liveIDs map[string]bool) bool {
	if a.Kind != "element" || a.NodeID == nil || *a.NodeID == "" || liveIDs == nil {
		return false
	}
	return !liveIDs[*a.NodeID]
}

// --- view types (match the NestJS JSON exactly) -------------------------

type ReactionView struct {
	Emoji   string   `json:"emoji"`
	UserIDs []string `json:"userIds"`
}

type Task struct {
	AssigneeID *string `json:"assigneeId"`
	Status     string  `json:"status"`
	DueAt      *string `json:"dueAt"`
}

type CommentView struct {
	ID           string         `json:"id"`
	DesignID     string         `json:"designId"`
	ParentID     *string        `json:"parentId"`
	AuthorID     *string        `json:"authorId"`
	AuthorName   string         `json:"authorName"`
	Anchor       Anchor         `json:"anchor"`
	Body         string         `json:"body"`
	Mentions     []string       `json:"mentions"`
	Reactions    []ReactionView `json:"reactions"`
	Resolved     bool           `json:"resolved"`
	ResolvedByID *string        `json:"resolvedById"`
	Task         *Task          `json:"task"`
	EditedAt     *string        `json:"editedAt"`
	CreatedAt    string         `json:"createdAt"`
}

type CommentThread struct {
	CommentView
	Replies []CommentView `json:"replies"`
}

type MentionablePerson struct {
	ID    string  `json:"id"`
	Name  string  `json:"name"`
	Email *string `json:"email"`
}

type MyTaskView struct {
	CommentView
	DesignTitle string `json:"designTitle"`
}

// --- validation ----------------------------------------------------------

func assertAnchor(a Anchor) (Anchor, error) {
	if !anchorKinds[a.Kind] {
		return Anchor{}, ErrBadRequest
	}
	a.Orphaned = false // never accepted from the client
	return a, nil
}

func assertBody(body string) (string, error) {
	if strings.TrimSpace(body) == "" {
		return "", ErrBadRequest
	}
	if len(body) > maxBody {
		return "", ErrBadRequest
	}
	return body, nil
}

func assertStatus(status string) (string, error) {
	if !taskStatuses[status] {
		return "", ErrBadRequest
	}
	return status, nil
}

func hasCap(access sharing.DesignAccessView, c authz.Capability) bool {
	for _, x := range access.Capabilities {
		if x == c {
			return true
		}
	}
	return false
}

// --- capability gates ----------------------------------------------------

// assertCapability resolves the caller's access and requires a capability.
// Missing `view` reports NotFound (so a stranger cannot probe existence);
// missing `comment` reports Forbidden.
func (s *Service) assertCapability(ctx context.Context, designID, userID string, cap authz.Capability) error {
	access, err := s.access.GetAccess(ctx, designID, userID)
	if err != nil {
		return ErrNotFound
	}
	if !hasCap(access, cap) {
		if cap == authz.CapView {
			return ErrNotFound
		}
		return ErrForbidden
	}
	return nil
}

// canModify reports whether the caller may edit/delete a comment: its author,
// or an admin/owner (the `delete` capability).
func (s *Service) canModify(ctx context.Context, c CommentRow, userID string) bool {
	if c.AuthorID != nil && *c.AuthorID == userID {
		return true
	}
	access, err := s.access.GetAccess(ctx, c.DesignID, userID)
	if err != nil {
		return false
	}
	return hasCap(access, authz.CapDelete)
}

// --- views ---------------------------------------------------------------

func (s *Service) resolveName(ctx context.Context, userID string) string {
	u, err := s.accounts.GetUserByID(ctx, userID)
	if err != nil || u == nil || u.Name == "" {
		return "Unknown"
	}
	return u.Name
}

func (s *Service) commentView(row CommentRow, reactions []ReactionView, mentions []string) CommentView {
	if reactions == nil {
		reactions = []ReactionView{}
	}
	if mentions == nil {
		mentions = []string{}
	}
	var task *Task
	if row.TaskStatus != nil {
		task = &Task{AssigneeID: row.TaskAssigneeID, Status: *row.TaskStatus, DueAt: isoPtr(row.TaskDueAt)}
	}
	return CommentView{
		ID: row.ID, DesignID: row.DesignID, ParentID: row.ParentID, AuthorID: row.AuthorID,
		AuthorName: row.AuthorName, Anchor: row.Anchor, Body: row.Body, Mentions: mentions,
		Reactions: reactions, Resolved: row.ResolvedAt != nil, ResolvedByID: row.ResolvedByID,
		Task: task, EditedAt: isoPtr(row.EditedAt), CreatedAt: row.CreatedAt.UTC().Format(isoFmt),
	}
}

func groupReactions(rows []ReactionRow) map[string][]ReactionView {
	out := map[string][]ReactionView{}
	for _, r := range rows {
		list := out[r.CommentID]
		idx := -1
		for i := range list {
			if list[i].Emoji == r.Emoji {
				idx = i
				break
			}
		}
		if idx == -1 {
			list = append(list, ReactionView{Emoji: r.Emoji, UserIDs: []string{r.UserID}})
		} else {
			list[idx].UserIDs = append(list[idx].UserIDs, r.UserID)
		}
		out[r.CommentID] = list
	}
	return out
}

// viewOf reloads one comment as a flat view (after a mutation).
func (s *Service) viewOf(ctx context.Context, id string) (CommentView, error) {
	row, err := s.getComment(ctx, id)
	if err != nil {
		return CommentView{}, err
	}
	reactions, err := s.listReactions(ctx, []string{id})
	if err != nil {
		return CommentView{}, err
	}
	mentions, err := s.listMentions(ctx, []string{id})
	if err != nil {
		return CommentView{}, err
	}
	mids := make([]string, 0, len(mentions))
	for _, m := range mentions {
		mids = append(mids, m.UserID)
	}
	return s.commentView(row, groupReactions(reactions)[id], mids), nil
}

// --- list (FR-1, FR-2) ---------------------------------------------------

// ListThreads returns the design's threads (roots + replies) with reactions,
// mentions, and task info; filter narrows to open/resolved/mine/assigned/all.
func (s *Service) ListThreads(ctx context.Context, designID, userID, filter string) ([]CommentThread, error) {
	if err := s.assertCapability(ctx, designID, userID, authz.CapView); err != nil {
		return nil, err
	}
	all, err := s.listCommentsForDesign(ctx, designID)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(all))
	for _, c := range all {
		ids = append(ids, c.ID)
	}
	reactionRows, err := s.listReactions(ctx, ids)
	if err != nil {
		return nil, err
	}
	mentionRows, err := s.listMentions(ctx, ids)
	if err != nil {
		return nil, err
	}
	reactionsByComment := groupReactions(reactionRows)
	mentionsByComment := map[string][]string{}
	for _, m := range mentionRows {
		mentionsByComment[m.CommentID] = append(mentionsByComment[m.CommentID], m.UserID)
	}

	// Re-resolve element anchors against the live document (FR-1): a comment whose
	// anchored node was deleted is flagged orphaned so the panel still lists it.
	workspaceID, err := s.persist.GetWorkspaceID(ctx, designID)
	if err != nil {
		return nil, ErrNotFound
	}
	liveIDs := s.liveNodeIDs(ctx, designID, workspaceID)

	repliesByRoot := map[string][]CommentRow{}
	var roots []CommentRow
	for _, c := range all {
		if c.ParentID == nil {
			roots = append(roots, c)
		} else {
			repliesByRoot[*c.ParentID] = append(repliesByRoot[*c.ParentID], c)
		}
	}
	toView := func(row CommentRow) CommentView {
		v := s.commentView(row, reactionsByComment[row.ID], mentionsByComment[row.ID])
		if isOrphaned(v.Anchor, liveIDs) {
			v.Anchor.Orphaned = true
		}
		return v
	}

	threads := make([]CommentThread, 0, len(roots))
	for _, root := range roots {
		t := CommentThread{CommentView: toView(root), Replies: []CommentView{}}
		for _, rep := range repliesByRoot[root.ID] {
			t.Replies = append(t.Replies, toView(rep))
		}
		switch filter {
		case "open":
			if t.Resolved {
				continue
			}
		case "resolved":
			if !t.Resolved {
				continue
			}
		case "mine":
			if t.AuthorID == nil || *t.AuthorID != userID {
				continue
			}
		case "assigned":
			if t.Task == nil || t.Task.AssigneeID == nil || *t.Task.AssigneeID != userID {
				continue
			}
		}
		threads = append(threads, t)
	}
	return threads, nil
}

// --- create / reply (FR-1, FR-2, FR-3) -----------------------------------

// validMentions narrows a requested mention list to people who actually have
// access to the design (FR-3).
func (s *Service) validMentions(ctx context.Context, designID string, mentions []string) ([]string, error) {
	if len(mentions) == 0 {
		return nil, nil
	}
	people, err := s.mentionablePeople(ctx, designID)
	if err != nil {
		return nil, err
	}
	allowed := map[string]bool{}
	for _, p := range people {
		allowed[p.ID] = true
	}
	seen := map[string]bool{}
	var out []string
	for _, id := range mentions {
		if allowed[id] && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out, nil
}

// CreateInput is the createComment payload.
type CreateInput struct {
	Anchor   Anchor
	Body     string
	Mentions []string
}

func (s *Service) CreateComment(ctx context.Context, designID, userID string, in CreateInput) (CommentView, error) {
	if err := s.assertCapability(ctx, designID, userID, authz.CapComment); err != nil {
		return CommentView{}, err
	}
	anchor, err := assertAnchor(in.Anchor)
	if err != nil {
		return CommentView{}, err
	}
	body, err := assertBody(in.Body)
	if err != nil {
		return CommentView{}, err
	}
	row, err := s.createComment(ctx, CommentRow{DesignID: designID, AuthorID: &userID, AuthorName: s.resolveName(ctx, userID), Anchor: anchor, Body: body})
	if err != nil {
		return CommentView{}, err
	}
	mentions, err := s.validMentions(ctx, designID, in.Mentions)
	if err != nil {
		return CommentView{}, err
	}
	if len(mentions) > 0 {
		if err := s.setMentions(ctx, row.ID, mentions); err != nil {
			return CommentView{}, err
		}
	}
	s.notifyChanged(ctx, designID)
	s.emit(ctx, designID, userID, "comment", map[string]any{"commentId": row.ID})
	for _, uid := range mentions {
		s.notify(ctx, userID, uid, "mention", designID, map[string]any{"commentId": row.ID})
	}
	return s.viewOf(ctx, row.ID)
}

// ReplyInput is the reply payload.
type ReplyInput struct {
	Body     string
	Mentions []string
}

func (s *Service) Reply(ctx context.Context, parentID, userID string, in ReplyInput) (CommentView, error) {
	parent, err := s.getComment(ctx, parentID)
	if err != nil {
		return CommentView{}, err
	}
	if parent.ParentID != nil {
		return CommentView{}, ErrBadRequest
	}
	if err := s.assertCapability(ctx, parent.DesignID, userID, authz.CapComment); err != nil {
		return CommentView{}, err
	}
	body, err := assertBody(in.Body)
	if err != nil {
		return CommentView{}, err
	}
	row, err := s.createComment(ctx, CommentRow{DesignID: parent.DesignID, ParentID: &parentID, AuthorID: &userID, AuthorName: s.resolveName(ctx, userID), Anchor: parent.Anchor, Body: body})
	if err != nil {
		return CommentView{}, err
	}
	mentions, err := s.validMentions(ctx, parent.DesignID, in.Mentions)
	if err != nil {
		return CommentView{}, err
	}
	if len(mentions) > 0 {
		if err := s.setMentions(ctx, row.ID, mentions); err != nil {
			return CommentView{}, err
		}
	}
	s.notifyChanged(ctx, parent.DesignID)
	s.emit(ctx, parent.DesignID, userID, "reply", map[string]any{"commentId": row.ID, "parentId": parentID})
	if parent.AuthorID != nil {
		s.notify(ctx, userID, *parent.AuthorID, "reply", parent.DesignID, map[string]any{"commentId": row.ID, "parentId": parentID})
	}
	for _, uid := range mentions {
		s.notify(ctx, userID, uid, "mention", parent.DesignID, map[string]any{"commentId": row.ID})
	}
	return s.viewOf(ctx, row.ID)
}

// --- edit / delete (FR-2) ------------------------------------------------

// EditInput is the editBody payload. MentionsSet distinguishes "omitted" from
// "set to empty".
type EditInput struct {
	Body        string
	Mentions    []string
	MentionsSet bool
}

func (s *Service) EditBody(ctx context.Context, commentID, userID string, in EditInput) (CommentView, error) {
	comment, err := s.getComment(ctx, commentID)
	if err != nil {
		return CommentView{}, err
	}
	if !s.canModify(ctx, comment, userID) {
		return CommentView{}, ErrForbidden
	}
	body, err := assertBody(in.Body)
	if err != nil {
		return CommentView{}, err
	}
	if err := s.updateComment(ctx, commentID, commentPatch{body: &body, editedAtSet: true}); err != nil {
		return CommentView{}, err
	}
	if in.MentionsSet {
		priorRows, err := s.listMentions(ctx, []string{commentID})
		if err != nil {
			return CommentView{}, err
		}
		prior := map[string]bool{}
		for _, m := range priorRows {
			prior[m.UserID] = true
		}
		mentions, err := s.validMentions(ctx, comment.DesignID, in.Mentions)
		if err != nil {
			return CommentView{}, err
		}
		if err := s.setMentions(ctx, commentID, mentions); err != nil {
			return CommentView{}, err
		}
		for _, uid := range mentions {
			if !prior[uid] {
				s.notify(ctx, userID, uid, "mention", comment.DesignID, map[string]any{"commentId": commentID})
			}
		}
	}
	s.notifyChanged(ctx, comment.DesignID)
	return s.viewOf(ctx, commentID)
}

func (s *Service) DeleteComment(ctx context.Context, commentID, userID string) error {
	comment, err := s.getComment(ctx, commentID)
	if err != nil {
		return err
	}
	if !s.canModify(ctx, comment, userID) {
		return ErrForbidden
	}
	if err := s.deleteComment(ctx, commentID); err != nil {
		return err
	}
	s.notifyChanged(ctx, comment.DesignID)
	return nil
}

// --- resolve / reopen (FR-2) ---------------------------------------------

func (s *Service) SetResolved(ctx context.Context, commentID, userID string, resolved bool) (CommentView, error) {
	comment, err := s.getComment(ctx, commentID)
	if err != nil {
		return CommentView{}, err
	}
	if err := s.assertCapability(ctx, comment.DesignID, userID, authz.CapComment); err != nil {
		return CommentView{}, err
	}
	if err := s.updateComment(ctx, commentID, commentPatch{resolvedSet: true, resolved: resolved, resolvedBy: &userID}); err != nil {
		return CommentView{}, err
	}
	s.notifyChanged(ctx, comment.DesignID)
	s.emit(ctx, comment.DesignID, userID, "resolve", map[string]any{"commentId": commentID, "resolved": resolved})
	return s.viewOf(ctx, commentID)
}

// --- reactions (FR-2) ----------------------------------------------------

func (s *Service) ToggleReaction(ctx context.Context, commentID, userID, emoji string) (CommentView, error) {
	comment, err := s.getComment(ctx, commentID)
	if err != nil {
		return CommentView{}, err
	}
	if err := s.assertCapability(ctx, comment.DesignID, userID, authz.CapComment); err != nil {
		return CommentView{}, err
	}
	if strings.TrimSpace(emoji) == "" || len(emoji) > 32 {
		return CommentView{}, ErrBadRequest
	}
	exists, err := s.hasReaction(ctx, commentID, userID, emoji)
	if err != nil {
		return CommentView{}, err
	}
	added := !exists
	if added {
		err = s.addReaction(ctx, commentID, userID, emoji)
	} else {
		err = s.removeReaction(ctx, commentID, userID, emoji)
	}
	if err != nil {
		return CommentView{}, err
	}
	s.notifyChanged(ctx, comment.DesignID)
	if added {
		s.emit(ctx, comment.DesignID, userID, "reaction", map[string]any{"commentId": commentID, "emoji": emoji})
	}
	return s.viewOf(ctx, commentID)
}

// --- tasks (FR-4) --------------------------------------------------------

// TaskInput is the setTask payload. The *Set flags distinguish an omitted field
// from one explicitly set to null.
type TaskInput struct {
	AssigneeID    *string
	AssigneeIDSet bool
	Status        *string
	StatusSet     bool
	DueAt         *string
	DueAtSet      bool
}

func (s *Service) SetTask(ctx context.Context, commentID, userID string, in TaskInput) (CommentView, error) {
	comment, err := s.getComment(ctx, commentID)
	if err != nil {
		return CommentView{}, err
	}
	if comment.ParentID != nil {
		return CommentView{}, ErrBadRequest
	}
	if err := s.assertCapability(ctx, comment.DesignID, userID, authz.CapComment); err != nil {
		return CommentView{}, err
	}
	// Clearing: status explicitly null and no assignee.
	clearing := in.StatusSet && in.Status == nil && (in.AssigneeID == nil)
	if clearing {
		if err := s.updateComment(ctx, commentID, commentPatch{taskSet: true}); err != nil {
			return CommentView{}, err
		}
		s.notifyChanged(ctx, comment.DesignID)
		return s.viewOf(ctx, commentID)
	}
	assigneeID := comment.TaskAssigneeID
	if in.AssigneeIDSet {
		assigneeID = in.AssigneeID
		if assigneeID != nil {
			access, err := s.access.GetAccess(ctx, comment.DesignID, *assigneeID)
			if err != nil || !hasCap(access, authz.CapView) {
				return CommentView{}, ErrBadRequest
			}
		}
	}
	status := "open"
	if comment.TaskStatus != nil {
		status = *comment.TaskStatus
	}
	if in.StatusSet && in.Status != nil {
		v, err := assertStatus(*in.Status)
		if err != nil {
			return CommentView{}, err
		}
		status = v
	}
	dueAt := comment.TaskDueAt
	if in.DueAtSet {
		if in.DueAt == nil {
			dueAt = nil
		} else {
			t, err := parseTime(*in.DueAt)
			if err != nil {
				return CommentView{}, ErrBadRequest
			}
			dueAt = &t
		}
	}
	if err := s.updateComment(ctx, commentID, commentPatch{taskSet: true, taskAssignee: assigneeID, taskStatus: &status, taskDueAt: dueAt}); err != nil {
		return CommentView{}, err
	}
	s.notifyChanged(ctx, comment.DesignID)

	assigneeChanged := in.AssigneeIDSet && !ptrEq(assigneeID, comment.TaskAssigneeID)
	statusChanged := in.StatusSet && in.Status != nil && (comment.TaskStatus == nil || status != *comment.TaskStatus)
	if assigneeChanged && assigneeID != nil {
		s.emit(ctx, comment.DesignID, userID, "task_assign", map[string]any{"commentId": commentID, "assigneeId": *assigneeID, "assigneeName": s.resolveName(ctx, *assigneeID)})
		s.notify(ctx, userID, *assigneeID, "task_assign", comment.DesignID, map[string]any{"commentId": commentID})
	} else if statusChanged {
		s.emit(ctx, comment.DesignID, userID, "task_status", map[string]any{"commentId": commentID, "status": status})
	}
	return s.viewOf(ctx, commentID)
}

// MyTasks returns tasks assigned to the caller across designs they can access.
func (s *Service) MyTasks(ctx context.Context, userID, status string) ([]MyTaskView, error) {
	var st *string
	if status != "" {
		v, err := assertStatus(status)
		if err != nil {
			return nil, err
		}
		st = &v
	}
	rows, err := s.listTasksForAssignee(ctx, userID, st)
	if err != nil {
		return nil, err
	}
	out := []MyTaskView{}
	titleCache := map[string]string{}
	for _, row := range rows {
		access, err := s.access.GetAccess(ctx, row.DesignID, userID)
		if err != nil || !hasCap(access, authz.CapView) {
			continue
		}
		title, ok := titleCache[row.DesignID]
		if !ok {
			title = s.titleOf(ctx, row.DesignID)
			titleCache[row.DesignID] = title
		}
		v, err := s.flatView(ctx, row)
		if err != nil {
			return nil, err
		}
		out = append(out, MyTaskView{CommentView: v, DesignTitle: title})
	}
	return out, nil
}

// MyMentions returns comments that @mention the caller across accessible designs.
func (s *Service) MyMentions(ctx context.Context, userID string) ([]MyTaskView, error) {
	rows, err := s.listMentionsForUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := []MyTaskView{}
	titleCache := map[string]string{}
	accessCache := map[string]bool{}
	for _, m := range rows {
		comment, err := s.getComment(ctx, m.CommentID)
		if err != nil {
			continue
		}
		ok, cached := accessCache[comment.DesignID]
		if !cached {
			access, err := s.access.GetAccess(ctx, comment.DesignID, userID)
			ok = err == nil && hasCap(access, authz.CapView)
			accessCache[comment.DesignID] = ok
		}
		if !ok {
			continue
		}
		title, has := titleCache[comment.DesignID]
		if !has {
			title = s.titleOf(ctx, comment.DesignID)
			titleCache[comment.DesignID] = title
		}
		v, err := s.flatView(ctx, comment)
		if err != nil {
			return nil, err
		}
		out = append(out, MyTaskView{CommentView: v, DesignTitle: title})
	}
	return out, nil
}

func (s *Service) titleOf(ctx context.Context, designID string) string {
	title, err := s.persist.GetTitle(ctx, designID)
	if err != nil || title == "" {
		return "Untitled design"
	}
	return title
}

func (s *Service) flatView(ctx context.Context, row CommentRow) (CommentView, error) {
	reactions, err := s.listReactions(ctx, []string{row.ID})
	if err != nil {
		return CommentView{}, err
	}
	mentions, err := s.listMentions(ctx, []string{row.ID})
	if err != nil {
		return CommentView{}, err
	}
	mids := make([]string, 0, len(mentions))
	for _, m := range mentions {
		mids = append(mids, m.UserID)
	}
	return s.commentView(row, groupReactions(reactions)[row.ID], mids), nil
}

// --- mentionable people (FR-3) -------------------------------------------

// mentionablePeople: active workspace members plus per-design grant holders
// (by user id), resolved to id + name, sorted by name.
func (s *Service) mentionablePeople(ctx context.Context, designID string) ([]MentionablePerson, error) {
	workspaceID, err := s.persist.GetWorkspaceID(ctx, designID)
	if err != nil {
		return nil, ErrNotFound
	}
	memberIDs, err := s.listWorkspaceMemberIDs(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	grants, err := s.access.ListDesignGrants(ctx, designID)
	if err != nil {
		return nil, err
	}
	ids := map[string]bool{}
	for _, id := range memberIDs {
		ids[id] = true
	}
	for _, g := range grants {
		if g.UserID != nil {
			ids[*g.UserID] = true
		}
	}
	people := make([]MentionablePerson, 0, len(ids))
	for id := range ids {
		u, err := s.accounts.GetUserByID(ctx, id)
		if err == nil && u != nil {
			email := u.Email
			people = append(people, MentionablePerson{ID: u.ID, Name: u.Name, Email: &email})
		}
	}
	sort.Slice(people, func(i, j int) bool { return people[i].Name < people[j].Name })
	return people, nil
}

// ListMentionable is the mentionable-people endpoint, gated on `view`.
func (s *Service) ListMentionable(ctx context.Context, designID, userID string) ([]MentionablePerson, error) {
	if err := s.assertCapability(ctx, designID, userID, authz.CapView); err != nil {
		return nil, err
	}
	return s.mentionablePeople(ctx, designID)
}

// --- hooks (nil-safe) ----------------------------------------------------

func (s *Service) notifyChanged(ctx context.Context, designID string) {
	if s.realtime != nil {
		s.realtime.NotifyCommentChanged(ctx, designID)
	}
}

func (s *Service) emit(ctx context.Context, designID, actorID, kind string, payload map[string]any) {
	if s.engagement != nil {
		s.engagement.EmitActivity(ctx, designID, actorID, kind, payload)
	}
}

func (s *Service) notify(ctx context.Context, actorID, targetUserID, typ, designID string, payload map[string]any) {
	if s.engagement != nil {
		s.engagement.Notify(ctx, actorID, targetUserID, typ, designID, payload)
	}
}

func ptrEq(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
