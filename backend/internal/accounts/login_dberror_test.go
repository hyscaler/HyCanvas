package accounts

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// errRow fails every Scan with a fixed error, standing in for a database that is
// unreachable (the query times out rather than answering).
type errRow struct{ err error }

func (r errRow) Scan(...any) error { return r.err }

// errDB is a DBTX whose every read fails, so Login exercises its error path with
// no database present.
type errDB struct{ err error }

func (d errDB) QueryRow(context.Context, string, ...any) pgx.Row { return errRow{d.err} }
func (d errDB) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, d.err
}
func (d errDB) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, d.err
}
func (d errDB) Begin(context.Context) (pgx.Tx, error) { return nil, d.err }

// A database failure during sign-in is not a credential problem. Reporting it as
// ErrInvalidCredentials (a 401) tells the user their password is wrong and hides
// the outage from anything watching 5xx, which is what made a self-hoster chase
// a "wrong password" while their database was unreachable (issue #17).
func TestLogin_DatabaseErrorIsNotInvalidCredentials(t *testing.T) {
	dbErr := context.DeadlineExceeded
	svc := NewService(errDB{err: dbErr}, "test-jwt-secret")

	_, _, _, err := svc.Login(context.Background(), "someone@example.com", "password123", "dev", "127.0.0.1")
	if err == nil {
		t.Fatal("expected an error when the database is unreachable")
	}
	if errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("database failure reported as invalid credentials: %v", err)
	}
	if !errors.Is(err, dbErr) {
		t.Fatalf("underlying database error not surfaced: %v", err)
	}
}

// An unknown account must still be indistinguishable from a wrong password, so
// pgx.ErrNoRows keeps answering ErrInvalidCredentials (no account enumeration).
func TestLogin_UnknownUserStaysInvalidCredentials(t *testing.T) {
	svc := NewService(errDB{err: pgx.ErrNoRows}, "test-jwt-secret")

	_, _, _, err := svc.Login(context.Background(), "nobody@example.com", "password123", "dev", "127.0.0.1")
	if !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("unknown user should be ErrInvalidCredentials, got: %v", err)
	}
}

// Fail only the account-state lookup after a real, correct password check.
type stateErrorDB struct {
	DBTX
	err error
}

func (d stateErrorDB) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if strings.Contains(sql, `SELECT "deactivated_at" IS NOT NULL`) {
		return errRow{d.err}
	}
	return d.DBTX.QueryRow(ctx, sql, args...)
}
func TestLogin_StateLookupErrorAfterCorrectPassword_DB(t *testing.T) {
	tx := deactivateTestTx(t)
	ctx := context.Background()
	email := uuid.NewString() + "@example.com"
	svc := NewService(tx, "test")
	if _, _, _, err := svc.Signup(ctx, email, "a-strong-password", "User"); err != nil {
		t.Fatal(err)
	}
	svc = NewService(stateErrorDB{DBTX: tx, err: context.DeadlineExceeded}, "test")
	if _, _, _, err := svc.Login(ctx, email, "a-strong-password", "", ""); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
}
