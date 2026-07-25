package httpapi

import (
	"strings"
	"testing"
)

// TestEmbedDesignFileAssets confirms image nodes, image fills, and nested images
// get their bytes inlined as data URLs across the file, without mutating the
// input (so the PNG/JPEG design exporter renders images referenced by asset id).
func TestEmbedDesignFileAssets(t *testing.T) {
	fetch := func(aid string) ([]byte, string, error) { return []byte("PNG-" + aid), "image/png", nil }
	file := map[string]any{
		"pages": []any{map[string]any{
			"children": []any{
				map[string]any{"type": "image", "source": map[string]any{"assetId": "a1"}},
				map[string]any{"type": "shape", "shape": "rect", "fills": []any{
					map[string]any{"type": "image", "source": map[string]any{"assetId": "a2"}},
				}},
				map[string]any{"type": "group", "children": []any{
					map[string]any{"type": "image", "source": map[string]any{"assetId": "a3"}},
				}},
			},
		}},
	}
	out := embedDesignFileAssets(fetch, file)
	kids := out["pages"].([]any)[0].(map[string]any)["children"].([]any)

	embedded := func(m map[string]any, what string) {
		if src, _ := m["src"].(string); !strings.HasPrefix(src, "data:image/png;base64,") {
			t.Fatalf("%s not embedded: %v", what, m["src"])
		}
	}
	embedded(kids[0].(map[string]any), "image node")
	embedded(kids[1].(map[string]any)["fills"].([]any)[0].(map[string]any), "image fill")
	embedded(kids[2].(map[string]any)["children"].([]any)[0].(map[string]any), "nested image")

	// Input is not mutated.
	orig := file["pages"].([]any)[0].(map[string]any)["children"].([]any)[0].(map[string]any)
	if _, has := orig["src"]; has {
		t.Fatalf("original file was mutated")
	}
	// nil fetch returns the file unchanged (no uploads service).
	if got := embedDesignFileAssets(nil, file); got == nil {
		t.Fatalf("nil fetch should return the file")
	}
}
