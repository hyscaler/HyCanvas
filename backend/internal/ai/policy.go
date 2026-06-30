package ai

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// AI governance enforcement (doc 19 FR security/fallback): loads a workspace's
// org policy + accumulated monthly usage, checks each call against it before
// dispatch (CheckPolicy), and meters consumed tokens after. The pure decision
// logic lives in registry.go (CheckPolicy); this file is the persistence +
// enforcement wiring around it.

// ErrPolicyBlocked is returned when an AI call is refused by the org policy
// (blocked provider, not in the allow list, or monthly token cap reached).
var ErrPolicyBlocked = errors.New("ai request blocked by organization policy")

// countTokens is a coarse token estimate (~4 chars per token) used for metering.
func countTokens(text string) int { return (len(text) + 3) / 4 }

// estimateTokens estimates a call's total cost: input tokens plus an output
// allowance, for the pre-call cap check.
func estimateTokens(text string, maxOutput int) int {
	if maxOutput <= 0 {
		maxOutput = 256
	}
	return countTokens(text) + maxOutput
}

// imageTokenCost is the flat token cost charged for one image generation/edit.
const imageTokenCost = 1000

func currentPeriod() string { return time.Now().UTC().Format("2006-01") }

func (s *Service) loadPolicy(ctx context.Context, workspaceID string) (OrgPolicy, error) {
	const q = `SELECT "allowed_providers","blocked_providers","monthly_token_cap" FROM "ai_policies" WHERE "workspace_id" = $1`
	var p OrgPolicy
	err := s.db.QueryRow(ctx, q, workspaceID).Scan(&p.AllowedProviders, &p.BlockedProviders, &p.MonthlyTokenCap)
	if errors.Is(err, pgx.ErrNoRows) {
		return OrgPolicy{}, nil // no policy set => unrestricted
	}
	if err != nil {
		return OrgPolicy{}, err
	}
	return p, nil
}

func (s *Service) loadUsage(ctx context.Context, workspaceID, period string) (Usage, error) {
	const q = `SELECT "tokens" FROM "ai_usages" WHERE "workspace_id" = $1 AND "period" = $2`
	var u Usage
	err := s.db.QueryRow(ctx, q, workspaceID, period).Scan(&u.TokensThisMonth)
	if errors.Is(err, pgx.ErrNoRows) {
		return Usage{}, nil
	}
	if err != nil {
		return Usage{}, err
	}
	return u, nil
}

func (s *Service) recordUsage(ctx context.Context, workspaceID, period string, tokens int) error {
	const q = `INSERT INTO "ai_usages" ("workspace_id","period","tokens","updated_at")
		VALUES ($1,$2,$3,CURRENT_TIMESTAMP)
		ON CONFLICT ("workspace_id","period")
		DO UPDATE SET "tokens" = "ai_usages"."tokens" + EXCLUDED."tokens", "updated_at" = CURRENT_TIMESTAMP`
	_, err := s.db.Exec(ctx, q, workspaceID, period, tokens)
	return err
}

// enforce refuses the call (ErrPolicyBlocked) when the org policy disallows the
// provider or the estimated usage would exceed the monthly cap.
func (s *Service) enforce(ctx context.Context, workspaceID, providerID string, estTokens int) error {
	policy, err := s.loadPolicy(ctx, workspaceID)
	if err != nil {
		return err
	}
	usage, err := s.loadUsage(ctx, workspaceID, currentPeriod())
	if err != nil {
		return err
	}
	if d := CheckPolicy(policy, usage, providerID, estTokens); !d.Allowed {
		return fmt.Errorf("%w: %s", ErrPolicyBlocked, d.Reason)
	}
	return nil
}

// meter records consumed tokens (best effort: a metering write failure must not
// fail an otherwise-successful AI call).
func (s *Service) meter(ctx context.Context, workspaceID string, tokens int) {
	if tokens <= 0 {
		return
	}
	_ = s.recordUsage(ctx, workspaceID, currentPeriod(), tokens)
}

// GetPolicy returns the workspace's AI policy (empty/unrestricted when none set).
func (s *Service) GetPolicy(ctx context.Context, workspaceID string) (OrgPolicy, error) {
	return s.loadPolicy(ctx, workspaceID)
}

// SetPolicy upserts the workspace's AI policy.
func (s *Service) SetPolicy(ctx context.Context, workspaceID string, p OrgPolicy) error {
	if p.AllowedProviders == nil {
		p.AllowedProviders = []string{}
	}
	if p.BlockedProviders == nil {
		p.BlockedProviders = []string{}
	}
	if p.MonthlyTokenCap < 0 {
		p.MonthlyTokenCap = 0
	}
	const q = `INSERT INTO "ai_policies" ("workspace_id","allowed_providers","blocked_providers","monthly_token_cap","updated_at")
		VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP)
		ON CONFLICT ("workspace_id")
		DO UPDATE SET "allowed_providers" = EXCLUDED."allowed_providers",
			"blocked_providers" = EXCLUDED."blocked_providers",
			"monthly_token_cap" = EXCLUDED."monthly_token_cap",
			"updated_at" = CURRENT_TIMESTAMP`
	_, err := s.db.Exec(ctx, q, workspaceID, p.AllowedProviders, p.BlockedProviders, p.MonthlyTokenCap)
	return err
}

// GetUsage returns the workspace's accumulated usage for the current month.
func (s *Service) GetUsage(ctx context.Context, workspaceID string) (Usage, error) {
	return s.loadUsage(ctx, workspaceID, currentPeriod())
}
