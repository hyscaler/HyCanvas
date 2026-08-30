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

// Layout-grounded composition carries the deck visual system (deckStyle): the
// type scale comes from each slot's geometry rather than fixed pixels, and a
// reading page gets the paper treatment instead of repeating the cover's deep
// background on every slide. Run through goja, so this also proves the
// embedded bundle carries the change.
func TestCompose_LayoutGroundedVisualSystem(t *testing.T) {
	raw, err := os.ReadFile("testdata/compose-input.json")
	if err != nil {
		t.Fatalf("read input: %v", err)
	}
	var in Input
	if err := json.Unmarshal(raw, &in); err != nil {
		t.Fatalf("parse input: %v", err)
	}
	layout := map[string]any{
		"id": "l-content", "masterId": "m-1", "name": "Title and content",
		"placeholders": []any{
			map[string]any{"id": "ph-title", "role": "title", "rect": map[string]any{"x": 115, "y": 86, "width": 1690, "height": 151}},
			map[string]any{"id": "ph-content", "role": "content", "rect": map[string]any{"x": 115, "y": 280, "width": 1690, "height": 648}},
		},
	}
	in.LayoutSet = map[string]any{
		"masters": []any{map[string]any{"id": "m-1", "name": "Default", "placeholders": []any{}}},
		"layouts": []any{layout},
	}
	got, err := Compose(context.Background(), in)
	if err != nil {
		t.Fatalf("layout-grounded compose: %v", err)
	}
	var file struct {
		Pages []struct {
			Background map[string]any `json:"background"`
			Children   []struct {
				Type    string `json:"type"`
				Content []struct {
					Runs []struct {
						Style struct {
							FontSize float64 `json:"fontSize"`
						} `json:"style"`
					} `json:"runs"`
				} `json:"content"`
			} `json:"children"`
		} `json:"pages"`
	}
	if err := json.Unmarshal(got, &file); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(file.Pages) < 2 {
		t.Fatalf("expected a multi-page deck, got %d", len(file.Pages))
	}
	// Page 1 is the cover (impact), page 2 is content (reading): a deck whose
	// every page shares one background is the bug this guards.
	if reflect.DeepEqual(file.Pages[0].Background, file.Pages[1].Background) {
		t.Fatal("content page must not repeat the cover's background")
	}
	var maxSize float64
	for _, ch := range file.Pages[1].Children {
		if ch.Type != "text" {
			continue
		}
		for _, par := range ch.Content {
			for _, run := range par.Runs {
				if run.Style.FontSize > maxSize {
					maxSize = run.Style.FontSize
				}
			}
		}
	}
	// The old fixed scale topped out at 44px on a 1080-tall slide (~4%); the
	// geometry scale must put a title well past that.
	if maxSize < 60 {
		t.Fatalf("title type did not scale with the slot: max font size %v on a 1080-tall page", maxSize)
	}
}
