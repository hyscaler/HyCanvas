// SQL access for the engagement module, against the Prisma-managed tables
// "ActivityEvent", "Notification", "NotificationPref", and "DesignView" (quoted
// identifiers, camelCase columns). payload/perPage are JSONB; type strings are
// stored verbatim.
package engagement

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

// --- activity events -----------------------------------------------------

type ActivityEventRow struct {
	ID        string
	DesignID  string
	ActorID   *string
	Type      string
	Payload   map[string]any
	CreatedAt time.Time
}

func recordActivity(ctx context.Context, db DBTX, designID string, actorID *string, typ string, payload map[string]any) error {
	var raw []byte
	if payload != nil {
		raw, _ = json.Marshal(payload)
	}
	_, err := db.Exec(ctx,
		`INSERT INTO "ActivityEvent" (id,"designId","actorId",type,payload) VALUES ($1,$2,$3,$4,$5)`,
		uuid.NewString(), designID, actorID, typ, raw)
	return err
}

func scanActivity(row pgx.Row) (ActivityEventRow, error) {
	var a ActivityEventRow
	var raw []byte
	err := row.Scan(&a.ID, &a.DesignID, &a.ActorID, &a.Type, &raw, &a.CreatedAt)
	if err == nil && len(raw) > 0 {
		_ = json.Unmarshal(raw, &a.Payload)
	}
	return a, err
}

// listActivity returns newest-first events for a design, optionally filtered by
// type and windowed by a createdAt cursor (strictly older than before).
func (s *Service) listActivity(ctx context.Context, designID string, typ string, before *time.Time, limit int) ([]ActivityEventRow, error) {
	const q = `SELECT id,"designId","actorId",type,payload,"createdAt" FROM "ActivityEvent"
		WHERE "designId" = $1
		  AND ($2::text IS NULL OR type = $2)
		  AND ($3::timestamptz IS NULL OR "createdAt" < $3)
		ORDER BY "createdAt" DESC LIMIT $4`
	var typPtr *string
	if typ != "" {
		typPtr = &typ
	}
	rows, err := s.db.Query(ctx, q, designID, typPtr, before, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ActivityEventRow
	for rows.Next() {
		a, err := scanActivity(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// --- notifications -------------------------------------------------------

type NotificationRow struct {
	ID        string
	UserID    string
	Type      string
	DesignID  *string
	Payload   map[string]any
	ReadAt    *time.Time
	CreatedAt time.Time
}

func createNotification(ctx context.Context, db DBTX, userID, typ string, designID *string, payload map[string]any) error {
	var raw []byte
	if payload != nil {
		raw, _ = json.Marshal(payload)
	}
	_, err := db.Exec(ctx,
		`INSERT INTO "Notification" (id,"userId",type,"designId",payload) VALUES ($1,$2,$3,$4,$5)`,
		uuid.NewString(), userID, typ, designID, raw)
	return err
}

func scanNotification(row pgx.Row) (NotificationRow, error) {
	var n NotificationRow
	var raw []byte
	err := row.Scan(&n.ID, &n.UserID, &n.Type, &n.DesignID, &raw, &n.ReadAt, &n.CreatedAt)
	if err == nil && len(raw) > 0 {
		_ = json.Unmarshal(raw, &n.Payload)
	}
	return n, err
}

const notificationCols = `id,"userId",type,"designId",payload,"readAt","createdAt"`

func (s *Service) listNotifications(ctx context.Context, userID string, unreadOnly bool, before *time.Time, limit int) ([]NotificationRow, error) {
	const q = `SELECT ` + notificationCols + ` FROM "Notification"
		WHERE "userId" = $1
		  AND ($2::boolean IS NOT TRUE OR "readAt" IS NULL)
		  AND ($3::timestamptz IS NULL OR "createdAt" < $3)
		ORDER BY "createdAt" DESC LIMIT $4`
	rows, err := s.db.Query(ctx, q, userID, unreadOnly, before, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []NotificationRow
	for rows.Next() {
		n, err := scanNotification(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

func (s *Service) getNotification(ctx context.Context, id string) (NotificationRow, error) {
	n, err := scanNotification(s.db.QueryRow(ctx, `SELECT `+notificationCols+` FROM "Notification" WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return NotificationRow{}, ErrNotFound
	}
	return n, err
}

func (s *Service) markRead(ctx context.Context, id string, at time.Time) error {
	_, err := s.db.Exec(ctx, `UPDATE "Notification" SET "readAt" = $2 WHERE id = $1 AND "readAt" IS NULL`, id, at)
	return err
}

func (s *Service) markAllRead(ctx context.Context, userID string, at time.Time) error {
	_, err := s.db.Exec(ctx, `UPDATE "Notification" SET "readAt" = $2 WHERE "userId" = $1 AND "readAt" IS NULL`, userID, at)
	return err
}

func (s *Service) unreadCount(ctx context.Context, userID string) (int, error) {
	var n int
	err := s.db.QueryRow(ctx, `SELECT count(*) FROM "Notification" WHERE "userId" = $1 AND "readAt" IS NULL`, userID).Scan(&n)
	return n, err
}

// --- notification prefs --------------------------------------------------

// getTypes returns the stored emailTypes/pushTypes for a user, or nil when the
// user has no NotificationPref row (defaults then apply).
func getTypes(ctx context.Context, db DBTX, userID, column string) ([]string, error) {
	var types []string
	// column is a fixed identifier chosen by the caller (never user input).
	q := `SELECT "` + column + `" FROM "NotificationPref" WHERE "userId" = $1`
	err := db.QueryRow(ctx, q, userID).Scan(&types)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return types, nil
}

func setTypes(ctx context.Context, db DBTX, userID, column string, types []string) error {
	q := `INSERT INTO "NotificationPref" ("userId","` + column + `","updatedAt")
		VALUES ($1,$2,now())
		ON CONFLICT ("userId") DO UPDATE SET "` + column + `" = EXCLUDED."` + column + `", "updatedAt" = now()`
	_, err := db.Exec(ctx, q, userID, types)
	return err
}

// --- view sessions -------------------------------------------------------

type DesignViewRow struct {
	ID         string
	DesignID   string
	ViewerID   *string
	AnonID     *string
	SessionID  string
	OpenedAt   time.Time
	LastSeenAt time.Time
	DurationMs int
	PageID     *string
	PerPage    map[string]int
}

// recordViewBeat upserts a heartbeat keyed by (designId, sessionId): creates the
// row on the first beat, then adds deltaMs to the duration and the current page.
func (s *Service) recordViewBeat(ctx context.Context, in ViewBeatInput) error {
	if in.DeltaMs < 0 {
		in.DeltaMs = 0
	}
	// Build the initial per-page map for an insert and the increment for the
	// update in Go, then upsert. The jsonb is merged additively per page.
	initPerPage := map[string]int{}
	if in.PageID != nil && in.DeltaMs > 0 {
		initPerPage[*in.PageID] = in.DeltaMs
	}
	initRaw, _ := json.Marshal(initPerPage)

	// On conflict, accumulate duration + per-page. jsonb_set with COALESCE adds
	// deltaMs to the current page's accumulated ms (defaulting missing to 0).
	const q = `INSERT INTO "DesignView" (id,"designId","viewerId","anonId","sessionId","openedAt","lastSeenAt","durationMs","pageId","perPage")
		VALUES ($1,$2,$3,$4,$5,now(),now(),$6,$7,$8)
		ON CONFLICT ("designId","sessionId") DO UPDATE SET
			"lastSeenAt" = now(),
			"durationMs" = "DesignView"."durationMs" + $6,
			"pageId" = COALESCE($7, "DesignView"."pageId"),
			"perPage" = CASE
				WHEN $7 IS NULL OR $6 = 0 THEN "DesignView"."perPage"
				ELSE jsonb_set(
					COALESCE("DesignView"."perPage", '{}'::jsonb),
					ARRAY[$7::text],
					to_jsonb(COALESCE(("DesignView"."perPage"->>$7)::int, 0) + $6)
				)
			END`
	_, err := s.db.Exec(ctx, q,
		uuid.NewString(), in.DesignID, in.ViewerID, in.AnonID, in.SessionID,
		in.DeltaMs, in.PageID, initRaw)
	return err
}

func (s *Service) listViews(ctx context.Context, designID string) ([]DesignViewRow, error) {
	const q = `SELECT id,"designId","viewerId","anonId","sessionId","openedAt","lastSeenAt","durationMs","pageId","perPage"
		FROM "DesignView" WHERE "designId" = $1`
	rows, err := s.db.Query(ctx, q, designID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DesignViewRow
	for rows.Next() {
		var v DesignViewRow
		var raw []byte
		if err := rows.Scan(&v.ID, &v.DesignID, &v.ViewerID, &v.AnonID, &v.SessionID, &v.OpenedAt, &v.LastSeenAt, &v.DurationMs, &v.PageID, &raw); err != nil {
			return nil, err
		}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &v.PerPage)
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// ViewBeatInput carries a single heartbeat (FR-14).
type ViewBeatInput struct {
	DesignID  string
	ViewerID  *string
	AnonID    *string
	SessionID string
	PageID    *string
	DeltaMs   int
}
