package composer

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"hycanvas/backend/internal/persistence"
)

// The golden parity claim (F40 E03): the goja run of the embedded bundle
// composes the committed fixture input to EXACTLY what the same code
// composes to under Node (testdata/compose-expected.json is Node-generated;
// regenerate it alongside `npm run gen:composer` when the compose path
// changes). Compared as parsed JSON so key order is irrelevant.
func TestCompose_ParityWithNode(t *testing.T) {
	raw, err := os.ReadFile("testdata/compose-input.json")
	if err != nil {
		t.Fatalf("read input: %v", err)
	}
	var in Input
	if err := json.Unmarshal(raw, &in); err != nil {
		t.Fatalf("parse input: %v", err)
	}
	got, err := Compose(context.Background(), in)
	if err != nil {
		t.Fatalf("compose: %v", err)
	}
	wantRaw, err := os.ReadFile("testdata/compose-expected.json")
	if err != nil {
		t.Fatalf("read expected: %v", err)
	}
	var gotAny, wantAny any
	if err := json.Unmarshal(got, &gotAny); err != nil {
		t.Fatalf("parse got: %v", err)
	}
	if err := json.Unmarshal(wantRaw, &wantAny); err != nil {
		t.Fatalf("parse want: %v", err)
	}
	if !reflect.DeepEqual(gotAny, wantAny) {
		t.Fatalf("goja composition diverged from the Node-generated fixture; re-run `npm run gen:composer` and regenerate testdata/compose-expected.json if the compose path changed intentionally")
	}
}

// The composed file must clear the SAME write boundary persistence.Create
// enforces, and carry the current schema version: a composer that emits an
// invalid or stale file would 422 on every generation.
func TestCompose_OutputShape(t *testing.T) {
	raw, err := os.ReadFile("testdata/compose-input.json")
	if err != nil {
		t.Fatalf("read input: %v", err)
	}
	var in Input
	if err := json.Unmarshal(raw, &in); err != nil {
		t.Fatalf("parse input: %v", err)
	}
	got, err := Compose(context.Background(), in)
	if err != nil {
		t.Fatalf("compose: %v", err)
	}
	var file map[string]any
	if err := json.Unmarshal(got, &file); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if file["format"] != "hycanvas.design" {
		t.Fatalf("format wrong: %v", file["format"])
	}
	if int(file["schemaVersion"].(float64)) != persistence.CurrentSchemaVersion {
		t.Fatalf("schemaVersion %v != current %d", file["schemaVersion"], persistence.CurrentSchemaVersion)
	}
	pages, _ := file["pages"].([]any)
	if len(pages) != 4 {
		t.Fatalf("want 4 pages, got %d", len(pages))
	}
	first := pages[0].(map[string]any)
	if kids, _ := first["children"].([]any); len(kids) == 0 {
		t.Fatal("first page composed empty")
	}
	if first["width"].(float64) != 1920 || first["height"].(float64) != 1080 {
		t.Fatalf("page size wrong: %vx%v", first["width"], first["height"])
	}
	// The cover page's speaker note survives composition.
	if notes, _ := first["notes"].(string); notes == "" {
		t.Fatal("cover speaker note lost")
	}
	if _, ok := file["theme"].(map[string]any); !ok {
		t.Fatal("theme record missing")
	}
}

func TestCompose_RejectsBadSize(t *testing.T) {
	if _, err := Compose(context.Background(), Input{Outline: map[string]any{}, Width: 0, Height: 100}); err == nil {
		t.Fatal("zero width must be rejected")
	}
}

// Themed composition (F40 E12): a catalog themeId resolves inside the bundle,
// stamps the CATALOG record as the file theme, and an unknown id fails loudly
// (silence would be a wrong deck).
func TestCompose_ThemeID(t *testing.T) {
	raw, err := os.ReadFile("testdata/compose-input.json")
	if err != nil {
		t.Fatalf("read input: %v", err)
	}
	var in Input
	if err := json.Unmarshal(raw, &in); err != nil {
		t.Fatalf("parse input: %v", err)
	}
	in.ThemeID = "theme-slate"
	got, err := Compose(context.Background(), in)
	if err != nil {
		t.Fatalf("themed compose: %v", err)
	}
	var file map[string]any
	if err := json.Unmarshal(got, &file); err != nil {
		t.Fatalf("parse: %v", err)
	}
	theme, _ := file["theme"].(map[string]any)
	if theme == nil || theme["id"] != "theme-slate" {
		t.Fatalf("catalog theme record not stamped: %v", file["theme"])
	}
	if theme["fontHeading"] != "Inter" {
		t.Fatalf("catalog fonts not carried: %v", theme["fontHeading"])
	}

	in.ThemeID = "theme-nonexistent"
	if _, err := Compose(context.Background(), in); err == nil {
		t.Fatal("unknown themeId must fail, not silently fall back")
	}
}
