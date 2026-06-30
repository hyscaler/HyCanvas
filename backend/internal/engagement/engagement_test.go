package engagement

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

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

type titlesAdapter struct{ p *persistence.Service }

func (a titlesAdapter) GetTitle(ctx context.Context, designID string) (string, error) {
	rec, err := a.p.GetRecord(ctx, designID)
	if err != nil {
		return "", err
	}
	return rec.Title, nil
}

// stubVersions returns a fixed version-edit list for the activity-fold test.
type stubVersions struct{ edits []VersionEdit }

func (s stubVersions) VersionEdits(ctx context.Context, designID string, limit int) ([]VersionEdit, error) {
	return s.edits, nil
}

func TestSummarizeAndNotificationText(t *testing.T) {
	if got := summarizeActivity("comment", "Ada", nil); got != "Ada left a comment" {
		t.Fatalf("summary comment = %q", got)
	}
	if got := summarizeActivity("approval_decision", "", map[string]any{"decision": "approve"}); got != "Someone approved the design" {
		t.Fatalf("summary approve = %q", got)
	}
	if got := notificationText("mention", "Ada", "Deck", nil); got != `Ada mentioned you on "Deck"` {
		t.Fatalf("notif mention = %q", got)
	}
	if got := summarizeActivity("share", "Ada", map[string]any{"op": "changed", "mode": "edit"}); got != "Ada changed a person's access to edit" {
		t.Fatalf("summary share = %q", got)
	}
}

func TestAggregateInsights(t *testing.T) {
	v := func(viewer, anon string, ms int, pp map[string]int) DesignViewRow {
		r := DesignViewRow{DurationMs: ms, OpenedAt: time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC), PerPage: pp}
		if viewer != "" {
			r.ViewerID = &viewer
		}
		if anon != "" {
			r.AnonID = &anon
		}
		return r
	}
	ins := aggregateInsights([]DesignViewRow{
		v("u1", "", 1000, map[string]int{"p1": 600, "p2": 400}),
		v("u1", "", 2000, map[string]int{"p1": 1000}),
		v("", "a1", 500, nil),
	})
	if ins.UniqueViewers != 1 || ins.UniqueAnonViewers != 1 || ins.TotalViews != 3 {
		t.Fatalf("counts wrong: %+v", ins)
	}
	if ins.AvgTimeMs != (1000+2000+500)/3 {
		t.Fatalf("avg wrong: %d", ins.AvgTimeMs)
	}
	if len(ins.PerPage) != 2 || ins.PerPage[0].PageID != "p1" || ins.PerPage[0].EngagementMs != 1600 {
		t.Fatalf("perPage wrong: %+v", ins.PerPage)
	}
}

func TestEngagement_DB(t *testing.T) {
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
	owner, ws, _, err := acct.Signup(ctx, "eng-owner+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup owner: %v", err)
	}
	other, _, _, err := acct.Signup(ctx, "eng-other+"+uuid.NewString()+"@example.com", "a-strong-password", "Other")
	if err != nil {
		t.Fatalf("signup other: %v", err)
	}

	designID := uuid.NewString()
	if _, err := tx.Exec(ctx, `INSERT INTO "designs" (id,"workspace_id",title,"updated_at") VALUES ($1,$2,'Deck',now())`, designID, ws.ID); err != nil {
		t.Fatalf("design: %v", err)
	}

	persist := persistence.NewService(tx)
	titles := titlesAdapter{persist}
	sh := sharing.NewService(tx, persist, nil, nil)
	emitter := NewEmitter(tx, acct, titles)
	svc := NewService(tx, sh, acct, titles)

	// Emit an activity event + a notification to the owner from "other".
	emitter.EmitActivity(ctx, designID, other.ID, "comment", map[string]any{"commentId": "c1"})
	emitter.Notify(ctx, other.ID, owner.ID, "mention", designID, map[string]any{"commentId": "c1"})
	// Self-notify is dropped.
	emitter.Notify(ctx, owner.ID, owner.ID, "mention", designID, nil)

	// Activity feed (owner has view) shows the event with a summary.
	feed, err := svc.ListActivity(ctx, designID, owner.ID, "", "")
	if err != nil {
		t.Fatalf("ListActivity: %v", err)
	}
	if len(feed.Items) != 1 || feed.Items[0].Type != "comment" || feed.Items[0].Summary != "Other left a comment" {
		t.Fatalf("feed wrong: %+v", feed.Items)
	}

	// With a Versions hook, the feed folds in a version-history `edit` item.
	svc.WithVersions(stubVersions{edits: []VersionEdit{
		{ID: "v1", Kind: "checkpoint", CreatedAt: "2999-01-01T00:00:00.000Z"},
	}})
	folded, err := svc.ListActivity(ctx, designID, owner.ID, "", "")
	if err != nil {
		t.Fatalf("ListActivity fold: %v", err)
	}
	if len(folded.Items) < 2 || folded.Items[0].Source != "version" || folded.Items[0].ID != "version:v1" || folded.Items[0].Type != "edit" {
		t.Fatalf("version edit not folded newest-first: %+v", folded.Items)
	}
	// Filtering to a non-edit type excludes the version item.
	onlyComments, err := svc.ListActivity(ctx, designID, owner.ID, "comment", "")
	if err != nil {
		t.Fatalf("ListActivity comment filter: %v", err)
	}
	for _, it := range onlyComments.Items {
		if it.Source == "version" {
			t.Fatalf("comment filter should exclude version items: %+v", it)
		}
	}

	// Outsider/no-view cannot read the feed.
	if _, err := svc.ListActivity(ctx, designID, other.ID, "", ""); err != ErrNotFound {
		// "other" is not a member and has no grant -> NotFound.
		t.Fatalf("non-member feed should be NotFound, got %v", err)
	}

	// Notifications: the owner has exactly one unread; self-notify was dropped.
	if n, err := svc.UnreadCount(ctx, owner.ID); err != nil || n != 1 {
		t.Fatalf("unread count = %d err=%v", n, err)
	}
	page, err := svc.ListNotifications(ctx, owner.ID, false, "")
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("notifications wrong: %+v err=%v", page.Items, err)
	}
	notif := page.Items[0]
	// The in-app row carries only actorName in its payload (the design title is
	// resolved only for the deferred email channel), so no `on "Deck"` suffix.
	if notif.Text != "Other mentioned you" {
		t.Fatalf("notif text = %q", notif.Text)
	}

	// Mark read -> unread count drops to 0.
	if err := svc.MarkRead(ctx, notif.ID, owner.ID); err != nil {
		t.Fatalf("MarkRead: %v", err)
	}
	if n, _ := svc.UnreadCount(ctx, owner.ID); n != 0 {
		t.Fatalf("after read unread = %d", n)
	}
	// Another user cannot mark someone else's notification read.
	if err := svc.MarkRead(ctx, notif.ID, other.ID); err != ErrNotFound {
		t.Fatalf("cross-user markRead should be NotFound, got %v", err)
	}

	// Prefs: defaults then a narrowing update.
	prefs, err := svc.GetPrefs(ctx, owner.ID)
	if err != nil || len(prefs.EmailTypes) != len(defaultEmailTypes()) {
		t.Fatalf("default prefs wrong: %+v err=%v", prefs, err)
	}
	updated, err := svc.SetPrefs(ctx, owner.ID, SetPrefsInput{EmailTypes: []string{"mention", "bogus"}, EmailTypesSet: true})
	if err != nil || len(updated.EmailTypes) != 1 || updated.EmailTypes[0] != "mention" {
		t.Fatalf("set prefs wrong: %+v err=%v", updated, err)
	}

	// View-beat heartbeats accumulate per session + page; insights aggregate.
	p1 := "page-1"
	if err := svc.RecordViewBeat(ctx, designID, owner.ID, ViewBeat{SessionID: "s1", PageID: &p1, Ms: 1000}); err != nil {
		t.Fatalf("view beat 1: %v", err)
	}
	if err := svc.RecordViewBeat(ctx, designID, owner.ID, ViewBeat{SessionID: "s1", PageID: &p1, Ms: 500}); err != nil {
		t.Fatalf("view beat 2: %v", err)
	}
	if err := svc.RecordAnonViewBeat(ctx, designID, AnonViewBeat{AnonID: "anon-1", SessionID: "s2", PageID: &p1, Ms: 300}); err != nil {
		t.Fatalf("anon beat: %v", err)
	}
	ins, err := svc.Insights(ctx, designID, owner.ID)
	if err != nil {
		t.Fatalf("Insights: %v", err)
	}
	if ins.UniqueViewers != 1 || ins.UniqueAnonViewers != 1 || ins.TotalViews != 2 {
		t.Fatalf("insights counts wrong: %+v", ins)
	}
	// s1 accumulated 1500ms on page-1.
	if len(ins.PerPage) != 1 || ins.PerPage[0].PageID != p1 || ins.PerPage[0].EngagementMs != 1800 {
		t.Fatalf("insights perPage wrong: %+v", ins.PerPage)
	}

	// Insights require member/owner: "other" (no access) is NotFound.
	if _, err := svc.Insights(ctx, designID, other.ID); err != ErrNotFound {
		t.Fatalf("non-member insights should be NotFound, got %v", err)
	}
}
