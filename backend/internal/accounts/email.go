// Email-driven auth flows (doc 15 FR-1): email verification, password reset, and
// passwordless magic-link sign-in. Each mints a single-use token, stores ONLY
// its hash, and "emails" the raw token in a link. The request endpoints are
// enumeration-safe (silent for unknown accounts). The email channel is a no-op
// (no SMTP wired); sent links are captured in an in-memory dev outbox so local
// flows are testable.
package accounts

import (
	"context"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"

	"hycanvas/backend/internal/auth/secrets"
)

const (
	verifyTTL = 24 * time.Hour
	resetTTL  = 1 * time.Hour
	magicTTL  = 15 * time.Minute
)

// OutboxMessage is a captured outbound mail (dev-only inspection).
type OutboxMessage struct {
	To      string `json:"to"`
	Subject string `json:"subject"`
	Link    string `json:"link"`
}

func (s *Service) appURL() string {
	for _, k := range []string{"APP_URL", "FRONTEND_URL"} {
		if v := strings.TrimRight(os.Getenv(k), "/"); v != "" {
			return v
		}
	}
	return "http://localhost:3000"
}

func ttlFor(kind string) time.Duration {
	switch kind {
	case "reset":
		return resetTTL
	case "magic":
		return magicTTL
	default:
		return verifyTTL
	}
}

func (s *Service) linkFor(kind, raw string) string {
	path := "/verify-email"
	switch kind {
	case "reset":
		path = "/reset-password"
	case "magic":
		path = "/login"
	}
	return s.appURL() + path + "?token=" + raw
}

func subjectFor(kind string) string {
	switch kind {
	case "reset":
		return "Reset your HyCanvas password"
	case "magic":
		return "Your HyCanvas sign-in link"
	default:
		return "Verify your HyCanvas email"
	}
}

// sendVerificationToken mints + stores a single-use token (hash only) and
// captures the link in the dev outbox. Returns the raw token (for tests).
func (s *Service) sendVerificationToken(ctx context.Context, userID, email, kind string) (string, error) {
	raw := uuid.NewString() + "." + uuid.NewString()
	if _, err := s.db.Exec(ctx,
		`INSERT INTO "VerificationToken" (id, "userId", kind, "tokenHash", "expiresAt") VALUES ($1,$2,$3,$4,$5)`,
		uuid.NewString(), userID, kind, secrets.HashToken(raw), time.Now().Add(ttlFor(kind))); err != nil {
		return "", err
	}
	s.deliver(OutboxMessage{To: email, Subject: subjectFor(kind), Link: s.linkFor(kind, raw)})
	return raw, nil
}

// usableToken resolves a raw token to its row id + user id if it exists, is the
// right kind, unconsumed, and unexpired.
func (s *Service) usableToken(ctx context.Context, raw, kind string) (tokenID, userID string, ok bool) {
	if raw == "" {
		return "", "", false
	}
	var consumedAt *time.Time
	var expiresAt time.Time
	err := s.db.QueryRow(ctx,
		`SELECT id, "userId", "consumedAt", "expiresAt" FROM "VerificationToken" WHERE "tokenHash" = $1 AND kind = $2`,
		secrets.HashToken(raw), kind).Scan(&tokenID, &userID, &consumedAt, &expiresAt)
	if err != nil || consumedAt != nil || !time.Now().Before(expiresAt) {
		return "", "", false
	}
	return tokenID, userID, true
}

func (s *Service) consumeToken(ctx context.Context, id string) error {
	_, err := s.db.Exec(ctx, `UPDATE "VerificationToken" SET "consumedAt" = now() WHERE id = $1`, id)
	return err
}

// RequestEmailVerification re-sends a verification link; silent for unknown or
// already-verified accounts.
func (s *Service) RequestEmailVerification(ctx context.Context, email string) error {
	u, err := s.findUserByEmail(ctx, strings.ToLower(strings.TrimSpace(email)))
	if err != nil || u == nil || u.EmailVerified {
		return nil
	}
	_, err = s.sendVerificationToken(ctx, u.ID, u.Email, "email")
	return err
}

// VerifyEmail consumes an email token and marks the user verified.
func (s *Service) VerifyEmail(ctx context.Context, raw string) (*AuthUser, error) {
	id, userID, ok := s.usableToken(ctx, raw, "email")
	if !ok {
		return nil, ErrToken
	}
	if err := s.consumeToken(ctx, id); err != nil {
		return nil, err
	}
	if _, err := s.db.Exec(ctx, `UPDATE "User" SET "emailVerified" = true, "updatedAt" = now() WHERE id = $1`, userID); err != nil {
		return nil, err
	}
	return s.GetUserByID(ctx, userID)
}

// RequestPasswordReset sends a reset link; silent for unknown accounts.
func (s *Service) RequestPasswordReset(ctx context.Context, email string) error {
	u, err := s.findUserByEmail(ctx, strings.ToLower(strings.TrimSpace(email)))
	if err != nil || u == nil {
		return nil
	}
	_, err = s.sendVerificationToken(ctx, u.ID, u.Email, "reset")
	return err
}

// ResetPassword sets a new password from a single-use token and revokes all
// existing sessions so a leaked session cannot ride along after a reset.
func (s *Service) ResetPassword(ctx context.Context, raw, newPassword string) error {
	if len(newPassword) < 8 {
		return ErrInvalidSignup
	}
	id, userID, ok := s.usableToken(ctx, raw, "reset")
	if !ok {
		return ErrToken
	}
	hash, err := secrets.HashPassword(newPassword)
	if err != nil {
		return err
	}
	if err := s.consumeToken(ctx, id); err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, `UPDATE "User" SET "passwordHash" = $1, "updatedAt" = now() WHERE id = $2`, hash, userID); err != nil {
		return err
	}
	_, err = s.db.Exec(ctx, `DELETE FROM "Session" WHERE "userId" = $1`, userID)
	return err
}

// RequestMagicLink sends a passwordless sign-in link; silent for unknown accounts.
func (s *Service) RequestMagicLink(ctx context.Context, email string) error {
	u, err := s.findUserByEmail(ctx, strings.ToLower(strings.TrimSpace(email)))
	if err != nil || u == nil {
		return nil
	}
	_, err = s.sendVerificationToken(ctx, u.ID, u.Email, "magic")
	return err
}

// LoginWithMagicLink consumes a magic token, marks the email verified (clicking
// the link proves inbox control), and issues a normal session.
func (s *Service) LoginWithMagicLink(ctx context.Context, raw, device, ip string) (*AuthUser, *Tokens, error) {
	id, userID, ok := s.usableToken(ctx, raw, "magic")
	if !ok {
		return nil, nil, ErrToken
	}
	if err := s.consumeToken(ctx, id); err != nil {
		return nil, nil, err
	}
	if _, err := s.db.Exec(ctx, `UPDATE "User" SET "emailVerified" = true, "updatedAt" = now() WHERE id = $1`, userID); err != nil {
		return nil, nil, err
	}
	row, err := s.findUserByID(ctx, userID)
	if err != nil || row == nil {
		return nil, nil, ErrToken
	}
	return s.issueSession(ctx, row, device, ip)
}

// Outbox returns a copy of the captured dev mail (newest last).
func (s *Service) Outbox() []OutboxMessage {
	s.outboxMu.Lock()
	defer s.outboxMu.Unlock()
	out := make([]OutboxMessage, len(s.outbox))
	copy(out, s.outbox)
	return out
}
