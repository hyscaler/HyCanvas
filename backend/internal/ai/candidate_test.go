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

// Testing a candidate config before it is saved (#46). The contract has two
// halves and both matter: the candidate is judged exactly as a save would read
// it (an untouched key is the stored key), and nothing about it is ever
// written, so a failing test cannot replace a config that works.
func TestCandidateConfig_DB(t *testing.T) {
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
	_, ws, _, err := acct.Signup(ctx, "ai-candidate+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}

	// One stub for both halves: chat completions for the text test, a model
	// listing for the image probe. Only "sk-good" is accepted, and the last
	// model asked for is recorded so the test can see which config was used.
	lastModel := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("authorization") != "Bearer sk-good" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/chat/completions"):
			var body struct {
				Model string `json:"model"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			lastModel = body.Model
			_ = json.NewEncoder(w).Encode(map[string]any{
				"choices": []any{map[string]any{"message": map[string]any{"content": "ok"}}},
			})
		case strings.HasSuffix(r.URL.Path, "/models"):
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{}})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	// A host that refuses connections: a server that was started and closed.
	dead := httptest.NewServer(http.NotFoundHandler())
	deadURL := dead.URL
	dead.Close()

	svc := NewService(tx, "test-ai-secret", true)

	// Nothing stored, and no key typed: there is nothing to test with.
	if err := svc.TestConfig(ctx, ws.ID, ConfigInput{Provider: "custom", BaseURL: strp(srv.URL)}); !errors.Is(err, ErrKeyRequired) {
		t.Fatalf("keyless candidate should be ErrKeyRequired, got %v", err)
	}

	// A working candidate passes, and is NOT saved.
	if err := svc.TestConfig(ctx, ws.ID, ConfigInput{Provider: "custom", Model: "m-1", BaseURL: strp(srv.URL), APIKey: "sk-good"}); err != nil {
		t.Fatalf("good candidate should pass: %v", err)
	}
	if lastModel != "m-1" {
		t.Fatalf("the candidate's model should be the one called, got %q", lastModel)
	}
	if cfg, err := svc.GetConfig(ctx, ws.ID); err != nil || cfg != nil {
		t.Fatalf("a test must never persist the candidate, got %+v err=%v", cfg, err)
	}

	// A rejected key surfaces as the provider's 401, so the form can name it.
	err = svc.TestConfig(ctx, ws.ID, ConfigInput{Provider: "custom", BaseURL: strp(srv.URL), APIKey: "sk-bad"})
	var up *UpstreamError
	if !errors.Is(err, ErrBadGateway) || !errors.As(err, &up) || up.Status != http.StatusUnauthorized {
		t.Fatalf("bad key should carry upstream 401, got %v", err)
	}

	// An unreachable host is its own reason, not a generic failure.
	err = svc.TestConfig(ctx, ws.ID, ConfigInput{Provider: "custom", BaseURL: strp(deadURL), APIKey: "sk-good"})
	if !errors.Is(err, ErrBadGateway) || !errors.Is(err, ErrProviderUnreachable) {
		t.Fatalf("unreachable host should be ErrProviderUnreachable, got %v", err)
	}

	// Store a working config, then test a change with the key left untouched:
	// the stored key is used, and the stored config is left exactly as it was.
	if _, err := svc.SetConfig(ctx, ws.ID, ConfigInput{Provider: "custom", Model: "m-1", BaseURL: strp(srv.URL), APIKey: "sk-good"}); err != nil {
		t.Fatalf("SetConfig: %v", err)
	}
	if err := svc.TestConfig(ctx, ws.ID, ConfigInput{Provider: "custom", Model: "m-2"}); err != nil {
		t.Fatalf("untouched key should fall back to the stored one: %v", err)
	}
	if lastModel != "m-2" {
		t.Fatalf("the candidate model should be tested, got %q", lastModel)
	}
	if cfg, _ := svc.GetConfig(ctx, ws.ID); cfg == nil || deref(cfg.Model) != "m-1" || deref(cfg.BaseURL) != srv.URL {
		t.Fatalf("testing must leave the stored config alone, got %+v", cfg)
	}

	// A failing candidate does not disturb the stored one either.
	_ = svc.TestConfig(ctx, ws.ID, ConfigInput{Provider: "custom", BaseURL: strp(srv.URL), APIKey: "sk-bad"})
	if err := svc.TestConfig(ctx, ws.ID, ConfigInput{Provider: "custom"}); err != nil {
		t.Fatalf("stored config should still work after a failed candidate: %v", err)
	}

	// A provider change must bring its own key, exactly as on a save.
	if err := svc.TestConfig(ctx, ws.ID, ConfigInput{Provider: "openai"}); !errors.Is(err, ErrKeyRequiredForProviderChange) {
		t.Fatalf("keyless provider change should be refused, got %v", err)
	}

	// The image provider: the same two halves, on the free credentials probe.
	check, err := svc.VerifyImageCandidate(ctx, ws.ID, ImageConfigInput{Provider: "custom", BaseURL: strp(srv.URL), APIKey: "sk-good"})
	if err != nil || !check.Verified {
		t.Fatalf("good image candidate should verify, got %+v err=%v", check, err)
	}
	if img, err := svc.GetImageConfig(ctx, ws.ID); err != nil || img != nil {
		t.Fatalf("an image test must never persist the candidate, got %+v err=%v", img, err)
	}
	if _, err := svc.VerifyImageCandidate(ctx, ws.ID, ImageConfigInput{Provider: "custom", BaseURL: strp(srv.URL), APIKey: "sk-bad"}); !errors.Is(err, ErrBadGateway) {
		t.Fatalf("rejected image key should be ErrBadGateway, got %v", err)
	}
	if _, err := svc.VerifyImageCandidate(ctx, ws.ID, ImageConfigInput{Provider: "custom", BaseURL: strp(srv.URL)}); !errors.Is(err, ErrImageKeyRequired) {
		t.Fatalf("keyless image candidate should be ErrImageKeyRequired, got %v", err)
	}
	if _, err := svc.VerifyImageCandidate(ctx, ws.ID, ImageConfigInput{Provider: ""}); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("an empty image candidate has nothing to test, got %v", err)
	}
}
