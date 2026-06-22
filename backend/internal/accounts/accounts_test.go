package accounts

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/auth/secrets"
)

// Integration test against the shared Postgres. Runs inside a transaction that is
// always rolled back, so it inserts a throwaway user without polluting the DB.
// Skipped when DATABASE_URL is not set (e.g. CI without a database).
func TestLoginFlow_DB(t *testing.T) {
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
	defer func() { _ = tx.Rollback(ctx) }() // never commit

	// Seed a throwaway user with a known password.
	email := "go-migration-test+" + uuid.NewString() + "@example.com"
	const password = "correct horse battery staple"
	hash, err := secrets.HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	userID := uuid.NewString()
	if _, err := tx.Exec(ctx,
		`INSERT INTO "User" (id, email, name, "passwordHash", "updatedAt") VALUES ($1,$2,$3,$4, now())`,
		userID, email, "Go Test", hash,
	); err != nil {
		t.Fatalf("seed user: %v", err)
	}

	svc := NewService(tx, "test-jwt-secret")

	// Wrong password rejected.
	if _, _, _, err := svc.Login(ctx, email, "wrong", "dev", "127.0.0.1"); err == nil {
		t.Fatal("login with wrong password must fail")
	}

	// Correct password: user view + tokens.
	user, tokens, _, err := svc.Login(ctx, email, password, "dev-agent", "127.0.0.1")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if user.Email != email || user.ID != userID {
		t.Fatalf("user view mismatch: %+v", user)
	}
	if tokens.Access == "" || tokens.Refresh == "" || tokens.SessionID == "" {
		t.Fatal("expected non-empty tokens")
	}

	// Access token verifies and resolves to the user + session.
	uid, sid, err := svc.VerifyAccess(ctx, tokens.Access)
	if err != nil {
		t.Fatalf("verify access: %v", err)
	}
	if uid != userID || sid != tokens.SessionID {
		t.Fatalf("verify mismatch: uid=%s sid=%s", uid, sid)
	}

	// /me equivalent.
	view, err := svc.GetUserByID(ctx, userID)
	if err != nil || view.Email != email {
		t.Fatalf("GetUserByID: %v view=%+v", err, view)
	}

	// ListSessions shows the active session.
	if list, err := svc.ListSessions(ctx, userID); err != nil || len(list) != 1 || list[0].ID != tokens.SessionID {
		t.Fatalf("ListSessions: err=%v list=%+v", err, list)
	}

	// Refresh rotates the token: a new refresh token is issued and works.
	rotated, err := svc.Refresh(ctx, tokens.Refresh)
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if rotated.Refresh == tokens.Refresh || rotated.SessionID != tokens.SessionID {
		t.Fatalf("refresh should rotate within the same session: %+v", rotated)
	}

	// Reuse detection: presenting the OLD refresh token again (beyond grace would
	// revoke; within grace it tolerates). Here the previous token is still within
	// grace, so it tolerates and rotates again rather than erroring.
	if _, err := svc.Refresh(ctx, rotated.Refresh); err != nil {
		t.Fatalf("second refresh of current token should succeed: %v", err)
	}

	// An entirely unknown refresh token is rejected.
	if _, err := svc.Refresh(ctx, "bogus.token"); err == nil {
		t.Fatal("unknown refresh token must be rejected")
	}

	// Logout revokes the session: the access token is now rejected.
	if err := svc.Logout(ctx, tokens.SessionID); err != nil {
		t.Fatalf("logout: %v", err)
	}
	if _, _, err := svc.VerifyAccess(ctx, tokens.Access); err == nil {
		t.Fatal("access token still valid after logout (revocation must be immediate)")
	}
	// After revocation, refresh is also rejected.
	if _, err := svc.Refresh(ctx, rotated.Refresh); err == nil {
		t.Fatal("refresh after logout must be rejected")
	}
}

// TestRefreshReuseRevokesFamily verifies that presenting a rotated-away token
// beyond the grace window revokes the session (reuse detection). It manipulates
// rotatedAt directly to simulate elapsed time.
func TestRefreshReuseRevokesFamily(t *testing.T) {
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

	email := "go-reuse-test+" + uuid.NewString() + "@example.com"
	hash, _ := secrets.HashPassword("pw")
	userID := uuid.NewString()
	if _, err := tx.Exec(ctx,
		`INSERT INTO "User" (id, email, name, "passwordHash", "updatedAt") VALUES ($1,$2,$3,$4, now())`,
		userID, email, "Reuse Test", hash); err != nil {
		t.Fatalf("seed: %v", err)
	}
	svc := NewService(tx, "test-jwt-secret")
	_, tokens, _, err := svc.Login(ctx, email, "pw", "d", "ip")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	oldRefresh := tokens.Refresh
	if _, err := svc.Refresh(ctx, oldRefresh); err != nil {
		t.Fatalf("first rotate: %v", err)
	}
	// Push rotatedAt into the past so the old (previous) token is beyond grace.
	if _, err := tx.Exec(ctx, `UPDATE "Session" SET "rotatedAt" = now() - interval '1 minute' WHERE id = $1`, tokens.SessionID); err != nil {
		t.Fatalf("age session: %v", err)
	}
	if _, err := svc.Refresh(ctx, oldRefresh); err == nil {
		t.Fatal("reusing the rotated-away token beyond grace must be rejected")
	}
	// Family revoked: the session is no longer active.
	if svc.isSessionActive(ctx, tokens.SessionID) {
		t.Fatal("session should be revoked after reuse detection")
	}
}

// TestSignupFlow_DB verifies signup provisions a user + personal workspace +
// owner membership + session atomically, that login then works, and that a
// duplicate email is rejected.
func TestSignupFlow_DB(t *testing.T) {
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

	svc := NewService(tx, "test-jwt-secret")
	email := "go-signup-test+" + uuid.NewString() + "@example.com"
	const pw = "a-strong-password"

	user, ws, tokens, err := svc.Signup(ctx, email, pw, "Casey Example")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	if user.Email != email || user.Name != "Casey Example" {
		t.Fatalf("user view mismatch: %+v", user)
	}
	if ws == nil || ws.OwnerID != user.ID || ws.Name != "Casey Example Workspace" {
		t.Fatalf("workspace mismatch: %+v", ws)
	}
	if tokens.Access == "" || tokens.SessionID == "" {
		t.Fatal("expected session tokens from signup")
	}

	// Owner membership exists.
	var role, status string
	if err := tx.QueryRow(ctx,
		`SELECT role, status FROM "WorkspaceMember" WHERE "workspaceId"=$1 AND "userId"=$2`,
		ws.ID, user.ID).Scan(&role, &status); err != nil {
		t.Fatalf("membership lookup: %v", err)
	}
	if role != "OWNER" || status != "ACTIVE" {
		t.Fatalf("expected OWNER/ACTIVE membership, got %s/%s", role, status)
	}

	// The new account can log in.
	if _, _, _, err := svc.Login(ctx, email, pw, "d", "ip"); err != nil {
		t.Fatalf("login after signup: %v", err)
	}

	// Duplicate email is rejected.
	if _, _, _, err := svc.Signup(ctx, email, pw, "Dup"); err != ErrEmailTaken {
		t.Fatalf("expected ErrEmailTaken, got %v", err)
	}

	// Validation: short password / bad email rejected.
	if _, _, _, err := svc.Signup(ctx, "x+"+uuid.NewString()+"@e.com", "short", ""); err != ErrInvalidSignup {
		t.Fatalf("expected ErrInvalidSignup for short password, got %v", err)
	}
}

// stripSchema removes Prisma's ?schema=... query param pgx does not understand.
func stripSchema(dsn string) string {
	if i := indexOf(dsn, "?schema="); i >= 0 {
		return dsn[:i]
	}
	if i := indexOf(dsn, "&schema="); i >= 0 {
		return dsn[:i]
	}
	return dsn
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
