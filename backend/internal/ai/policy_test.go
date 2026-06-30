package ai

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// fakeRow / fakeDB implement the DBTX surface so policy enforcement + metering
// can be tested without a live Postgres.
type fakeRow struct {
	vals []any
	err  error
}

func (r fakeRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	for i, d := range dest {
		switch p := d.(type) {
		case *int:
			*p = r.vals[i].(int)
		case *[]string:
			*p = r.vals[i].([]string)
		case *string:
			*p = r.vals[i].(string)
		}
	}
	return nil
}

type fakeDB struct {
	policy    *OrgPolicy
	usage     int
	usageRows bool
	execSQL   []string
	execArgs  [][]any
}

func (f *fakeDB) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	if strings.Contains(sql, `"ai_policies"`) {
		if f.policy == nil {
			return fakeRow{err: pgx.ErrNoRows}
		}
		return fakeRow{vals: []any{f.policy.AllowedProviders, f.policy.BlockedProviders, f.policy.MonthlyTokenCap}}
	}
	if strings.Contains(sql, `"ai_usages"`) {
		if !f.usageRows {
			return fakeRow{err: pgx.ErrNoRows}
		}
		return fakeRow{vals: []any{f.usage}}
	}
	return fakeRow{err: pgx.ErrNoRows}
}

func (f *fakeDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	f.execSQL = append(f.execSQL, sql)
	f.execArgs = append(f.execArgs, args)
	return pgconn.CommandTag{}, nil
}

func TestEstimateTokens(t *testing.T) {
	if got := countTokens("abcd"); got != 1 {
		t.Fatalf("countTokens(4 chars) = %d, want 1", got)
	}
	if got := estimateTokens("abcd", 100); got != 101 {
		t.Fatalf("estimateTokens = %d, want 101", got)
	}
	if got := estimateTokens("", 0); got != 256 {
		t.Fatalf("estimateTokens default output = %d, want 256", got)
	}
}

func TestEnforceNoPolicyAllows(t *testing.T) {
	s := &Service{db: &fakeDB{}}
	if err := s.enforce(context.Background(), "ws", "openai", 5000); err != nil {
		t.Fatalf("no policy should allow, got %v", err)
	}
}

func TestEnforceBlockedProvider(t *testing.T) {
	db := &fakeDB{policy: &OrgPolicy{BlockedProviders: []string{"openai"}}}
	s := &Service{db: db}
	err := s.enforce(context.Background(), "ws", "openai", 10)
	if !errors.Is(err, ErrPolicyBlocked) {
		t.Fatalf("blocked provider should error with ErrPolicyBlocked, got %v", err)
	}
}

func TestEnforceMonthlyCap(t *testing.T) {
	db := &fakeDB{policy: &OrgPolicy{MonthlyTokenCap: 1000}, usage: 950, usageRows: true}
	s := &Service{db: db}
	if err := s.enforce(context.Background(), "ws", "openai", 100); !errors.Is(err, ErrPolicyBlocked) {
		t.Fatalf("over-cap call should be blocked, got %v", err)
	}
	if err := s.enforce(context.Background(), "ws", "openai", 40); err != nil {
		t.Fatalf("within-cap call should pass, got %v", err)
	}
}

func TestRecordUsageUpserts(t *testing.T) {
	db := &fakeDB{}
	s := &Service{db: db}
	s.meter(context.Background(), "ws", 123)
	if len(db.execSQL) != 1 || !strings.Contains(db.execSQL[0], `"ai_usages"`) {
		t.Fatalf("meter should INSERT into AiUsage, got %v", db.execSQL)
	}
	// args: workspaceID, period, tokens
	args := db.execArgs[0]
	if args[0] != "ws" || args[2] != 123 {
		t.Fatalf("unexpected usage args: %v", args)
	}
	// meter(0) is a no-op.
	s.meter(context.Background(), "ws", 0)
	if len(db.execSQL) != 1 {
		t.Fatalf("meter(0) should not write")
	}
}

func TestSetPolicyUpsert(t *testing.T) {
	db := &fakeDB{}
	s := &Service{db: db}
	if err := s.SetPolicy(context.Background(), "ws", OrgPolicy{AllowedProviders: []string{"openai"}, MonthlyTokenCap: 5000}); err != nil {
		t.Fatalf("SetPolicy: %v", err)
	}
	if len(db.execSQL) != 1 || !strings.Contains(db.execSQL[0], `"ai_policies"`) {
		t.Fatalf("SetPolicy should upsert AiPolicy, got %v", db.execSQL)
	}
}
