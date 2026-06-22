// MFA: TOTP enrollment + login challenge + recovery codes (doc 15 FR-5). The
// TOTP secret is encrypted at rest (AES-256-GCM via internal/auth/secrets,
// packed as "cipher.iv.tag" in the User.mfaSecret column); recovery codes are
// stored hashed and consumed once. The login challenge is a short-lived JWT with
// aud "mfa" that VerifyMfaLogin redeems for a session. WebAuthn/passkeys and the
// external OIDC IdP dance are deferred.
package accounts

import (
	"context"
	"crypto/rand"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/auth/jwt"
	"hycanvas/backend/internal/auth/secrets"
	"hycanvas/backend/internal/auth/totp"
)

const (
	mfaAudience     = "mfa"
	mfaIssuer       = "HyCanvas"
	mfaChallengeTTL = 5 * time.Minute
)

// ErrMFA covers MFA enrollment/verification failures (mapped to 400/401).
var (
	ErrMFAAlready   = errors.New("mfa already enabled")
	ErrMFANotSetup  = errors.New("start mfa enrollment first")
	ErrMFAInvalid   = errors.New("invalid authentication code")
	ErrMFAChallenge = errors.New("invalid or expired mfa challenge")
)

// packSecret encrypts a TOTP secret to the "cipher.iv.tag" column form.
func (s *Service) packSecret(plain string) (string, error) {
	nonce := make([]byte, 12)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	enc, err := secrets.EncryptAISecret(plain, s.aiSecret, nonce)
	if err != nil {
		return "", err
	}
	return enc.Cipher + "." + enc.IV + "." + enc.Tag, nil
}

// unpackSecret reverses packSecret; returns "" if malformed/undecryptable.
func (s *Service) unpackSecret(stored string) string {
	parts := strings.Split(stored, ".")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return ""
	}
	plain, err := secrets.DecryptAISecret(secrets.Encrypted{Cipher: parts[0], IV: parts[1], Tag: parts[2]}, s.aiSecret)
	if err != nil {
		return ""
	}
	return plain
}

// mfaUser loads a user's mfa state.
type mfaUser struct {
	ID         string
	Email      string
	MFAEnabled bool
	MFASecret  *string
}

func (s *Service) getMfaUser(ctx context.Context, userID string) (mfaUser, error) {
	const q = `SELECT id, email, "mfaEnabled", "mfaSecret" FROM "User" WHERE id = $1`
	var u mfaUser
	if err := s.db.QueryRow(ctx, q, userID).Scan(&u.ID, &u.Email, &u.MFAEnabled, &u.MFASecret); err != nil {
		return mfaUser{}, ErrInvalidCredentials
	}
	return u, nil
}

// BeginMfaEnrollment mints a provisional secret and returns the otpauth URL.
func (s *Service) BeginMfaEnrollment(ctx context.Context, userID string) (otpauthURL, secret string, err error) {
	u, err := s.getMfaUser(ctx, userID)
	if err != nil {
		return "", "", err
	}
	if u.MFAEnabled {
		return "", "", ErrMFAAlready
	}
	secret, err = totp.GenerateSecret()
	if err != nil {
		return "", "", err
	}
	packed, err := s.packSecret(secret)
	if err != nil {
		return "", "", err
	}
	if _, err := s.db.Exec(ctx, `UPDATE "User" SET "mfaSecret" = $2, "updatedAt" = now() WHERE id = $1`, userID, packed); err != nil {
		return "", "", err
	}
	return totp.OtpauthURL(secret, u.Email, mfaIssuer), secret, nil
}

// ConfirmMfaEnrollment verifies a code against the provisional secret, enables
// MFA, and returns a fresh set of recovery codes (shown once).
func (s *Service) ConfirmMfaEnrollment(ctx context.Context, userID, code string) ([]string, error) {
	u, err := s.getMfaUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	if u.MFAEnabled {
		return nil, ErrMFAAlready
	}
	if u.MFASecret == nil {
		return nil, ErrMFANotSetup
	}
	secret := s.unpackSecret(*u.MFASecret)
	if secret == "" || !totp.Verify(secret, code, 1, time.Now().UnixMilli()) {
		return nil, ErrMFAInvalid
	}
	if _, err := s.db.Exec(ctx, `UPDATE "User" SET "mfaEnabled" = true, "updatedAt" = now() WHERE id = $1`, userID); err != nil {
		return nil, err
	}
	codes, err := totp.GenerateRecoveryCodes(10)
	if err != nil {
		return nil, err
	}
	hashes := make([]string, len(codes))
	for i, c := range codes {
		hashes[i] = secrets.HashToken(totp.NormalizeRecoveryCode(c))
	}
	if err := s.replaceRecoveryCodes(ctx, userID, hashes); err != nil {
		return nil, err
	}
	return codes, nil
}

// DisableMfa turns MFA off after proving a current TOTP or unused recovery code.
func (s *Service) DisableMfa(ctx context.Context, userID, code string) error {
	u, err := s.getMfaUser(ctx, userID)
	if err != nil {
		return err
	}
	if !u.MFAEnabled {
		return nil // idempotent
	}
	if !s.checkSecondFactor(ctx, u, code) {
		return ErrMFAInvalid
	}
	if _, err := s.db.Exec(ctx, `UPDATE "User" SET "mfaEnabled" = false, "mfaSecret" = NULL, "updatedAt" = now() WHERE id = $1`, userID); err != nil {
		return err
	}
	return s.deleteRecoveryCodes(ctx, userID)
}

// VerifyMfaLogin redeems a challenge token + second factor for a session.
func (s *Service) VerifyMfaLogin(ctx context.Context, mfaToken, code, device, ip string) (*AuthUser, *Tokens, error) {
	claims, err := jwt.Verify(mfaToken, s.jwtSecret)
	if err != nil || claims.Aud != mfaAudience {
		return nil, nil, ErrMFAChallenge
	}
	u, err := s.getMfaUser(ctx, claims.Sub)
	if err != nil || !u.MFAEnabled {
		return nil, nil, ErrMFAChallenge
	}
	if !s.checkSecondFactor(ctx, u, code) {
		return nil, nil, ErrMFAInvalid
	}
	row, err := s.findUserByID(ctx, claims.Sub)
	if err != nil || row == nil {
		return nil, nil, ErrMFAChallenge
	}
	return s.issueSession(ctx, row, device, ip)
}

// VerifyReauth re-authenticates a user for a sensitive action (account delete):
// the current password must match and, when MFA is enabled, a valid TOTP or
// recovery code must be supplied. Returns ErrReauth on any failure.
func (s *Service) VerifyReauth(ctx context.Context, userID, password, code string) error {
	u, err := s.findUserByID(ctx, userID)
	if err != nil || u == nil || u.PasswordHash == nil {
		return ErrReauth
	}
	if !secrets.VerifyPassword(password, *u.PasswordHash) {
		return ErrReauth
	}
	if u.MFAEnabled {
		mu, err := s.getMfaUser(ctx, userID)
		if err != nil || !s.checkSecondFactor(ctx, mu, code) {
			return ErrReauth
		}
	}
	return nil
}

// checkSecondFactor accepts a current TOTP code or an unused recovery code
// (consumed on match).
func (s *Service) checkSecondFactor(ctx context.Context, u mfaUser, code string) bool {
	if u.MFASecret != nil {
		if secret := s.unpackSecret(*u.MFASecret); secret != "" && totp.Verify(secret, code, 1, time.Now().UnixMilli()) {
			return true
		}
	}
	hash := secrets.HashToken(totp.NormalizeRecoveryCode(code))
	id, err := s.findUnconsumedRecoveryCode(ctx, u.ID, hash)
	if err != nil || id == "" {
		return false
	}
	return s.consumeRecoveryCode(ctx, id) == nil
}

// --- recovery-code repository (MfaRecoveryCode table) --------------------

func (s *Service) replaceRecoveryCodes(ctx context.Context, userID string, hashes []string) error {
	if _, err := s.db.Exec(ctx, `DELETE FROM "MfaRecoveryCode" WHERE "userId" = $1`, userID); err != nil {
		return err
	}
	for _, h := range hashes {
		if _, err := s.db.Exec(ctx, `INSERT INTO "MfaRecoveryCode" (id,"userId","codeHash") VALUES ($1,$2,$3)`, uuid.NewString(), userID, h); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) findUnconsumedRecoveryCode(ctx context.Context, userID, hash string) (string, error) {
	var id string
	err := s.db.QueryRow(ctx, `SELECT id FROM "MfaRecoveryCode" WHERE "userId" = $1 AND "codeHash" = $2 AND "consumedAt" IS NULL`, userID, hash).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return id, err
}

func (s *Service) consumeRecoveryCode(ctx context.Context, id string) error {
	_, err := s.db.Exec(ctx, `UPDATE "MfaRecoveryCode" SET "consumedAt" = now() WHERE id = $1`, id)
	return err
}

func (s *Service) deleteRecoveryCodes(ctx context.Context, userID string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM "MfaRecoveryCode" WHERE "userId" = $1`, userID)
	return err
}
