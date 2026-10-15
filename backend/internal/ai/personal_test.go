package ai

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/accounts"
)

// The personal provider (#47): who serves a call, what governs it, who is
// charged, and that one user's key never reaches anyone else.
func TestPersonalProvider_DB(t *testing.T) {
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

	acct := accounts.NewService(tx, "test-jwt-secret")
	me, ws, _, err := acct.Signup(ctx, "ai-personal+"+uuid.NewString()+"@example.com", "a-strong-password", "Me")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	other, _, _, err := acct.Signup(ctx, "ai-personal-other+"+uuid.NewString()+"@example.com", "a-strong-password", "Other")
	if err != nil {
		t.Fatalf("signup other: %v", err)
	}

	// The stub accepts the workspace key and the personal key, and records
	// which one each call carried.
	lastKey := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimPrefix(r.Header.Get("authorization"), "Bearer ")
		if key != "sk-ws" && key != "sk-me" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		lastKey = key
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]any{"content": "ok"}}},
		})
	}))
	defer srv.Close()

	svc := NewService(tx, "test-ai-secret", true)
	asMe := WithUser(ctx, me.ID)
	personal := ConfigInput{Provider: "custom", Model: "m-me", BaseURL: strp(srv.URL), APIKey: "sk-me"}

	// A personal candidate is tested without being saved, like a workspace one.
	if err := svc.TestUserConfig(ctx, me.ID, &personal); err != nil {
		t.Fatalf("personal candidate should pass: %v", err)
	}
	if cfg, err := svc.GetUserConfig(ctx, me.ID); err != nil || cfg != nil {
		t.Fatalf("a test must not persist the personal candidate, got %+v err=%v", cfg, err)
	}
	view, err := svc.SetUserConfig(ctx, me.ID, personal)
	if err != nil || view == nil || !view.HasKey {
		t.Fatalf("SetUserConfig: %+v err=%v", view, err)
	}

	// AC-1: no workspace provider, so the caller's personal one serves.
	if _, err := svc.Text(asMe, ws.ID, "hi", ""); err != nil || lastKey != "sk-me" {
		t.Fatalf("personal key should serve a workspace without a provider: key=%q err=%v", lastKey, err)
	}
	if v, err := svc.Effective(asMe, ws.ID); err != nil || v.Source != "personal" || !v.HasPersonal || v.Config == nil {
		t.Fatalf("effective should be personal, got %+v err=%v", v, err)
	}
	// Without a user on the context (or as anyone else) there is no provider.
	if _, err := svc.Text(ctx, ws.ID, "hi", ""); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("no user, no provider: got %v", err)
	}
	if _, err := svc.Text(WithUser(ctx, other.ID), ws.ID, "hi", ""); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("another user must never get this user's key: got %v", err)
	}
	if cfg, _ := svc.GetUserConfig(ctx, other.ID); cfg != nil {
		t.Fatalf("personal configs are per user, got %+v", cfg)
	}

	// Metering: the workspace (for its cap) and the user both see the tokens.
	if u, _ := svc.GetUserUsage(ctx, me.ID); u.TokensThisMonth <= 0 {
		t.Fatalf("personal usage should be metered to the user, got %+v", u)
	}
	if u, _ := svc.GetUsage(ctx, ws.ID); u.TokensThisMonth <= 0 {
		t.Fatalf("personal usage should count toward the workspace, got %+v", u)
	}

	// AC-4: the workspace allow list governs a personal key too.
	if err := svc.SetPolicy(ctx, ws.ID, OrgPolicy{AllowedProviders: []string{"openai"}}); err != nil {
		t.Fatalf("SetPolicy: %v", err)
	}
	if _, err := svc.Text(asMe, ws.ID, "hi", ""); !errors.Is(err, ErrPolicyBlocked) {
		t.Fatalf("allow list should block the personal provider, got %v", err)
	}
	// The personal-keys switch: off means no fallback, and a later save that
	// omits it keeps it off.
	off := false
	if err := svc.SetPolicy(ctx, ws.ID, OrgPolicy{AllowPersonalKeys: &off}); err != nil {
		t.Fatalf("SetPolicy off: %v", err)
	}
	if err := svc.SetPolicy(ctx, ws.ID, OrgPolicy{MonthlyTokenCap: 0}); err != nil {
		t.Fatalf("SetPolicy keep: %v", err)
	}
	if p, _ := svc.GetPolicy(ctx, ws.ID); p.AllowPersonalKeys == nil || *p.AllowPersonalKeys {
		t.Fatalf("an omitted switch must keep the stored value, got %+v", p.AllowPersonalKeys)
	}
	if _, err := svc.Text(asMe, ws.ID, "hi", ""); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("personal keys switched off: got %v", err)
	}
	if v, _ := svc.Effective(asMe, ws.ID); v.Source != "none" || v.PersonalKeysAllowed || !v.HasPersonal {
		t.Fatalf("effective with personal keys off, got %+v", v)
	}
	on := true
	if err := svc.SetPolicy(ctx, ws.ID, OrgPolicy{AllowPersonalKeys: &on}); err != nil {
		t.Fatalf("SetPolicy on: %v", err)
	}

	// AC-3: a workspace provider, once set, wins over the personal one.
	if _, err := svc.SetConfig(ctx, ws.ID, ConfigInput{Provider: "custom", Model: "m-ws", BaseURL: strp(srv.URL), APIKey: "sk-ws"}); err != nil {
		t.Fatalf("SetConfig: %v", err)
	}
	if _, err := svc.Text(asMe, ws.ID, "hi", ""); err != nil || lastKey != "sk-ws" {
		t.Fatalf("workspace provider should win: key=%q err=%v", lastKey, err)
	}
	if v, _ := svc.Effective(asMe, ws.ID); v.Source != "workspace" {
		t.Fatalf("effective should be workspace, got %+v", v)
	}
	// Image calls never cross owners: the workspace's text provider serves
	// them even though the user has a personal image provider.
	if _, err := svc.SetUserImageConfig(ctx, me.ID, ImageConfigInput{Provider: "custom", BaseURL: strp(srv.URL), APIKey: "sk-me"}); err != nil {
		t.Fatalf("SetUserImageConfig: %v", err)
	}
	if cfg, err := svc.imageCallConfig(asMe, ws.ID); err != nil || cfg.APIKey != "sk-ws" || cfg.personalUser != "" {
		t.Fatalf("image call should stay on the workspace provider, got key=%q personal=%q err=%v", cfg.APIKey, cfg.personalUser, err)
	}
	if err := svc.DeleteConfig(ctx, ws.ID); err != nil {
		t.Fatalf("DeleteConfig: %v", err)
	}
	if cfg, err := svc.imageCallConfig(asMe, ws.ID); err != nil || cfg.APIKey != "sk-me" || cfg.personalUser != me.ID {
		t.Fatalf("with no workspace provider, images use the personal image provider, got key=%q err=%v", cfg.APIKey, err)
	}

	// AC-6: removing the personal provider deletes the stored key outright.
	if err := svc.DeleteUserConfig(ctx, me.ID); err != nil {
		t.Fatalf("DeleteUserConfig: %v", err)
	}
	if err := svc.DeleteUserImageConfig(ctx, me.ID); err != nil {
		t.Fatalf("DeleteUserImageConfig: %v", err)
	}
	var rows int
	if err := tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM "user_ai_configs" WHERE "user_id" = $1) + (SELECT count(*) FROM "user_ai_image_configs" WHERE "user_id" = $1)`, me.ID).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("personal rows should be gone, got %d err=%v", rows, err)
	}
	if v, _ := svc.Effective(asMe, ws.ID); v.Source != "none" || v.HasPersonal {
		t.Fatalf("effective after removal, got %+v", v)
	}
}
