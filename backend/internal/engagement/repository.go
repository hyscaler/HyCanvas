// SQL access for the engagement module, against the tables
// "activity_events", "notifications", "notification_prefs", and "design_views" (quoted
// identifiers, snake_case columns). payload/perPage are JSONB; type strings are
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
		`INSERT INTO "activity_events" (id,"design_id","actor_id",type,payload) VALUES ($1,$2,$3,$4,$5)`,
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
	const q = `SELECT id,"design_id","actor_id",type,payload,"created_at" FROM "activity_events"
		WHERE "design_id" = $1
		  AND ($2::text IS NULL OR type = $2)
		  AND ($3::timestamptz IS NULL OR "created_at" < $3)
		ORDER BY "created_at" DESC LIMIT $4`
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
		`INSERT INTO "notifications" (id,"user_id",type,"design_id",payload) VALUES ($1,$2,$3,$4,$5)`,
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

const notificationCols = `id,"user_id",type,"design_id",payload,"read_at","created_at"`

func (s *Service) listNotifications(ctx context.Context, userID string, unreadOnly bool, before *time.Time, limit int) ([]NotificationRow, error) {
	const q = `SELECT ` + notificationCols + ` FROM "notifications"
		WHERE "user_id" = $1
		  AND ($2::boolean IS NOT TRUE OR "read_at" IS NULL)
		  AND ($3::timestamptz IS NULL OR "created_at" < $3)
		ORDER BY "created_at" DESC LIMIT $4`
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
	n, err := scanNotification(s.db.QueryRow(ctx, `SELECT `+notificationCols+` FROM "notifications" WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return NotificationRow{}, ErrNotFound
	}
	return n, err
}

func (s *Service) markRead(ctx context.Context, id string, at time.Time) error {
	_, err := s.db.Exec(ctx, `UPDATE "notifications" SET "read_at" = $2 WHERE id = $1 AND "read_at" IS NULL`, id, at)
	return err
}

func (s *Service) markAllRead(ctx context.Context, userID string, at time.Time) error {
	_, err := s.db.Exec(ctx, `UPDATE "notifications" SET "read_at" = $2 WHERE "user_id" = $1 AND "read_at" IS NULL`, userID, at)
	return err
}

func (s *Service) unreadCount(ctx context.Context, userID string) (int, error) {
	var n int
	err := s.db.QueryRow(ctx, `SELECT count(*) FROM "notifications" WHERE "user_id" = $1 AND "read_at" IS NULL`, userID).Scan(&n)
	return n, err
}

// --- notification prefs --------------------------------------------------

// getTypes returns the stored emailTypes/pushTypes for a user, or nil when the
// user has no NotificationPref row (defaults then apply).
func getTypes(ctx context.Context, db DBTX, userID, column string) ([]string, error) {
	var types []string
	// column is a fixed identifier chosen by the caller (never user input).
	q := `SELECT "` + column + `" FROM "notification_prefs" WHERE "user_id" = $1`
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
	q := `INSERT INTO "notification_prefs" ("user_id","` + column + `","updated_at")
		VALUES ($1,$2,now())
		ON CONFLICT ("user_id") DO UPDATE SET "` + column + `" = EXCLUDED."` + column + `", "updated_at" = now()`
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
	const q = `INSERT INTO "design_views" (id,"design_id","viewer_id","anon_id","session_id","opened_at","last_seen_at","duration_ms","page_id","per_page")
		VALUES ($1,$2,$3,$4,$5,now(),now(),$6,$7,$8)
		ON CONFLICT ("design_id","session_id") DO UPDATE SET
			"last_seen_at" = now(),
			"duration_ms" = "design_views"."duration_ms" + $6,
			"page_id" = COALESCE($7, "design_views"."page_id"),
			"per_page" = CASE
				WHEN $7 IS NULL OR $6 = 0 THEN "design_views"."per_page"
				ELSE jsonb_set(
					COALESCE("design_views"."per_page", '{}'::jsonb),
					ARRAY[$7::text],
					to_jsonb(COALESCE(("design_views"."per_page"->>$7)::int, 0) + $6)
				)
			END`
	_, err := s.db.Exec(ctx, q,
		uuid.NewString(), in.DesignID, in.ViewerID, in.AnonID, in.SessionID,
		in.DeltaMs, in.PageID, initRaw)
	return err
}

func (s *Service) listViews(ctx context.Context, designID string) ([]DesignViewRow, error) {
	const q = `SELECT id,"design_id","viewer_id","anon_id","session_id","opened_at","last_seen_at","duration_ms","page_id","per_page"
		FROM "design_views" WHERE "design_id" = $1`
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
