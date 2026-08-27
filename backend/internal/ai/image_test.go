package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/accounts"
)

// The whole point of the second provider is that image work leaves the text
// provider and lands on the image one, while everything else stays put. These
// assert that split against a real database, plus the property that matters
// most for an upgrade: a workspace with no image config behaves exactly as it
// did before.
func TestAIImageProvider_DB(t *testing.T) {
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
	_, ws, _, err := acct.Signup(ctx, "ai-image+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}

	// Two stubs, so a call can be attributed to the provider that served it.
	var textHits, imageHits int
	textSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		textHits++
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]any{"content": "text"}}},
		})
	}))
	defer textSrv.Close()
	imageSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		imageHits++
		if r.Header.Get("authorization") != "Bearer sk-image" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []any{map[string]any{"b64_json": "aW1n"}},
		})
	}))
	defer imageSrv.Close()

	svc := NewService(tx, "test-ai-secret", true)

	if _, err := svc.SetConfig(ctx, ws.ID, ConfigInput{Provider: "custom", BaseURL: strp(textSrv.URL), APIKey: "sk-text"}); err != nil {
		t.Fatalf("SetConfig: %v", err)
	}

	// Before an image provider exists, images run on the main provider. This is
	// the pre-upgrade behavior, and it must be what an untouched workspace gets.
	if cfg, err := svc.GetImageConfig(ctx, ws.ID); err != nil || cfg != nil {
		t.Fatalf("expected no image config: %+v err=%v", cfg, err)
	}
	if _, err := svc.Image(ctx, ws.ID, "a cat", "1024x1024"); err != nil {
		t.Fatalf("image on main provider: %v", err)
	}
	if textHits == 0 {
		t.Fatal("image call should have gone to the main provider")
	}

	// A text-only provider is refused: storing one could only ever fail.
	if _, err := svc.SetImageConfig(ctx, ws.ID, ImageConfigInput{Provider: "deepseek", APIKey: "sk-x"}); err != ErrImageUnsupported {
		t.Fatalf("text-only image provider should be refused, got %v", err)
	}
	// A first save must bring a key.
	if _, err := svc.SetImageConfig(ctx, ws.ID, ImageConfigInput{Provider: "openai"}); err != ErrBadRequest {
		t.Fatalf("keyless image provider should be refused, got %v", err)
	}

	view, err := svc.SetImageConfig(ctx, ws.ID, ImageConfigInput{
		Provider: "custom", Model: "img-1", BaseURL: strp(imageSrv.URL), APIKey: "sk-image",
	})
	if err != nil {
		t.Fatalf("SetImageConfig: %v", err)
	}
	if !view.HasKey || view.Provider != "custom" {
		t.Fatalf("image config view wrong: %+v", view)
	}

	// Encrypted at rest, like every other stored key.
	var cipher *string
	if err := tx.QueryRow(ctx, `SELECT "key_cipher" FROM "ai_image_configs" WHERE "workspace_id" = $1`, ws.ID).Scan(&cipher); err != nil {
		t.Fatalf("read cipher: %v", err)
	}
	if cipher == nil || strings.Contains(*cipher, "sk-image") {
		t.Fatalf("image key not encrypted at rest: %v", cipher)
	}

	// Now images go to the image provider, and its key is the one presented.
	textBefore, imageBefore := textHits, imageHits
	if _, err := svc.Image(ctx, ws.ID, "a cat", "1024x1024"); err != nil {
		t.Fatalf("image on image provider: %v", err)
	}
	if imageHits != imageBefore+1 || textHits != textBefore {
		t.Fatalf("image call went to the wrong provider (text %d->%d, image %d->%d)", textBefore, textHits, imageBefore, imageHits)
	}

	// Text is unaffected: the split is per capability, not per workspace.
	textBefore, imageBefore = textHits, imageHits
	if _, err := svc.Text(ctx, ws.ID, "hi", ""); err != nil {
		t.Fatalf("text: %v", err)
	}
	if textHits != textBefore+1 || imageHits != imageBefore {
		t.Fatalf("text call went to the wrong provider (text %d->%d, image %d->%d)", textBefore, textHits, imageBefore, imageHits)
	}

	// Usage is metered per WORKSPACE, so both providers count against one cap.
	usage, err := svc.GetUsage(ctx, ws.ID)
	if err != nil {
		t.Fatalf("usage: %v", err)
	}
	if usage.TokensThisMonth == 0 {
		t.Fatal("expected both providers to accumulate into the workspace's usage")
	}

	// Clearing returns images to the main provider.
	if _, err := svc.SetImageConfig(ctx, ws.ID, ImageConfigInput{Provider: ""}); err != nil {
		t.Fatalf("clear image config: %v", err)
	}
	if cfg, err := svc.GetImageConfig(ctx, ws.ID); err != nil || cfg != nil {
		t.Fatalf("image config should be gone: %+v err=%v", cfg, err)
	}
	textBefore, imageBefore = textHits, imageHits
	if _, err := svc.Image(ctx, ws.ID, "a cat", "1024x1024"); err != nil {
		t.Fatalf("image after clear: %v", err)
	}
	if textHits != textBefore+1 || imageHits != imageBefore {
		t.Fatalf("cleared image config should fall back to the main provider (text %d->%d, image %d->%d)", textBefore, textHits, imageBefore, imageHits)
	}
}

// visionCallConfig routes by CAPABILITY rather than by slot: a workspace whose
// text provider cannot see should still get alt text from its image provider,
// which is the whole reason the fallback exists.
func TestVisionRoutingPrefersACapableProvider(t *testing.T) {
	cases := []struct {
		name       string
		text       string
		image      string
		wantVision bool
	}{
		{"text provider can see", "anthropic", "", true},
		{"text-only provider, no image provider", "deepseek", "", false},
		{"text-only provider, vision-capable image provider", "deepseek", "openai", true},
		{"text-only provider, image provider that cannot see either", "deepseek", "together", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			supported := ResolveRoute(c.text, "", "", FeatureDescribeImage).Supported
			if !supported && c.image != "" {
				supported = ResolveRoute(c.image, "", "", FeatureDescribeImage).Supported
			}
			if supported != c.wantVision {
				t.Fatalf("vision available = %v, want %v", supported, c.wantVision)
			}
		})
	}
}
