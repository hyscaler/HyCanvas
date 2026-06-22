// Package push ports the NestJS web-push channel (doc 17 FR-13): VAPID-signed,
// RFC 8291-encrypted Web Push to a user's subscriptions. Enabled only when both
// VAPID keys are configured (else it is a no-op so notifications still write
// in-app). The encryption/VAPID is delegated to webpush-go (a hand-roll would
// reimplement ECDH/HKDF/AES128GCM). Dead subscriptions (404/410) are pruned.
package push

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ErrNotFound is returned for unknown subscriptions.
var ErrNotFound = errors.New("not found")

// DBTX is the query surface (satisfied by *pgxpool.Pool and pgx.Tx).
type DBTX interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Payload is a web-push notification (rendered by the caller).
type Payload struct {
	Title string         `json:"title"`
	Body  string         `json:"body"`
	URL   string         `json:"url"`
	Data  map[string]any `json:"data,omitempty"`
}

// Service is the web-push channel.
type Service struct {
	db         DBTX
	publicKey  string
	privateKey string
	subject    string
}

// NewService reads the VAPID config from the environment.
func NewService(db DBTX) *Service {
	return &Service{
		db:         db,
		publicKey:  strings.TrimSpace(os.Getenv("VAPID_PUBLIC_KEY")),
		privateKey: strings.TrimSpace(os.Getenv("VAPID_PRIVATE_KEY")),
		subject:    orDefault(os.Getenv("VAPID_SUBJECT"), "mailto:admin@example.com"),
	}
}

// IsEnabled reports whether the channel is configured (both VAPID keys set).
func (s *Service) IsEnabled() bool { return s.publicKey != "" && s.privateKey != "" }

// PublicKey returns the VAPID public key for the client to subscribe with.
func (s *Service) PublicKey() string { return s.publicKey }

// Subscribe records a browser push subscription for a user (idempotent on the
// endpoint).
func (s *Service) Subscribe(ctx context.Context, userID, endpoint, p256dh, auth string) error {
	if endpoint == "" || p256dh == "" || auth == "" {
		return errors.New("incomplete subscription")
	}
	_, err := s.db.Exec(ctx,
		`INSERT INTO "PushSubscription" (id,"userId",endpoint,p256dh,auth) VALUES ($1,$2,$3,$4,$5)
		 ON CONFLICT (endpoint) DO UPDATE SET "userId" = EXCLUDED."userId", p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
		uuid.NewString(), userID, endpoint, p256dh, auth)
	return err
}

// Unsubscribe removes a subscription by endpoint.
func (s *Service) Unsubscribe(ctx context.Context, endpoint string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM "PushSubscription" WHERE endpoint = $1`, endpoint)
	return err
}

type subRow struct {
	endpoint, p256dh, auth string
}

// Send pushes a payload to every subscription of a user, pruning dead ones.
// Returns the count delivered. A no-op (0) when the channel is unconfigured.
func (s *Service) Send(ctx context.Context, userID string, payload Payload) int {
	if !s.IsEnabled() {
		return 0
	}
	rows, err := s.db.Query(ctx, `SELECT endpoint, p256dh, auth FROM "PushSubscription" WHERE "userId" = $1`, userID)
	if err != nil {
		return 0
	}
	var subs []subRow
	for rows.Next() {
		var sr subRow
		if err := rows.Scan(&sr.endpoint, &sr.p256dh, &sr.auth); err == nil {
			subs = append(subs, sr)
		}
	}
	rows.Close()

	body, _ := json.Marshal(payload)
	opts := &webpush.Options{Subscriber: s.subject, VAPIDPublicKey: s.publicKey, VAPIDPrivateKey: s.privateKey, TTL: 60}
	sent := 0
	for _, sr := range subs {
		sub := &webpush.Subscription{Endpoint: sr.endpoint, Keys: webpush.Keys{P256dh: sr.p256dh, Auth: sr.auth}}
		res, err := webpush.SendNotificationWithContext(ctx, body, sub, opts)
		if err != nil {
			continue
		}
		res.Body.Close()
		if res.StatusCode == http.StatusNotFound || res.StatusCode == http.StatusGone {
			_ = s.Unsubscribe(ctx, sr.endpoint) // prune dead subscription
			continue
		}
		if res.StatusCode >= 200 && res.StatusCode < 300 {
			sent++
		}
	}
	return sent
}

func orDefault(v, def string) string {
	if strings.TrimSpace(v) != "" {
		return v
	}
	return def
}
