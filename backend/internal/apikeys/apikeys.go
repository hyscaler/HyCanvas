// Package apikeys owns workspace-scoped API keys for the public generation
// API (F40 E01/E02). Keys are minted as "hyk_<43 base64url chars>" (256 bits
// of entropy), stored HASH-ONLY (sha256 hex), shown exactly once at mint, and
// revocable. Every key carries scopes ("generate", "read", "export") that the
// HTTP layer enforces per route group; a key never grants more than the
// minting user's own workspace access.
package apikeys

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Prefix marks a bearer token as an API key (vs a session access token).
const Prefix = "hyk_"

// Scopes the HTTP layer understands. Plain strings on purpose (a future scope
// must not break existing rows); these three are what v1 mints and enforces.
const (
	ScopeGenerate = "generate"
	ScopeRead     = "read"
	ScopeExport   = "export"
)

var validScopes = map[string]bool{ScopeGenerate: true, ScopeRead: true, ScopeExport: true}

var (
	ErrNotFound   = errors.New("api key not found")
	ErrRevoked    = errors.New("api key revoked")
	ErrBadRequest = errors.New("bad request")
)

// DBTX is the query surface this service needs (pool or tx).
type DBTX interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

type Service struct {
	db DBTX
	// last_used_at writes are throttled per key id so a busy key does not
	// turn every request into an UPDATE.
	mu       sync.Mutex
	lastUsed map[string]time.Time
}

func NewService(db DBTX) *Service {
	return &Service{db: db, lastUsed: map[string]time.Time{}}
}

// KeyView is the API/UI view of a key: never the hash, never the raw key.
type KeyView struct {
	ID          string   `json:"id"`
	WorkspaceID string   `json:"workspaceId"`
	UserID      string   `json:"userId"`
	Label       string   `json:"label"`
	Prefix      string   `json:"prefix"`
	Scopes      []string `json:"scopes"`
	LastUsedAt  *string  `json:"lastUsedAt"`
	CreatedAt   string   `json:"createdAt"`
	Revoked     bool     `json:"revoked"`
}

// KeyInfo is what the auth middleware needs to authenticate a request.
type KeyInfo struct {
	ID          string
	WorkspaceID string
	UserID      string
	Scopes      []string
}

// HasScope reports whether the key carries the scope.
func (k *KeyInfo) HasScope(scope string) bool {
	for _, s := range k.Scopes {
		if s == scope {
			return true
		}
	}
	return false
}

func hashKey(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// Mint creates a key for (workspace, user) and returns the RAW key exactly
// once alongside the stored view. The caller asserts workspace admin first.
func (s *Service) Mint(ctx context.Context, workspaceID, userID, label string, scopes []string) (string, KeyView, error) {
	label = strings.TrimSpace(label)
	if label == "" {
		return "", KeyView{}, ErrBadRequest
	}
	if r := []rune(label); len(r) > 80 {
		label = string(r[:80])
	}
	clean := make([]string, 0, len(scopes))
	seen := map[string]bool{}
	for _, sc := range scopes {
		sc = strings.TrimSpace(strings.ToLower(sc))
		if !validScopes[sc] {
			return "", KeyView{}, ErrBadRequest
		}
		if !seen[sc] {
			seen[sc] = true
			clean = append(clean, sc)
		}
	}
	if len(clean) == 0 {
		return "", KeyView{}, ErrBadRequest
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", KeyView{}, err
	}
	raw := Prefix + base64.RawURLEncoding.EncodeToString(b)
	prefix := raw[:12] // display handle: "hyk_" + 8 chars, enough to tell keys apart
	const q = `INSERT INTO "api_keys" (id, "workspace_id", "user_id", label, prefix, "key_hash", scopes)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		RETURNING id, "workspace_id", "user_id", label, prefix, scopes, "last_used_at", "created_at", "revoked_at"`
	v, err := scanKey(s.db.QueryRow(ctx, q, uuid.NewString(), workspaceID, userID, label, prefix, hashKey(raw), clean))
	if err != nil {
		return "", KeyView{}, err
	}
	return raw, v, nil
}

// Verify authenticates a raw bearer key: hash lookup, revocation check, and a
// throttled last_used_at touch. The hash lookup is by unique index, so timing
// reveals nothing about other keys.
func (s *Service) Verify(ctx context.Context, raw string) (KeyInfo, error) {
	if !strings.HasPrefix(raw, Prefix) {
		return KeyInfo{}, ErrNotFound
	}
	const q = `SELECT id, "workspace_id", "user_id", scopes, "revoked_at" FROM "api_keys" WHERE "key_hash" = $1`
	var info KeyInfo
	var revokedAt *time.Time
	err := s.db.QueryRow(ctx, q, hashKey(raw)).Scan(&info.ID, &info.WorkspaceID, &info.UserID, &info.Scopes, &revokedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return KeyInfo{}, ErrNotFound
	}
	if err != nil {
		return KeyInfo{}, err
	}
	if revokedAt != nil {
		return KeyInfo{}, ErrRevoked
	}
	s.touchLastUsed(ctx, info.ID)
	return info, nil
}

// touchLastUsed records key usage at most once per minute per key.
func (s *Service) touchLastUsed(ctx context.Context, id string) {
	now := time.Now()
	s.mu.Lock()
	last, ok := s.lastUsed[id]
	if ok && now.Sub(last) < time.Minute {
		s.mu.Unlock()
		return
	}
	s.lastUsed[id] = now
	s.mu.Unlock()
	// Best-effort: a failed touch must never fail the request.
	_, _ = s.db.Exec(ctx, `UPDATE "api_keys" SET "last_used_at" = now() WHERE id = $1`, id)
}

// List returns the workspace's keys, newest first (hashes never leave the DB).
func (s *Service) List(ctx context.Context, workspaceID string) ([]KeyView, error) {
	const q = `SELECT id, "workspace_id", "user_id", label, prefix, scopes, "last_used_at", "created_at", "revoked_at"
		FROM "api_keys" WHERE "workspace_id" = $1 ORDER BY "created_at" DESC`
	rows, err := s.db.Query(ctx, q, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]KeyView, 0, 8)
	for rows.Next() {
		v, err := scanKey(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// Revoke disables a key in place (the row stays for the audit trail). The
// workspace id must match so a key id from another tenant 404s.
func (s *Service) Revoke(ctx context.Context, id, workspaceID string) error {
	tag, err := s.db.Exec(ctx,
		`UPDATE "api_keys" SET "revoked_at" = now() WHERE id = $1 AND "workspace_id" = $2 AND "revoked_at" IS NULL`,
		id, workspaceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func scanKey(row pgx.Row) (KeyView, error) {
	var v KeyView
	var lastUsed, revoked *time.Time
	var created time.Time
	if err := row.Scan(&v.ID, &v.WorkspaceID, &v.UserID, &v.Label, &v.Prefix, &v.Scopes, &lastUsed, &created, &revoked); err != nil {
		return KeyView{}, err
	}
	if lastUsed != nil {
		s := lastUsed.UTC().Format(time.RFC3339Nano)
		v.LastUsedAt = &s
	}
	v.CreatedAt = created.UTC().Format(time.RFC3339Nano)
	v.Revoked = revoked != nil
	return v, nil
}
