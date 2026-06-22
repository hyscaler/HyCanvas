package comments

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/persistence"
	"hycanvas/backend/internal/sharing"
)

func stripSchema(dsn string) string {
	for _, sep := range []string{"?schema=", "&schema="} {
		if i := strings.Index(dsn, sep); i >= 0 {
			return dsn[:i]
		}
	}
	return dsn
}

// persistTitles adapts the persistence service for the test.
type persistTitles struct{ p *persistence.Service }

func (a persistTitles) GetWorkspaceID(ctx context.Context, designID string) (string, error) {
	return a.p.GetWorkspaceID(ctx, designID)
}
func (a persistTitles) GetTitle(ctx context.Context, designID string) (string, error) {
	rec, err := a.p.GetRecord(ctx, designID)
	if err != nil {
		return "", err
	}
	return rec.Title, nil
}

// stubFiles is a fixed live node-id set for orphan-detection tests.
type stubFiles struct{ ids map[string]bool }

func (s stubFiles) NodeIDs(ctx context.Context, designID, workspaceID string) (map[string]bool, error) {
	return s.ids, nil
}

func addMember(ctx context.Context, t *testing.T, tx pgx.Tx, workspaceID, userID, role string) {
	t.Helper()
	if _, err := tx.Exec(ctx,
		`INSERT INTO "WorkspaceMember" (id,"workspaceId","userId",role,status,"joinedAt","updatedAt")
		 VALUES ($1,$2,$3,$4,'ACTIVE',now(),now())`,
		uuid.NewString(), workspaceID, userID, role); err != nil {
		t.Fatalf("addMember(%s): %v", role, err)
	}
}

func TestComments_DB(t *testing.T) {
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

	acct := accounts.NewService(tx, "test-jwt-secret")
	owner, ws, _, err := acct.Signup(ctx, "cmt-owner+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup owner: %v", err)
	}
	member, _, _, err := acct.Signup(ctx, "cmt-member+"+uuid.NewString()+"@example.com", "a-strong-password", "Member")
	if err != nil {
		t.Fatalf("signup member: %v", err)
	}
	addMember(ctx, t, tx, ws.ID, member.ID, "MEMBER")
	// A viewer can read but not comment.
	viewer, _, _, err := acct.Signup(ctx, "cmt-viewer+"+uuid.NewString()+"@example.com", "a-strong-password", "Viewer")
	if err != nil {
		t.Fatalf("signup viewer: %v", err)
	}
	addMember(ctx, t, tx, ws.ID, viewer.ID, "VIEWER")
	outsider, _, _, err := acct.Signup(ctx, "cmt-out+"+uuid.NewString()+"@example.com", "a-strong-password", "Outsider")
	if err != nil {
		t.Fatalf("signup outsider: %v", err)
	}

	designID := uuid.NewString()
	if _, err := tx.Exec(ctx, `INSERT INTO "Design" (id,"workspaceId",title,"updatedAt") VALUES ($1,$2,'Doc',now())`, designID, ws.ID); err != nil {
		t.Fatalf("design: %v", err)
	}

	persist := persistence.NewService(tx)
	sh := sharing.NewService(tx, persist, nil, nil)
	svc := NewService(tx, sh, acct, persistTitles{persist}, nil, nil)

	// Outsider cannot even read (no view) -> NotFound.
	if _, err := svc.ListThreads(ctx, designID, outsider.ID, "all"); err != ErrNotFound {
		t.Fatalf("outsider list should be NotFound, got %v", err)
	}
	// Outsider cannot comment (no comment capability) -> Forbidden.
	if _, err := svc.CreateComment(ctx, designID, outsider.ID, CreateInput{Anchor: Anchor{Kind: "design"}, Body: "hi"}); err != ErrForbidden {
		t.Fatalf("outsider create should be Forbidden, got %v", err)
	}

	// Owner creates a comment that @mentions the member.
	c, err := svc.CreateComment(ctx, designID, owner.ID, CreateInput{Anchor: Anchor{Kind: "design"}, Body: "Hello @member", Mentions: []string{member.ID}})
	if err != nil {
		t.Fatalf("CreateComment: %v", err)
	}
	if len(c.Mentions) != 1 || c.Mentions[0] != member.ID {
		t.Fatalf("mention not recorded: %+v", c.Mentions)
	}

	// Member replies.
	reply, err := svc.Reply(ctx, c.ID, member.ID, ReplyInput{Body: "On it"})
	if err != nil {
		t.Fatalf("Reply: %v", err)
	}
	if reply.ParentID == nil || *reply.ParentID != c.ID {
		t.Fatalf("reply parent wrong: %+v", reply)
	}
	// Cannot reply to a reply.
	if _, err := svc.Reply(ctx, reply.ID, owner.ID, ReplyInput{Body: "x"}); err != ErrBadRequest {
		t.Fatalf("reply-to-reply should be BadRequest, got %v", err)
	}

	// Threads: one root with one reply; viewer can read.
	threads, err := svc.ListThreads(ctx, designID, viewer.ID, "all")
	if err != nil {
		t.Fatalf("ListThreads(viewer): %v", err)
	}
	if len(threads) != 1 || len(threads[0].Replies) != 1 {
		t.Fatalf("thread shape wrong: %+v", threads)
	}

	// Reaction toggle (add then remove).
	if v, err := svc.ToggleReaction(ctx, c.ID, member.ID, "👍"); err != nil || len(v.Reactions) != 1 {
		t.Fatalf("react add wrong: %+v err=%v", v, err)
	}
	if v, err := svc.ToggleReaction(ctx, c.ID, member.ID, "👍"); err != nil || len(v.Reactions) != 0 {
		t.Fatalf("react remove wrong: %+v err=%v", v, err)
	}

	// A member cannot delete the owner's comment (not author, no delete cap).
	if err := svc.DeleteComment(ctx, c.ID, member.ID); err != ErrForbidden {
		t.Fatalf("member delete others should be Forbidden, got %v", err)
	}
	// The owner (delete cap) can delete the member's reply.
	if err := svc.DeleteComment(ctx, reply.ID, owner.ID); err != nil {
		t.Fatalf("owner delete reply: %v", err)
	}

	// Convert root to a task assigned to the member.
	statusOpen := "open"
	tv, err := svc.SetTask(ctx, c.ID, owner.ID, TaskInput{AssigneeID: &member.ID, AssigneeIDSet: true, Status: &statusOpen, StatusSet: true})
	if err != nil {
		t.Fatalf("SetTask: %v", err)
	}
	if tv.Task == nil || tv.Task.AssigneeID == nil || *tv.Task.AssigneeID != member.ID || tv.Task.Status != "open" {
		t.Fatalf("task not set: %+v", tv.Task)
	}
	// My-tasks for the member surfaces it with the design title.
	mine, err := svc.MyTasks(ctx, member.ID, "")
	if err != nil {
		t.Fatalf("MyTasks: %v", err)
	}
	if len(mine) != 1 || mine[0].ID != c.ID || mine[0].DesignTitle != "Doc" {
		t.Fatalf("my tasks wrong: %+v", mine)
	}
	// My-mentions for the member surfaces the root comment.
	mentions, err := svc.MyMentions(ctx, member.ID)
	if err != nil {
		t.Fatalf("MyMentions: %v", err)
	}
	if len(mentions) != 1 || mentions[0].ID != c.ID {
		t.Fatalf("my mentions wrong: %+v", mentions)
	}

	// Resolve the thread.
	if v, err := svc.SetResolved(ctx, c.ID, member.ID, true); err != nil || !v.Resolved {
		t.Fatalf("resolve failed: %+v err=%v", v, err)
	}
	open, err := svc.ListThreads(ctx, designID, owner.ID, "open")
	if err != nil || len(open) != 0 {
		t.Fatalf("open filter should hide resolved: %+v err=%v", open, err)
	}

	// Orphan detection: with a live node-id set, an element anchor whose node is
	// gone is flagged orphaned; one whose node exists is not (FR-1).
	svc.WithFiles(stubFiles{ids: map[string]bool{"real": true}})
	ghost := "ghost"
	real := "real"
	if _, err := svc.CreateComment(ctx, designID, owner.ID, CreateInput{Anchor: Anchor{Kind: "element", NodeID: &ghost}, Body: "on a deleted node"}); err != nil {
		t.Fatalf("create ghost comment: %v", err)
	}
	if _, err := svc.CreateComment(ctx, designID, owner.ID, CreateInput{Anchor: Anchor{Kind: "element", NodeID: &real}, Body: "on a live node"}); err != nil {
		t.Fatalf("create real comment: %v", err)
	}
	allThreads, err := svc.ListThreads(ctx, designID, owner.ID, "all")
	if err != nil {
		t.Fatalf("ListThreads orphan: %v", err)
	}
	var sawGhost, sawReal bool
	for _, tr := range allThreads {
		if tr.Anchor.Kind != "element" || tr.Anchor.NodeID == nil {
			continue
		}
		switch *tr.Anchor.NodeID {
		case "ghost":
			sawGhost = true
			if !tr.Anchor.Orphaned {
				t.Fatalf("ghost-anchored comment should be orphaned")
			}
		case "real":
			sawReal = true
			if tr.Anchor.Orphaned {
				t.Fatalf("real-anchored comment should not be orphaned")
			}
		}
	}
	if !sawGhost || !sawReal {
		t.Fatalf("element-anchored comments missing: ghost=%v real=%v", sawGhost, sawReal)
	}

	// Mentionable people = active members (owner, member, viewer); outsider absent.
	people, err := svc.ListMentionable(ctx, designID, owner.ID)
	if err != nil {
		t.Fatalf("ListMentionable: %v", err)
	}
	got := map[string]bool{}
	for _, p := range people {
		got[p.ID] = true
	}
	if !got[owner.ID] || !got[member.ID] || !got[viewer.ID] || got[outsider.ID] {
		t.Fatalf("mentionable set wrong: %+v", people)
	}
}
