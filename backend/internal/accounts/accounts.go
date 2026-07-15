// Package accounts ports the auth/accounts module: user lookup, password login,
// server-tracked sessions with refresh tokens, and access-token verification with
// immediate revocation. It reads/writes the SAME tables the NestJS/Prisma backend
// uses ("users", "sessions") so sessions are interchangeable across the migration.
package accounts

import (
	"context"
	"errors"
	"fmt"
	"time"

	"regexp"
	"strings"
	"sync"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"hycanvas/backend/internal/auth/jwt"
	"hycanvas/backend/internal/auth/secrets"
)

// AccessTTL matches ACCESS_TTL_SECONDS in the NestJS backend (15 minutes).
const AccessTTL = 15 * time.Minute

// refreshGrace matches DEFAULT_GRACE_MS in @hc/authz: a just-rotated token may be
// presented again by a concurrent tab within this window without revoking.
const refreshGrace = 10 * time.Second

var (
	ErrInvalidCredentials = errors.New("invalid email or password")
	ErrMFARequired        = errors.New("mfa required")
	ErrInvalidRefresh     = errors.New("invalid refresh token")
	ErrSessionRevoked     = errors.New("session revoked")
	ErrReuseDetected      = errors.New("refresh token reuse detected; session revoked")
	ErrEmailTaken         = errors.New("an account with this email already exists")
	ErrInvalidSignup      = errors.New("a valid email and an 8+ character password are required")
	ErrInvalidProfile     = errors.New("invalid profile field")
	ErrForbidden          = errors.New("forbidden")
	ErrReauth             = errors.New("re-authentication failed")
	ErrToken              = errors.New("invalid or expired token")
)

// roleRank mirrors @hc/authz ROLE_RANK (higher = more authority). DB roles are
// uppercase (OWNER/ADMIN/MEMBER/VIEWER); compared after lowercasing.
var roleRank = map[string]int{"viewer": 1, "member": 2, "admin": 3, "owner": 4}

// AssertMember enforces that the user is an ACTIVE member of the workspace with
// at least minRole ("viewer"|"member"|"admin"|"owner"). Reusable by every module
// that enforces per-workspace isolation. Returns ErrForbidden otherwise.
func (s *Service) AssertMember(ctx context.Context, userID, workspaceID, minRole string) error {
	const q = `SELECT role FROM "workspace_members"
		WHERE "workspace_id" = $1 AND "user_id" = $2 AND status = 'ACTIVE'`
	var role string
	if err := s.db.QueryRow(ctx, q, workspaceID, userID).Scan(&role); err != nil {
		return ErrForbidden
	}
	if roleRank[strings.ToLower(role)] < roleRank[minRole] {
		return ErrForbidden
	}
	return nil
}

// MemberWorkspaceIDs returns every workspace the user is an ACTIVE member of
// (for cross-workspace template/visibility scoping).
func (s *Service) MemberWorkspaceIDs(ctx context.Context, userID string) ([]string, error) {
	rows, err := s.db.Query(ctx, `SELECT "workspace_id" FROM "workspace_members" WHERE "user_id" = $1 AND status = 'ACTIVE'`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

var emailRe = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)

// WorkspaceView is the personal-workspace summary returned by signup.
type WorkspaceView struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Name    string `json:"name"`
	Slug    string `json:"slug"`
	OwnerID string `json:"ownerId"`
}

// Workspace is the public workspace shape (matches @hc/authz Workspace). Enum
// columns are stored UPPERCASE in Postgres and returned lowercase here.
type Workspace struct {
	ID        string  `json:"id"`
	Kind      string  `json:"kind"`
	Name      string  `json:"name"`
	Slug      string  `json:"slug"`
	AvatarURL *string `json:"avatarUrl,omitempty"`
	OwnerID   string  `json:"ownerId"`
	CreatedAt string  `json:"createdAt"`
}

// WorkspaceWithRole is a workspace plus the caller's role in it (FR-10).
type WorkspaceWithRole struct {
	Workspace
	Role string `json:"role"`
}

// ListWorkspaces returns every workspace the user is an ACTIVE member of, with
// their role, newest first (matches WorkspaceService.listMine, doc 15 FR-10).
func (s *Service) ListWorkspaces(ctx context.Context, userID string) ([]WorkspaceWithRole, error) {
	rows, err := s.db.Query(ctx, `
		SELECT w.id, w.kind, w.name, w.slug, w."avatar_url", w."owner_id", w."created_at", m.role
		FROM "workspace_members" m
		JOIN "workspaces" w ON w.id = m."workspace_id"
		WHERE m."user_id" = $1 AND m.status = 'ACTIVE'
		ORDER BY w."created_at" DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WorkspaceWithRole{}
	for rows.Next() {
		var w WorkspaceWithRole
		var created time.Time
		if err := rows.Scan(&w.ID, &w.Kind, &w.Name, &w.Slug, &w.AvatarURL, &w.OwnerID, &created, &w.Role); err != nil {
			return nil, err
		}
		w.Kind = strings.ToLower(w.Kind)
		w.Role = strings.ToLower(w.Role)
		w.CreatedAt = created.UTC().Format("2006-01-02T15:04:05.000Z07:00")
		out = append(out, w)
	}
	return out, rows.Err()
}

// CreateWorkspace creates a team/org/classroom workspace owned by the caller
// (matches WorkspaceService.create, doc 15 FR-10). Personal workspaces are
// auto-provisioned at signup, never created here.
func (s *Service) CreateWorkspace(ctx context.Context, userID, name, kind string) (*Workspace, error) {
	if name = strings.TrimSpace(name); name == "" {
		return nil, ErrInvalidSignup
	}
	kind = strings.ToLower(strings.TrimSpace(kind))
	if kind == "" {
		kind = "team"
	}
	if kind == "personal" {
		return nil, fmt.Errorf("personal workspaces are auto-provisioned, not created")
	}
	if kind != "team" && kind != "org" && kind != "classroom" {
		return nil, fmt.Errorf("invalid workspace kind %q", kind)
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	wsID := uuid.NewString()
	slug := slugify(name)
	var created time.Time
	if err := tx.QueryRow(ctx,
		`INSERT INTO "workspaces" (id, kind, name, slug, "owner_id", "updated_at")
		 VALUES ($1,$2,$3,$4,$5, now()) RETURNING "created_at"`,
		wsID, strings.ToUpper(kind), name, slug, userID).Scan(&created); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO "workspace_members" (id, "workspace_id", "user_id", role, status, "joined_at", "updated_at")
		 VALUES ($1,$2,$3,'OWNER','ACTIVE', now(), now())`,
		uuid.NewString(), wsID, userID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &Workspace{
		ID: wsID, Kind: kind, Name: name, Slug: slug, OwnerID: userID,
		CreatedAt: created.UTC().Format("2006-01-02T15:04:05.000Z07:00"),
	}, nil
}

// DeleteWorkspace permanently deletes a team/org/classroom workspace. Owner only;
// every workspace-scoped row (members, invitations, designs, assets, brand kits,
// custom roles, AI config) cascades via ON DELETE CASCADE. Personal workspaces
// are auto-provisioned per user and cannot be deleted.
func (s *Service) DeleteWorkspace(ctx context.Context, userID, workspaceID string) error {
	// Owner-gate first (also hides existence from non-members: a missing
	// workspace has no membership row, so this returns ErrForbidden).
	if err := s.AssertMember(ctx, userID, workspaceID, "owner"); err != nil {
		return err
	}
	var kind string
	if err := s.db.QueryRow(ctx, `SELECT kind FROM "workspaces" WHERE id = $1`, workspaceID).Scan(&kind); err != nil {
		return ErrNotFound
	}
	if strings.EqualFold(kind, "PERSONAL") {
		return ErrBadRequest
	}
	if _, err := s.db.Exec(ctx, `DELETE FROM "workspaces" WHERE id = $1`, workspaceID); err != nil {
		return err
	}
	return nil
}

// DBTX is satisfied by *pgxpool.Pool and pgx.Tx, so handlers use the pool and
// tests can run in a rolled-back transaction. Begin yields a (nested, via
// savepoint) transaction for multi-statement operations like signup.
type DBTX interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Begin(ctx context.Context) (pgx.Tx, error)
}

// UserRow is the subset of the User table the auth flow needs.
type UserRow struct {
	ID            string
	Email         string
	EmailVerified bool
	Name          string
	AvatarURL     *string
	PasswordHash  *string
	Locale        string
	Theme         string
	Timezone      string
	TimeFormat    string
	WeekStart     string
	MFAEnabled    bool
	CreatedAt     time.Time
}

// AuthUser is the public-safe user view (matches AuthService.toUser).
type AuthUser struct {
	ID            string         `json:"id"`
	Email         string         `json:"email"`
	EmailVerified bool           `json:"emailVerified"`
	Name          string         `json:"name"`
	AvatarURL     *string        `json:"avatarUrl,omitempty"`
	Locale        string         `json:"locale"`
	Theme         string         `json:"theme"`
	Timezone      string         `json:"timezone"`
	TimeFormat    string         `json:"timeFormat"`
	WeekStart     string         `json:"weekStart"`
	Prefs         map[string]any `json:"prefs"`
	MFAEnabled    bool           `json:"mfaEnabled"`
	CreatedAt     string         `json:"createdAt"`
}

func toUser(u UserRow) AuthUser {
	return AuthUser{
		ID:            u.ID,
		Email:         u.Email,
		EmailVerified: u.EmailVerified,
		Name:          u.Name,
		AvatarURL:     u.AvatarURL,
		Locale:        u.Locale,
		Theme:         u.Theme,
		Timezone:      u.Timezone,
		TimeFormat:    u.TimeFormat,
		WeekStart:     u.WeekStart,
		Prefs:         map[string]any{"accessibility": map[string]any{"reduceMotion": false, "highContrast": false}},
		MFAEnabled:    u.MFAEnabled,
		CreatedAt:     u.CreatedAt.UTC().Format("2006-01-02T15:04:05.000Z07:00"),
	}
}

// Tokens are the credentials produced by a successful login or refresh. An
// empty Refresh (the tolerated concurrent-refresh path) means "keep the
// existing refresh cookie"; the HTTP layer must not overwrite it.
type Tokens struct {
	Access    string
	Refresh   string
	SessionID string
}

// Service holds the data handle and signing secret.
type Service struct {
	db        DBTX
	jwtSecret string
	aiSecret  string // encrypts the MFA TOTP secret at rest (defaults to jwtSecret)
	// In-memory dev mail outbox: when SMTP is unconfigured the email channel falls
	// back to capturing sent verification/reset/magic/invite links here for
	// local/dev testing (exposed via /auth/dev/outbox outside production).
	outboxMu sync.Mutex
	outbox   []OutboxMessage
	// smtp sends real email when configured (env-gated); nil/unconfigured => the
	// dev outbox above is used instead.
	smtp *smtpSender
	// notifier raises in-app notifications (the dashboard bell) for invitees who
	// already have an account; optional, wired post-construction to avoid an
	// accounts<->engagement import cycle.
	notifier Notifier
}

func NewService(db DBTX, jwtSecret string) *Service {
	return &Service{db: db, jwtSecret: jwtSecret, aiSecret: jwtSecret, smtp: smtpFromEnv()}
}

// WithNotifier wires the in-app notifier (the engagement emitter). Nil-safe;
// returns the service. Set once at boot, before serving.
func (s *Service) WithNotifier(n Notifier) *Service {
	s.notifier = n
	return s
}

// WithMFASecret sets the AES key material used to encrypt the TOTP secret at
// rest (AI_SECRET, falling back to JWT_SECRET), matching the Node ai/crypto
// resolution so a secret enrolled on either service decrypts on the other.
func (s *Service) WithMFASecret(secret string) *Service {
	if secret != "" {
		s.aiSecret = secret
	}
	return s
}

// findUserByEmail loads a user by lowercased email.
func (s *Service) findUserByEmail(ctx context.Context, email string) (*UserRow, error) {
	const q = `SELECT id, email, "email_verified", name, "avatar_url", "password_hash", locale, theme, timezone, "time_format", "week_start", "mfa_enabled", "created_at"
		FROM "users" WHERE email = $1`
	var u UserRow
	err := s.db.QueryRow(ctx, q, email).Scan(
		&u.ID, &u.Email, &u.EmailVerified, &u.Name, &u.AvatarURL, &u.PasswordHash,
		&u.Locale, &u.Theme, &u.Timezone, &u.TimeFormat, &u.WeekStart, &u.MFAEnabled, &u.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// findUserByID loads the full user row by id (for issuing a session post-MFA).
func (s *Service) findUserByID(ctx context.Context, id string) (*UserRow, error) {
	const q = `SELECT id, email, "email_verified", name, "avatar_url", "password_hash", locale, theme, timezone, "time_format", "week_start", "mfa_enabled", "created_at"
		FROM "users" WHERE id = $1`
	var u UserRow
	err := s.db.QueryRow(ctx, q, id).Scan(
		&u.ID, &u.Email, &u.EmailVerified, &u.Name, &u.AvatarURL, &u.PasswordHash,
		&u.Locale, &u.Theme, &u.Timezone, &u.TimeFormat, &u.WeekStart, &u.MFAEnabled, &u.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// GetUserByID loads a user view by id (for /me).
func (s *Service) GetUserByID(ctx context.Context, id string) (*AuthUser, error) {
	const q = `SELECT id, email, "email_verified", name, "avatar_url", "password_hash", locale, theme, timezone, "time_format", "week_start", "mfa_enabled", "created_at"
		FROM "users" WHERE id = $1`
	var u UserRow
	if err := s.db.QueryRow(ctx, q, id).Scan(
		&u.ID, &u.Email, &u.EmailVerified, &u.Name, &u.AvatarURL, &u.PasswordHash,
		&u.Locale, &u.Theme, &u.Timezone, &u.TimeFormat, &u.WeekStart, &u.MFAEnabled, &u.CreatedAt,
	); err != nil {
		return nil, err
	}
	v := toUser(u)
	return &v, nil
}

// UpdateProfileInput patches the caller's own profile; nil fields are left
// unchanged. AvatarURL set to "" clears the avatar.
type UpdateProfileInput struct {
	Name      *string
	AvatarURL *string
	Locale    *string
	// Regional preferences. Timezone is an IANA name ("" = auto/browser);
	// TimeFormat is one of auto|12h|24h; WeekStart is one of auto|sunday|monday.
	Timezone   *string
	TimeFormat *string
	WeekStart  *string
}

// validTimezone accepts the empty string ("auto, follow the browser") or any
// IANA zone the embedded tz database recognizes.
func validTimezone(tz string) bool {
	if tz == "" {
		return true
	}
	_, err := time.LoadLocation(tz)
	return err == nil
}

// UpdateProfile updates the caller's display name, avatar, and/or regional
// preferences and returns the refreshed user view. A blank name is rejected, as
// is a timezone/time-format/week-start value outside the allowed set.
func (s *Service) UpdateProfile(ctx context.Context, userID string, in UpdateProfileInput) (*AuthUser, error) {
	var name, locale *string
	if in.Name != nil {
		n := strings.TrimSpace(*in.Name)
		if n == "" {
			return nil, ErrInvalidSignup
		}
		name = &n
	}
	if in.Locale != nil {
		if l := strings.TrimSpace(*in.Locale); l != "" {
			locale = &l
		}
	}
	var timezone, timeFormat, weekStart *string
	if in.Timezone != nil {
		tz := strings.TrimSpace(*in.Timezone)
		if !validTimezone(tz) {
			return nil, ErrInvalidProfile
		}
		timezone = &tz
	}
	if in.TimeFormat != nil {
		tf := strings.TrimSpace(*in.TimeFormat)
		switch tf {
		case "auto", "12h", "24h":
			timeFormat = &tf
		default:
			return nil, ErrInvalidProfile
		}
	}
	if in.WeekStart != nil {
		ws := strings.TrimSpace(*in.WeekStart)
		switch ws {
		case "auto", "sunday", "monday":
			weekStart = &ws
		default:
			return nil, ErrInvalidProfile
		}
	}
	var avatar *string
	avatarSet := in.AvatarURL != nil
	if avatarSet {
		a := strings.TrimSpace(*in.AvatarURL)
		avatar = &a
	}
	const q = `UPDATE "users"
		SET name = COALESCE($2, name),
		    locale = COALESCE($3, locale),
		    "avatar_url" = CASE WHEN $5 THEN NULLIF($4, '') ELSE "avatar_url" END,
		    timezone = COALESCE($6, timezone),
		    "time_format" = COALESCE($7, "time_format"),
		    "week_start" = COALESCE($8, "week_start"),
		    "updated_at" = now()
		WHERE id = $1`
	if _, err := s.db.Exec(ctx, q, userID, name, locale, avatar, avatarSet, timezone, timeFormat, weekStart); err != nil {
		return nil, err
	}
	return s.GetUserByID(ctx, userID)
}

// Login verifies credentials, creates a server-tracked session with a fresh
// refresh token, and returns the user view plus tokens. MFA-enabled accounts are
// rejected here (challenge flow is a later slice).
// Login authenticates by password. When the account has MFA enabled it returns
// ErrMFARequired together with a short-lived challenge token (aud "mfa") the
// client redeems via VerifyMfaLogin; no session is issued in that case.
func (s *Service) Login(ctx context.Context, email, password, device, ip string) (*AuthUser, *Tokens, string, error) {
	u, err := s.findUserByEmail(ctx, email)
	if err != nil || u == nil || u.PasswordHash == nil {
		return nil, nil, "", ErrInvalidCredentials
	}
	if !secrets.VerifyPassword(password, *u.PasswordHash) {
		return nil, nil, "", ErrInvalidCredentials
	}
	if u.MFAEnabled {
		mfaToken, err := s.mfaChallengeToken(u.ID)
		if err != nil {
			return nil, nil, "", err
		}
		return nil, nil, mfaToken, ErrMFARequired
	}

	v, tokens, err := s.issueSession(ctx, u, device, ip)
	if err != nil {
		return nil, nil, "", err
	}
	return v, tokens, "", nil
}

// issueSession creates a session row and signs the access/refresh tokens.
func (s *Service) issueSession(ctx context.Context, u *UserRow, device, ip string) (*AuthUser, *Tokens, error) {
	refresh := uuid.NewString() + "." + uuid.NewString()
	sessionID := uuid.NewString()
	const ins = `INSERT INTO "sessions" (id, "user_id", "current_token_hash", device, ip, "rotated_at", "created_at", "last_seen_at")
		VALUES ($1, $2, $3, $4, $5, now(), now(), now())`
	if _, err := s.db.Exec(ctx, ins, sessionID, u.ID, secrets.HashToken(refresh), nullable(device), nullable(ip)); err != nil {
		return nil, nil, err
	}
	access, err := jwt.Sign(u.ID, sessionID, s.jwtSecret, AccessTTL)
	if err != nil {
		return nil, nil, err
	}
	v := toUser(*u)
	return &v, &Tokens{Access: access, Refresh: refresh, SessionID: sessionID}, nil
}

var nonAlnum = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(name string) string {
	b := nonAlnum.ReplaceAllString(strings.ToLower(name), "-")
	b = strings.Trim(b, "-")
	if len(b) > 32 {
		b = b[:32]
	}
	if b == "" {
		b = "workspace"
	}
	return b + "-" + uuid.NewString()[:6]
}

// Signup creates a user, a password identity, a personal workspace with an owner
// membership, and an initial session - atomically - mirroring AuthService.signup
// (FR-1/FR-2). Email verification dispatch is deferred to a later slice.
func (s *Service) Signup(ctx context.Context, email, password, name string) (*AuthUser, *WorkspaceView, *Tokens, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if !emailRe.MatchString(email) || len(password) < 8 {
		return nil, nil, nil, ErrInvalidSignup
	}
	if name = strings.TrimSpace(name); name == "" {
		name = strings.SplitN(email, "@", 2)[0]
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, nil, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var exists int
	if err := tx.QueryRow(ctx, `SELECT 1 FROM "users" WHERE email = $1`, email).Scan(&exists); err == nil {
		return nil, nil, nil, ErrEmailTaken
	}

	hash, err := secrets.HashPassword(password)
	if err != nil {
		return nil, nil, nil, err
	}
	userID := uuid.NewString()
	if _, err := tx.Exec(ctx,
		`INSERT INTO "users" (id, email, name, "password_hash", "updated_at") VALUES ($1,$2,$3,$4, now())`,
		userID, email, name, hash); err != nil {
		return nil, nil, nil, err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO "auth_identities" (id, "user_id", provider, "provider_subject") VALUES ($1,$2,'PASSWORD',$3)`,
		uuid.NewString(), userID, email); err != nil {
		return nil, nil, nil, err
	}

	wsID := uuid.NewString()
	wsName := name + " Workspace"
	slug := slugify(name)
	if _, err := tx.Exec(ctx,
		`INSERT INTO "workspaces" (id, kind, name, slug, "owner_id", "updated_at") VALUES ($1,'PERSONAL',$2,$3,$4, now())`,
		wsID, wsName, slug, userID); err != nil {
		return nil, nil, nil, err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO "workspace_members" (id, "workspace_id", "user_id", role, status, "joined_at", "updated_at")
		 VALUES ($1,$2,$3,'OWNER','ACTIVE', now(), now())`,
		uuid.NewString(), wsID, userID); err != nil {
		return nil, nil, nil, err
	}

	refresh := uuid.NewString() + "." + uuid.NewString()
	sessionID := uuid.NewString()
	if _, err := tx.Exec(ctx,
		`INSERT INTO "sessions" (id, "user_id", "current_token_hash", "rotated_at", "created_at", "last_seen_at")
		 VALUES ($1,$2,$3, now(), now(), now())`,
		sessionID, userID, secrets.HashToken(refresh)); err != nil {
		return nil, nil, nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, nil, nil, err
	}

	access, err := jwt.Sign(userID, sessionID, s.jwtSecret, AccessTTL)
	if err != nil {
		return nil, nil, nil, err
	}
	user, err := s.GetUserByID(ctx, userID)
	if err != nil {
		return nil, nil, nil, err
	}
	ws := &WorkspaceView{ID: wsID, Kind: "personal", Name: wsName, Slug: slug, OwnerID: userID}
	return user, ws, &Tokens{Access: access, Refresh: refresh, SessionID: sessionID}, nil
}

// VerifyAccess validates an access token: it must verify, carry a session id,
// and that session must be active (not revoked). Returns the user id.
func (s *Service) VerifyAccess(ctx context.Context, token string) (userID, sessionID string, err error) {
	claims, err := jwt.Verify(token, s.jwtSecret)
	if err != nil {
		return "", "", err
	}
	if claims.Sid == "" || claims.Aud != "" {
		return "", "", errors.New("not an access token")
	}
	if !s.isSessionActive(ctx, claims.Sid) {
		return "", "", errors.New("session revoked")
	}
	return claims.Sub, claims.Sid, nil
}

// Refresh rotates a refresh token (reuse of a stale token revokes the family),
// mirroring @hc/authz rotateRefresh. Two rules keep same-browser races from
// killing the session:
//   - Rotation is an atomic compare-and-swap on current_token_hash, so when
//     several requests race with the same cookie exactly one rotates; the
//     losers fall through to the grace path.
//   - The grace ("tolerate") path never mints a second refresh token. The
//     tabs share ONE cookie jar; if both racers rotated, the jar would keep
//     whichever Set-Cookie landed last, a coin flip between the live token
//     and a dead one (the next refresh with the dead one looked like token
//     theft and revoked the whole family). Tolerate therefore returns a fresh
//     access token with Tokens.Refresh empty, meaning "keep the existing
//     cookie", so the jar always converges on the winner's token.
func (s *Service) Refresh(ctx context.Context, refreshToken string) (*Tokens, error) {
	presented := secrets.HashToken(refreshToken)

	const sel = `SELECT id, "user_id", "current_token_hash", "previous_token_hash", "rotated_at", "revoked_at"
		FROM "sessions" WHERE "current_token_hash" = $1 OR "previous_token_hash" = $1`
	var (
		id, userID, currentHash string
		prevHash                *string
		rotatedAt               time.Time
		revokedAt               *time.Time
	)
	if err := s.db.QueryRow(ctx, sel, presented).Scan(&id, &userID, &currentHash, &prevHash, &rotatedAt, &revokedAt); err != nil {
		return nil, ErrInvalidRefresh
	}
	if revokedAt != nil {
		return nil, ErrSessionRevoked
	}

	if presented == currentHash {
		newToken := uuid.NewString() + "." + uuid.NewString()
		// CAS rotation: wins only while current_token_hash is still the presented
		// token. A concurrent refresh that rotated first makes this a no-op; the
		// re-read below then sees the presented token as "previous" and takes the
		// tolerate path like any other same-cookie race.
		const rot = `UPDATE "sessions"
			SET "current_token_hash" = $1, "previous_token_hash" = $2, "rotated_at" = now(), "last_seen_at" = now()
			WHERE id = $3 AND "current_token_hash" = $2 AND "revoked_at" IS NULL`
		tag, err := s.db.Exec(ctx, rot, secrets.HashToken(newToken), presented, id)
		if err != nil {
			return nil, err
		}
		if tag.RowsAffected() == 1 {
			access, err := jwt.Sign(userID, id, s.jwtSecret, AccessTTL)
			if err != nil {
				return nil, err
			}
			return &Tokens{Access: access, Refresh: newToken, SessionID: id}, nil
		}
		if err := s.db.QueryRow(ctx, sel, presented).Scan(&id, &userID, &currentHash, &prevHash, &rotatedAt, &revokedAt); err != nil {
			return nil, ErrInvalidRefresh
		}
		if revokedAt != nil {
			return nil, ErrSessionRevoked
		}
	}

	// From here the presented token is a rotated-away one. Within grace that is
	// a concurrent-tab race (tolerate); beyond it, a replay of a leaked token.
	if prevHash == nil || presented != *prevHash || time.Since(rotatedAt) > refreshGrace {
		if _, e := s.db.Exec(ctx, `UPDATE "sessions" SET "revoked_at" = now() WHERE id = $1`, id); e != nil {
			return nil, e
		}
		return nil, ErrReuseDetected
	}
	_, _ = s.db.Exec(ctx, `UPDATE "sessions" SET "last_seen_at" = now() WHERE id = $1`, id)
	access, err := jwt.Sign(userID, id, s.jwtSecret, AccessTTL)
	if err != nil {
		return nil, err
	}
	return &Tokens{Access: access, Refresh: "", SessionID: id}, nil
}

func (s *Service) isSessionActive(ctx context.Context, sid string) bool {
	const q = `SELECT 1 FROM "sessions" WHERE id = $1 AND "revoked_at" IS NULL`
	var one int
	if err := s.db.QueryRow(ctx, q, sid).Scan(&one); err != nil {
		return false
	}
	return true
}

// SessionView is one entry in the user's active-session list.
type SessionView struct {
	ID         string  `json:"id"`
	Device     *string `json:"device"`
	IP         *string `json:"ip"`
	CreatedAt  string  `json:"createdAt"`
	LastSeenAt string  `json:"lastSeenAt"`
}

// ListSessions returns the user's active (non-revoked) sessions, newest first.
func (s *Service) ListSessions(ctx context.Context, userID string) ([]SessionView, error) {
	const q = `SELECT id, device, ip, "created_at", "last_seen_at" FROM "sessions"
		WHERE "user_id" = $1 AND "revoked_at" IS NULL ORDER BY "last_seen_at" DESC`
	rows, err := s.db.Query(ctx, q, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SessionView{}
	for rows.Next() {
		var v SessionView
		var created, seen time.Time
		if err := rows.Scan(&v.ID, &v.Device, &v.IP, &created, &seen); err != nil {
			return nil, err
		}
		v.CreatedAt = created.UTC().Format("2006-01-02T15:04:05.000Z07:00")
		v.LastSeenAt = seen.UTC().Format("2006-01-02T15:04:05.000Z07:00")
		out = append(out, v)
	}
	return out, rows.Err()
}

// Logout revokes a session (immediate, mirrors AuthService.logout).
func (s *Service) Logout(ctx context.Context, sessionID string) error {
	if sessionID == "" {
		return nil
	}
	const q = `UPDATE "sessions" SET "revoked_at" = now() WHERE id = $1 AND "revoked_at" IS NULL`
	_, err := s.db.Exec(ctx, q, sessionID)
	return err
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
