package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"hycanvas/backend/internal/accounts"
	"hycanvas/backend/internal/ai"
	"hycanvas/backend/internal/aistudio"
	"hycanvas/backend/internal/jobs"
	"hycanvas/backend/internal/persistence"
	"hycanvas/backend/internal/storage"
	"hycanvas/backend/internal/uploads"
)

// The generation job end to end: outline from the workspace's provider,
// composition under goja, picture placement through the image provider and
// the uploads service, persistence of the finished file. Only the model is a
// stand-in, answering over HTTP in the OpenAI-compatible dialect; the DB, the
// encrypted provider config, the job registry, the storage driver and the
// saved file are all real.
//
// One page with one picture on purpose: the services share one transaction,
// which cannot serve two goroutines at once, and a single region keeps every
// model call sequential.
func TestGenerationJobPlacesImages_DB(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set; skipping DB integration test")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, stripSchemaParam(dsn))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer conn.Close(ctx)
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// The provider: every chat call gets the same one-page outline (the
	// page polish parses it as points, finds none, and keeps the outline's),
	// every image call gets a small real PNG.
	outline, _ := json.Marshal(map[string]any{
		"title": "Coastal restoration",
		"theme": "calm, coastal, restrained",
		"pages": []any{map[string]any{
			"title":      "Why the shoreline is retreating",
			"archetype":  "bullets",
			"visualRole": "content",
			"points":     []string{"Erosion is accelerating on the north shore", "Two villages have already relocated", "Insurance cover is being withdrawn"},
			"image":      map[string]any{"subject": "a dune belt at dawn", "treatment": "photo"},
		}},
	})
	pic := image.NewRGBA(image.Rect(0, 0, 4, 4))
	for x := 0; x < 4; x++ {
		for y := 0; y < 4; y++ {
			pic.Set(x, y, color.RGBA{R: 200, G: 120, B: 40, A: 255})
		}
	}
	var pngBuf bytes.Buffer
	if err := png.Encode(&pngBuf, pic); err != nil {
		t.Fatal(err)
	}
	var imageCalls, textCalls int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/chat/completions"):
			atomic.AddInt32(&textCalls, 1)
			_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": string(outline)}}}})
		case strings.HasSuffix(r.URL.Path, "/images/generations"):
			atomic.AddInt32(&imageCalls, 1)
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"b64_json": base64.StdEncoding.EncodeToString(pngBuf.Bytes())}}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer provider.Close()

	acct := accounts.NewService(tx, "test-jwt-secret")
	user, ws, _, err := acct.Signup(ctx, "gen-e2e+"+uuid.NewString()+"@example.com", "a-strong-password", "Owner")
	if err != nil {
		t.Fatalf("signup: %v", err)
	}
	aiSvc := ai.NewService(tx, "test-ai-secret-for-the-e2e-run", true)
	base := provider.URL + "/v1"
	if _, err := aiSvc.SetConfig(ctx, ws.ID, ai.ConfigInput{Provider: "custom", Model: "test-text", ImageModel: "test-image", BaseURL: &base, APIKey: "test-key"}); err != nil {
		t.Fatalf("set provider config: %v", err)
	}
	store, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	up := uploads.NewService(tx, store, acct)
	persist := persistence.NewService(tx).WithStorage(store)
	studio := aistudio.NewService(tx, aiSvc)
	reg := jobs.NewRegistry()

	plan := generatePlan{Workspace: ws.ID, Dt: "presentation", PageCount: 1, Brief: "a one-slide deck about the shoreline"}
	plan.Size.w, plan.Size.h = 1920, 1080
	job := startGenerationJob(studio, aiSvc, up, persist, reg, user.ID, plan)

	var done *jobs.Job
	for deadline := time.Now().Add(90 * time.Second); time.Now().Before(deadline); {
		if j, ok := reg.Get(user.ID, job.ID); ok && (j.Status == jobs.StatusCompleted || j.Status == jobs.StatusFailed) {
			done = j
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if done == nil {
		t.Fatal("the generation job did not finish")
	}
	if done.Status != jobs.StatusCompleted {
		t.Fatalf("job failed: %s", done.Error)
	}
	result, _ := done.Result.(map[string]any)
	images, _ := result["images"].(imagePlacement)
	if images.Requested != 1 || images.Placed != 1 || images.Unsupported {
		t.Fatalf("image placement = %+v", images)
	}
	if n := atomic.LoadInt32(&imageCalls); n != 1 {
		t.Fatalf("expected exactly one image call, got %d", n)
	}
	if atomic.LoadInt32(&textCalls) == 0 {
		t.Fatal("the outline never reached the provider")
	}

	// The saved file carries the picture: the stand-in became an image node
	// pointing at a stored asset, and no tagged shape is left behind.
	designID, _ := result["designId"].(string)
	file, err := persist.FileFor(ctx, designID, ws.ID)
	if err != nil {
		t.Fatalf("load saved design: %v", err)
	}
	assetIDs := map[string]bool{}
	for _, a := range asSlice(file["assets"]) {
		ao := asMap(a)
		if ao["kind"] == "image" && asStr(ao["url"]) != "" {
			assetIDs[asStr(ao["id"])] = true
		}
	}
	imageNodes, standIns := 0, 0
	for _, pg := range asSlice(file["pages"]) {
		for _, ch := range asSlice(asMap(pg)["children"]) {
			n := asMap(ch)
			prompt, _ := asMap(n["data"])["aiImagePrompt"].(string)
			switch {
			case n["type"] == "image":
				imageNodes++
				if !assetIDs[asStr(asMap(n["source"])["assetId"])] {
					t.Fatalf("image node points at an asset the file does not list: %v", n["source"])
				}
				if prompt == "" {
					t.Fatal("the picture must keep its tags so the editor still recognises the region")
				}
			case n["type"] == "shape" && prompt != "":
				standIns++
			}
		}
	}
	if imageNodes != 1 || standIns != 0 {
		t.Fatalf("saved deck has %d image nodes and %d stand-ins, want 1 and 0", imageNodes, standIns)
	}
}

func asStr(v any) string {
	s, _ := v.(string)
	return s
}
