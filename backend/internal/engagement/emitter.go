// The write side of the activity log + notifications center (doc 17 FR-12,
// FR-13). A dependency-light emitter the mutation services (comments, sharing,
// approvals) inject to record an activity event and fan out notifications
// WITHOUT forming a construction cycle: it depends only on the DB, the account
// lookup, and the design-title lookup. It never references the sharing service,
// so sharing can hold it safely.
//
// Deferred vs the Node original: the email + web-push channels (mailer /
// WebPushService) and the realtime live-unread bump are not ported, so delivery
// is in-app only (a Notification row); per-user channel preferences are still
// stored and returned. A user is never notified about their own action.
package engagement

import (
	"context"
	"log/slog"

	"hycanvas/backend/internal/accounts"
)

// Accounts resolves display names + emails for attribution.
type Accounts interface {
	GetUserByID(ctx context.Context, id string) (*accounts.AuthUser, error)
}

// Titles resolves a design's title for notification text.
type Titles interface {
	GetTitle(ctx context.Context, designID string) (string, error)
}

// Pusher delivers a web-push notification to a user (optional channel, FR-13).
// Nil = push not configured; in-app is always written.
type Pusher interface {
	Send(ctx context.Context, userID, title, body, url string)
}

// Emitter records activity events and writes notifications. It satisfies the
// Engagement hook interface the sharing/approvals/comments modules accept.
type Emitter struct {
	db       DBTX
	accounts Accounts
	titles   Titles
	push     Pusher
}

// NewEmitter wires the write-side emitter.
func NewEmitter(db DBTX, acct Accounts, titles Titles) *Emitter {
	return &Emitter{db: db, accounts: acct, titles: titles}
}

// WithPush attaches the web-push channel; notifications of a type the user opted
// into (pushTypes pref) are also delivered by push (best-effort).
func (e *Emitter) WithPush(p Pusher) *Emitter {
	e.push = p
	return e
}

func (e *Emitter) nameOf(ctx context.Context, userID string) string {
	if userID == "" {
		return ""
	}
	u, err := e.accounts.GetUserByID(ctx, userID)
	if err != nil || u == nil {
		return ""
	}
	return u.Name
}

// EmitActivity appends an activity event for a design (FR-12). Best-effort: a
// write failure is logged and swallowed so feed-logging never breaks the
// underlying mutation.
func (e *Emitter) EmitActivity(ctx context.Context, designID, actorID, kind string, payload map[string]any) {
	var actor *string
	if actorID != "" {
		actor = &actorID
	}
	if err := recordActivity(ctx, e.db, designID, actor, kind, payload); err != nil {
		slog.Warn("activity emit failed", "type", kind, "design", designID, "err", err)
	}
}

// Notify creates an in-app notification for one recipient (FR-13). The actor is
// never notified about their own action. Best-effort: a failure is logged and
// never blocks the mutation.
func (e *Emitter) Notify(ctx context.Context, actorID, targetUserID, typ, designID string, payload map[string]any) {
	if targetUserID == "" || targetUserID == actorID {
		return
	}
	actorName := e.nameOf(ctx, actorID)
	merged := map[string]any{}
	for k, v := range payload {
		merged[k] = v
	}
	if actorName != "" {
		merged["actorName"] = actorName
	}
	var design *string
	if designID != "" {
		design = &designID
	}
	if err := createNotification(ctx, e.db, targetUserID, typ, design, merged); err != nil {
		slog.Warn("notify failed", "user", targetUserID, "type", typ, "err", err)
	}
	e.maybePush(ctx, targetUserID, typ, designID, merged)
}

// maybePush delivers a web-push for a notification when the channel is enabled
// and the user opted the type into pushTypes (best-effort).
func (e *Emitter) maybePush(ctx context.Context, userID, typ, designID string, payload map[string]any) {
	if e.push == nil {
		return
	}
	stored, err := getTypes(ctx, e.db, userID, "push_types")
	if err != nil {
		return
	}
	types := stored
	if types == nil {
		types = defaultPushTypes()
	}
	allowed := false
	for _, t := range types {
		if t == typ {
			allowed = true
			break
		}
	}
	if !allowed {
		return
	}
	title := "HyCanvas"
	if designID != "" {
		if t, err := e.titles.GetTitle(ctx, designID); err == nil && t != "" {
			title = t
		}
	}
	actor, _ := payload["actorName"].(string)
	body := notificationText(typ, actor, "", payload)
	url := "/editor?id=" + designID
	if designID == "" {
		url = "/dashboard"
	}
	e.push.Send(ctx, userID, title, body, url)
}
