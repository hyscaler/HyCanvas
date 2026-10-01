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

func ids(list ModelList) []string {
	out := make([]string, 0, len(list.Models))
	for _, m := range list.Models {
		out = append(out, m.ID)
	}
	return out
}

// The two catalog shapes in circulation both parse; anything else is "no
// catalog", never an error.
func TestParseCatalogReadsBothShapes(t *testing.T) {
	wrapped, ok := parseCatalog([]byte(`{"object":"list","data":[{"id":"gpt-4o-mini","object":"model"},{"id":"dall-e-3"}]}`))
	if !ok || len(wrapped) != 2 || wrapped[0].ID != "gpt-4o-mini" {
		t.Fatalf("wrapped = %+v %v", wrapped, ok)
	}
	bare, ok := parseCatalog([]byte(`[{"id":"meta-llama/Llama-3.3-70B-Instruct-Turbo","display_name":"Llama 3.3 70B"}]`))
	if !ok || len(bare) != 1 || bare[0].DisplayName != "Llama 3.3 70B" {
		t.Fatalf("bare = %+v %v", bare, ok)
	}
	if _, ok := parseCatalog([]byte(`"not a list"`)); ok {
		t.Fatal("a string is not a catalog")
	}
	if _, ok := parseCatalog([]byte(`{"models":[]}`)); ok {
		t.Fatal("an object without data is not a catalog")
	}
}

// The purpose narrows a catalog that carries no modality of its own by name,
// sorted and deduped; an image purpose that matches nothing keeps the whole
// list rather than emptying the field.
func TestFinishCatalogShapesByPurpose(t *testing.T) {
	all := []ModelInfo{{ID: "gpt-4o"}, {ID: "text-embedding-3-small"}, {ID: "dall-e-3"}, {ID: "whisper-1"}, {ID: "gpt-4o"}, {ID: "gpt-image-1"}, {ID: "tts-1"}}
	text := finishCatalog(all, PurposeText)
	if got := strings.Join(ids(text), ","); got != "gpt-4o" || !text.Supported {
		t.Fatalf("text = %q supported=%v", got, text.Supported)
	}
	image := finishCatalog(all, PurposeImage)
	if got := strings.Join(ids(image), ","); got != "dall-e-3,gpt-image-1" {
		t.Fatalf("image = %q", got)
	}
	every := finishCatalog(all, "")
	if len(every.Models) != 6 || every.Models[0].ID != "dall-e-3" {
		t.Fatalf("all = %v", ids(every))
	}
	// No image model by name: the whole catalog, so the field is not empty.
	chatOnly := finishCatalog([]ModelInfo{{ID: "deepseek-chat"}, {ID: "deepseek-reasoner"}}, PurposeImage)
	if len(chatOnly.Models) != 2 {
		t.Fatalf("image purpose with no match = %v", ids(chatOnly))
	}
	// Bounded.
	many := make([]ModelInfo, 0, maxListedModels+50)
	for i := 0; i < maxListedModels+50; i++ {
		many = append(many, ModelInfo{ID: "m" + strings.Repeat("0", 3-len(itoa(i%1000)))})
		many[len(many)-1].ID = "m" + itoa(i)
	}
	if got := len(finishCatalog(many, "").Models); got != maxListedModels {
		t.Fatalf("bound = %d", got)
	}
}

func itoa(n int) string {
	return strings.TrimSpace(strings.Join([]string{string(rune('0' + n/100%10)), string(rune('0' + n/10%10)), string(rune('0' + n%10))}, ""))
}

// Bedrock's catalog: on-demand, active models with the field's modality, and
// the inference profiles the current models are reached through.
func TestParseBedrockCatalog(t *testing.T) {
	raw := []byte(`{"modelSummaries":[
		{"modelId":"anthropic.claude-3-5-sonnet-20241022-v2:0","modelName":"Claude 3.5 Sonnet v2","providerName":"Anthropic","outputModalities":["TEXT"],"inferenceTypesSupported":["ON_DEMAND"],"modelLifecycle":{"status":"ACTIVE"}},
		{"modelId":"amazon.nova-canvas-v1:0","modelName":"Nova Canvas","providerName":"Amazon","outputModalities":["IMAGE"],"inferenceTypesSupported":["ON_DEMAND"],"modelLifecycle":{"status":"ACTIVE"}},
		{"modelId":"anthropic.claude-v2","modelName":"Claude","providerName":"Anthropic","outputModalities":["TEXT"],"inferenceTypesSupported":["ON_DEMAND"],"modelLifecycle":{"status":"LEGACY"}},
		{"modelId":"meta.llama3-1-405b-instruct-v1:0","modelName":"Llama 3.1 405B","providerName":"Meta","outputModalities":["TEXT"],"inferenceTypesSupported":["PROVISIONED"],"modelLifecycle":{"status":"ACTIVE"}}
	]}`)
	text := parseBedrockModels(raw, PurposeText)
	if len(text) != 1 || text[0].ID != "anthropic.claude-3-5-sonnet-20241022-v2:0" || text[0].Label != "Anthropic Claude 3.5 Sonnet v2" {
		t.Fatalf("text = %+v", text)
	}
	image := parseBedrockModels(raw, PurposeImage)
	if len(image) != 1 || image[0].ID != "amazon.nova-canvas-v1:0" {
		t.Fatalf("image = %+v", image)
	}
	if all := parseBedrockModels(raw, ""); len(all) != 2 {
		t.Fatalf("all = %+v", all)
	}
	profiles := parseBedrockProfiles([]byte(`{"inferenceProfileSummaries":[
		{"inferenceProfileId":"us.anthropic.claude-opus-4-7","inferenceProfileName":"US Anthropic Claude Opus 4.7","status":"ACTIVE","type":"SYSTEM_DEFINED"},
		{"inferenceProfileId":"eu.old","inferenceProfileName":"Retired","status":"INACTIVE"}
	]}`))
	if len(profiles) != 1 || profiles[0].ID != "us.anthropic.claude-opus-4-7" {
		t.Fatalf("profiles = %+v", profiles)
	}
	// A text field keeps the chat profiles and drops the image and video
	// ones; an image field keeps only what is named like an image model.
	mixed := []ModelInfo{{ID: "us.anthropic.claude-opus-4-7"}, {ID: "us.stability.stable-image-core-v1:1"}, {ID: "us.twelvelabs.pegasus-1-2-v1:0"}, {ID: "us.amazon.nova-pro-v1:0"}}
	if got := strings.Join(ids(finishCatalog(mixed, PurposeText)), ","); got != "us.amazon.nova-pro-v1:0,us.anthropic.claude-opus-4-7" {
		t.Fatalf("text profiles = %q", got)
	}
	if got := strings.Join(ids(finishCatalog(mixed, PurposeImage)), ","); got != "us.stability.stable-image-core-v1:1" {
		t.Fatalf("image profiles = %q", got)
	}
	// The catalog lives on the control plane host of the same region.
	if got := bedrockControlPlaneURL("https://bedrock-runtime.us-east-1.amazonaws.com"); got != "https://bedrock.us-east-1.amazonaws.com" {
		t.Fatalf("control plane = %q", got)
	}
	if got := bedrockControlPlaneURL("https://vpce-123.bedrock-runtime.eu-west-1.vpce.amazonaws.com/"); got != "https://vpce-123.bedrock-runtime.eu-west-1.vpce.amazonaws.com" {
		t.Fatalf("vpc endpoint = %q", got)
	}
}

// A candidate's catalog comes from its own host and key: the list itself, a
// rejected key as the classified auth failure, a host without a models route
// as "no catalog", and never a metered token.
func TestListModelsCandidate_DB(t *testing.T) {
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
	_, ws, _, err := acct.Signup(ctx, "ai-models+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}

	status := http.StatusOK
	var seenAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/models" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		seenAuth = r.Header.Get("authorization")
		if status != http.StatusOK {
			w.WriteHeader(status)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{
			{"id": "gpt-4o-mini"}, {"id": "dall-e-3"}, {"id": "text-embedding-3-small"}, {"id": "gpt-4o"},
		}})
	}))
	defer srv.Close()

	svc := NewService(tx, "test-ai-secret", true)
	cand := ConfigInput{Provider: "custom", BaseURL: strp(srv.URL), APIKey: "sk-typed"}

	list, err := svc.ListModels(ctx, ws.ID, cand, PurposeText)
	if err != nil || !list.Supported {
		t.Fatalf("ListModels: %+v %v", list, err)
	}
	if got := strings.Join(ids(list), ","); got != "gpt-4o,gpt-4o-mini" {
		t.Fatalf("text models = %q", got)
	}
	if seenAuth != "Bearer sk-typed" {
		t.Fatalf("the typed key must reach the host, got %q", seenAuth)
	}
	image, err := svc.ListModels(ctx, ws.ID, cand, PurposeImage)
	if err != nil || strings.Join(ids(image), ",") != "dall-e-3" {
		t.Fatalf("image models = %v %v", ids(image), err)
	}
	every, err := svc.ListModels(ctx, ws.ID, cand, "")
	if err != nil || len(every.Models) != 4 {
		t.Fatalf("all models = %v %v", ids(every), err)
	}

	// Without a key there is nothing to list with.
	if _, err := svc.ListModels(ctx, ws.ID, ConfigInput{Provider: "custom", BaseURL: strp(srv.URL)}, ""); !errors.Is(err, ErrKeyRequired) {
		t.Fatalf("keyless candidate should be ErrKeyRequired, got %v", err)
	}

	// A rejected key is the auth failure a call would raise.
	status = http.StatusUnauthorized
	_, err = svc.ListModels(ctx, ws.ID, cand, "")
	var up *UpstreamError
	if !errors.Is(err, ErrBadGateway) || !errors.As(err, &up) || up.Status != http.StatusUnauthorized {
		t.Fatalf("rejected key = %v", err)
	}

	// A host with no models route has no catalog, which is not an error.
	status = http.StatusNotFound
	list, err = svc.ListModels(ctx, ws.ID, cand, "")
	if err != nil || list.Supported || len(list.Models) != 0 {
		t.Fatalf("no catalog = %+v %v", list, err)
	}

	// The stored config lists through the same door once saved.
	status = http.StatusOK
	if _, err := svc.SetConfig(ctx, ws.ID, cand); err != nil {
		t.Fatalf("SetConfig: %v", err)
	}
	stored, err := svc.ListStoredModels(ctx, ws.ID, PurposeText)
	if err != nil || strings.Join(ids(stored), ",") != "gpt-4o,gpt-4o-mini" {
		t.Fatalf("stored models = %v %v", ids(stored), err)
	}
	// And a candidate that leaves the key blank uses the stored one.
	seenAuth = ""
	if _, err := svc.ListModels(ctx, ws.ID, ConfigInput{Provider: "custom", BaseURL: strp(srv.URL)}, ""); err != nil || seenAuth != "Bearer sk-typed" {
		t.Fatalf("stored key should be used, auth=%q err=%v", seenAuth, err)
	}

	// The image provider's catalog, the same way.
	imgList, err := svc.ListImageModels(ctx, ws.ID, ImageConfigInput{Provider: "custom", BaseURL: strp(srv.URL), APIKey: "sk-image"})
	if err != nil || strings.Join(ids(imgList), ",") != "dall-e-3" {
		t.Fatalf("image provider models = %v %v", ids(imgList), err)
	}

	if usage, err := svc.GetUsage(ctx, ws.ID); err != nil || usage.TokensThisMonth != 0 {
		t.Fatalf("listing must not meter usage: %+v err=%v", usage, err)
	}
}
