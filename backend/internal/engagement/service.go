// Read side of the engagement features (doc 17 slice D): the activity feed
// (FR-12), the notifications center (FR-13), and engagement insights (FR-14).
// Every per-design read is permission-gated server-side via the sharing access
// resolver: the activity feed + view-beat need `view`; insights need member/
// owner (the `share` capability only member/admin/owner hold). Notifications are
// owned by the caller, scoped to the caller's user id.
//
// The activity feed folds in F04/F16 version history as `edit` items via the
// optional Versions hook (one page of recent versions, simpler than the Node
// multi-page walk); without the hook the feed returns stored events only (the
// same fallback the Node service uses when history is unreadable).
package engagement

import (
	"context"
	"errors"
	"time"

	"hycanvas/backend/internal/authz"
	"hycanvas/backend/internal/sharing"
)

const (
	activityPageSize      = 40
	notificationsPageSize = 30
)

// Errors map to RFC 7807 statuses at the HTTP layer.
var (
	ErrForbidden = errors.New("forbidden")
	ErrNotFound  = errors.New("not found")
)

// SharingAccess resolves per-design access and (for the public shared view-beat)
// resolves a share link by token.
type SharingAccess interface {
	GetAccess(ctx context.Context, designID, userID string) (sharing.DesignAccessView, error)
	ResolveLink(ctx context.Context, token string, opts sharing.ResolveLinkOpts) (sharing.ResolvedLink, error)
}

// VersionEdit is a version-history entry folded into the activity feed as an
// `edit` item (FR-12).
type VersionEdit struct {
	ID         string
	AuthorID   *string
	AuthorName *string
	Label      *string
	Kind       string
	CreatedAt  string // RFC3339Nano UTC
}

// Versions lists a design's recent version-history entries for the activity
// feed fold (FR-12). Optional (attached via WithVersions); nil = no edit items.
type Versions interface {
	VersionEdits(ctx context.Context, designID string, limit int) ([]VersionEdit, error)
}

// Service is the engagement read side.
type Service struct {
	db       DBTX
	access   SharingAccess
	accounts Accounts
	titles   Titles
	versions Versions
}

// NewService wires the engagement read service.
func NewService(db DBTX, access SharingAccess, acct Accounts, titles Titles) *Service {
	return &Service{db: db, access: access, accounts: acct, titles: titles}
}

// WithVersions attaches the version-history loader, enabling the activity-feed
// edit fold (FR-12). Returns the same service for chaining.
func (s *Service) WithVersions(v Versions) *Service {
	s.versions = v
	return s
}

func hasCap(access sharing.DesignAccessView, c authz.Capability) bool {
	for _, x := range access.Capabilities {
		if x == c {
			return true
		}
	}
	return false
}

func (s *Service) assertView(ctx context.Context, designID, userID string) error {
	access, err := s.access.GetAccess(ctx, designID, userID)
	if err != nil || !hasCap(access, authz.CapView) {
		return ErrNotFound
	}
	return nil
}

func (s *Service) assertMember(ctx context.Context, designID, userID string) error {
	access, err := s.access.GetAccess(ctx, designID, userID)
	if err != nil || !hasCap(access, authz.CapView) {
		return ErrNotFound
	}
	if !hasCap(access, authz.CapShare) {
		return ErrForbidden
	}
	return nil
}

func (s *Service) nameOf(ctx context.Context, userID *string) *string {
	if userID == nil || *userID == "" {
		return nil
	}
	u, err := s.accounts.GetUserByID(ctx, *userID)
	if err != nil || u == nil || u.Name == "" {
		return nil
	}
	return &u.Name
}

func parseCursor(cursor string) *time.Time {
	if cursor == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if t, err := time.Parse(layout, cursor); err == nil {
			return &t
		}
	}
	return nil
}

// --- activity feed (FR-12) -----------------------------------------------

// ActivityItem is one attributed feed item.
type ActivityItem struct {
	ID        string         `json:"id"`
	DesignID  string         `json:"designId"`
	Type      string         `json:"type"`
	ActorID   *string        `json:"actorId"`
	ActorName *string        `json:"actorName"`
	Summary   string         `json:"summary"`
	Payload   map[string]any `json:"payload"`
	CreatedAt string         `json:"createdAt"`
	Source    string         `json:"source"`
}

// ActivityPage is the paginated activity result.
type ActivityPage struct {
	Items      []ActivityItem `json:"items"`
	NextCursor *string        `json:"nextCursor,omitempty"`
}

func (s *Service) ListActivity(ctx context.Context, designID, userID, typ, cursor string) (ActivityPage, error) {
	if err := s.assertView(ctx, designID, userID); err != nil {
		return ActivityPage{}, err
	}
	if typ != "" && !activityTypeSet[typ] {
		typ = ""
	}
	before := parseCursor(cursor)

	// Stored events (everything except edits), unless filtering to `edit` only.
	items := make([]ActivityItem, 0, activityPageSize+1)
	if typ != "edit" {
		rows, err := s.listActivity(ctx, designID, typ, before, activityPageSize+1)
		if err != nil {
			return ActivityPage{}, err
		}
		for _, r := range rows {
			name := s.nameOf(ctx, r.ActorID)
			nameStr := ""
			if name != nil {
				nameStr = *name
			}
			items = append(items, ActivityItem{
				ID: r.ID, DesignID: r.DesignID, Type: r.Type, ActorID: r.ActorID, ActorName: name,
				Summary: summarizeActivity(r.Type, nameStr, r.Payload), Payload: r.Payload,
				CreatedAt: r.CreatedAt.UTC().Format(isoFmt), Source: "activity",
			})
		}
	}

	// Version-history edits folded in (FR-12), unless a non-edit type filter is
	// set. Older than the cursor only; same-format ISO timestamps compare
	// lexicographically.
	if s.versions != nil && (typ == "" || typ == "edit") {
		edits, err := s.versions.VersionEdits(ctx, designID, activityPageSize+1)
		if err == nil {
			for _, e := range edits {
				if cursor != "" && e.CreatedAt >= cursor {
					continue
				}
				name := ""
				if e.AuthorName != nil {
					name = *e.AuthorName
				}
				items = append(items, ActivityItem{
					ID: "version:" + e.ID, DesignID: designID, Type: "edit", ActorID: e.AuthorID, ActorName: e.AuthorName,
					Summary:   summarizeActivity("edit", name, nil),
					Payload:   map[string]any{"versionId": e.ID, "label": e.Label, "kind": e.Kind},
					CreatedAt: e.CreatedAt, Source: "version",
				})
			}
		}
	}

	// Merge newest-first, then page.
	sortActivityDesc(items)
	page := ActivityPage{Items: items}
	if len(items) > activityPageSize {
		page.Items = items[:activityPageSize]
		last := page.Items[len(page.Items)-1].CreatedAt
		page.NextCursor = &last
	}
	return page, nil
}

// --- notifications center (FR-13) ----------------------------------------

// sortActivityDesc orders items newest-first by createdAt (stable). The two
// sources (stored events, version edits) are each already roughly ordered; this
// merges them. Insertion sort is fine for one page (<= ~80 items).
func sortActivityDesc(items []ActivityItem) {
	for i := 1; i < len(items); i++ {
		j := i
		for j > 0 && items[j-1].CreatedAt < items[j].CreatedAt {
			items[j-1], items[j] = items[j], items[j-1]
			j--
		}
	}
}

type NotificationView struct {
	ID        string  `json:"id"`
	Type      string  `json:"type"`
	DesignID  *string `json:"designId"`
	Text      string  `json:"text"`
	Link      string  `json:"link"`
	Read      bool    `json:"read"`
	CreatedAt string  `json:"createdAt"`
}

type NotificationPage struct {
	Items      []NotificationView `json:"items"`
	NextCursor *string            `json:"nextCursor,omitempty"`
}

func (s *Service) ListNotifications(ctx context.Context, userID string, unread bool, cursor string) (NotificationPage, error) {
	before := parseCursor(cursor)
	rows, err := s.listNotifications(ctx, userID, unread, before, notificationsPageSize+1)
	if err != nil {
		return NotificationPage{}, err
	}
	items := make([]NotificationView, 0, len(rows))
	for _, n := range rows {
		items = append(items, notificationView(n))
	}
	page := NotificationPage{Items: items}
	if len(items) > notificationsPageSize {
		page.Items = items[:notificationsPageSize]
		last := page.Items[len(page.Items)-1].CreatedAt
		page.NextCursor = &last
	}
	return page, nil
}

func notificationView(n NotificationRow) NotificationView {
	actor := pstr(n.Payload, "actorName")
	title := pstr(n.Payload, "designTitle")
	link := "/dashboard"
	if n.DesignID != nil {
		link = "/editor?id=" + *n.DesignID
		// An access request is actioned in the Share dialog's pending-requests
		// inbox, so deep-link straight into it (otherwise the owner lands on the
		// editor and has to open Share manually to find the request).
		if n.Type == "access_request" {
			link += "&share=requests"
		}
	} else if n.Type == "workspace_invite" {
		link = "/accept-invite" // the in-app accept/decline surface
	}
	return NotificationView{
		ID: n.ID, Type: n.Type, DesignID: n.DesignID,
		Text: notificationText(n.Type, actor, title, n.Payload),
		Link: link, Read: n.ReadAt != nil, CreatedAt: n.CreatedAt.UTC().Format(isoFmt),
	}
}

func (s *Service) UnreadCount(ctx context.Context, userID string) (int, error) {
	return s.unreadCount(ctx, userID)
}

func (s *Service) MarkRead(ctx context.Context, notificationID, userID string) error {
	n, err := s.getNotification(ctx, notificationID)
	if err != nil {
		return err
	}
	if n.UserID != userID {
		return ErrNotFound
	}
	if n.ReadAt == nil {
		return s.markRead(ctx, notificationID, time.Now())
	}
	return nil
}

func (s *Service) MarkAllRead(ctx context.Context, userID string) error {
	return s.markAllRead(ctx, userID, time.Now())
}

// --- notification prefs (FR-13) ------------------------------------------

type NotificationPrefView struct {
	EmailTypes []string `json:"emailTypes"`
	PushTypes  []string `json:"pushTypes"`
}

func (s *Service) GetPrefs(ctx context.Context, userID string) (NotificationPrefView, error) {
	email, err := getTypes(ctx, s.db, userID, "emailTypes")
	if err != nil {
		return NotificationPrefView{}, err
	}
	push, err := getTypes(ctx, s.db, userID, "pushTypes")
	if err != nil {
		return NotificationPrefView{}, err
	}
	if email == nil {
		email = defaultEmailTypes()
	}
	if push == nil {
		push = defaultPushTypes()
	}
	return NotificationPrefView{EmailTypes: email, PushTypes: push}, nil
}

// SetPrefsInput patches per-channel preferences; each channel is optional.
type SetPrefsInput struct {
	EmailTypes    []string
	EmailTypesSet bool
	PushTypes     []string
	PushTypesSet  bool
}

func (s *Service) SetPrefs(ctx context.Context, userID string, in SetPrefsInput) (NotificationPrefView, error) {
	if in.EmailTypesSet {
		if err := setTypes(ctx, s.db, userID, "emailTypes", sanitizeTypes(in.EmailTypes)); err != nil {
			return NotificationPrefView{}, err
		}
	}
	if in.PushTypesSet {
		if err := setTypes(ctx, s.db, userID, "pushTypes", sanitizeTypes(in.PushTypes)); err != nil {
			return NotificationPrefView{}, err
		}
	}
	return s.GetPrefs(ctx, userID)
}

// --- insights (FR-14) ----------------------------------------------------

// ViewBeat is the named-viewer heartbeat payload.
type ViewBeat struct {
	SessionID string
	PageID    *string
	Ms        int
}

func (s *Service) RecordViewBeat(ctx context.Context, designID, userID string, in ViewBeat) error {
	if err := s.assertView(ctx, designID, userID); err != nil {
		return err
	}
	uid := userID
	return s.recordViewBeat(ctx, ViewBeatInput{DesignID: designID, ViewerID: &uid, SessionID: in.SessionID, PageID: in.PageID, DeltaMs: in.Ms})
}

// AnonViewBeat is the anonymous (share-link) heartbeat payload.
type AnonViewBeat struct {
	AnonID    string
	SessionID string
	PageID    *string
	Ms        int
}

func (s *Service) RecordAnonViewBeat(ctx context.Context, designID string, in AnonViewBeat) error {
	anon := in.AnonID
	return s.recordViewBeat(ctx, ViewBeatInput{DesignID: designID, AnonID: &anon, SessionID: in.SessionID, PageID: in.PageID, DeltaMs: in.Ms})
}

// RecordSharedViewBeat validates a share-link token, then records an anonymous
// heartbeat against the design it grants (FR-14, FR-15).
func (s *Service) RecordSharedViewBeat(ctx context.Context, token, password string, in AnonViewBeat) error {
	resolved, err := s.access.ResolveLink(ctx, token, sharing.ResolveLinkOpts{Password: password})
	if err != nil {
		return err
	}
	return s.RecordAnonViewBeat(ctx, resolved.DesignID, in)
}

func (s *Service) Insights(ctx context.Context, designID, userID string) (DesignInsights, error) {
	if err := s.assertMember(ctx, designID, userID); err != nil {
		return DesignInsights{}, err
	}
	rows, err := s.listViews(ctx, designID)
	if err != nil {
		return DesignInsights{}, err
	}
	return aggregateInsights(rows), nil
}
