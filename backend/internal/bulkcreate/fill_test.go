package bulkcreate

import "testing"

func sampleFile() map[string]any {
	return map[string]any{
		"pages": []any{
			map[string]any{"id": "p1", "children": []any{
				map[string]any{"id": "title", "type": "text", "content": []any{
					map[string]any{"runs": []any{map[string]any{"text": "Old", "style": map[string]any{"bold": true}}}},
				}},
				map[string]any{"id": "logo", "type": "image", "source": map[string]any{"assetId": "old", "naturalWidth": 100, "naturalHeight": 50}, "crop": map[string]any{"x": 1}},
			}},
		},
	}
}

func TestApplyFill(t *testing.T) {
	file := sampleFile()
	out := ApplyFill(file, FillValues{
		"title": {Text: "New Title"},
		"logo":  {ImageURL: "https://x/y.png"},
	})

	// Source untouched (deep clone).
	srcRun := file["pages"].([]any)[0].(map[string]any)["children"].([]any)[0].(map[string]any)["content"].([]any)[0].(map[string]any)["runs"].([]any)[0].(map[string]any)
	if srcRun["text"] != "Old" {
		t.Fatalf("source mutated: %v", srcRun["text"])
	}

	children := out["pages"].([]any)[0].(map[string]any)["children"].([]any)
	run := children[0].(map[string]any)["content"].([]any)[0].(map[string]any)["runs"].([]any)[0].(map[string]any)
	if run["text"] != "New Title" {
		t.Fatalf("text not filled: %v", run["text"])
	}
	if asObj(run["style"])["bold"] != true {
		t.Fatalf("run style not preserved: %+v", run)
	}
	img := children[1].(map[string]any)
	src := img["source"].(map[string]any)
	if src["assetId"] != "https://x/y.png" {
		t.Fatalf("image source not filled: %+v", src)
	}
	if _, hasCrop := img["crop"]; hasCrop {
		t.Fatal("crop should be cleared on new source")
	}
}

func TestValidateFillRow(t *testing.T) {
	fields := []Field{
		{NodeID: "title", Kind: "text", Label: "Title", Constraints: map[string]any{"required": true, "maxChars": float64(5)}},
	}
	if ok, _ := ValidateFillRow(fields, FillValues{"title": {Text: "Hi"}}); !ok {
		t.Fatal("valid row should pass")
	}
	if ok, reason := ValidateFillRow(fields, FillValues{}); ok || reason == "" {
		t.Fatal("missing required should fail")
	}
	if ok, _ := ValidateFillRow(fields, FillValues{"title": {Text: "TooLong"}}); ok {
		t.Fatal("over maxChars should fail")
	}
}

func TestRenderTitle(t *testing.T) {
	fields := []Field{{NodeID: "n1", Kind: "text", Label: "Name"}}
	row := map[string]string{"n1": "Acme"}
	// By label.
	if got := renderTitle("{Name} card", fields, row, "Base", 0); got != "Acme card" {
		t.Fatalf("by-label: %q", got)
	}
	// By nodeId.
	if got := renderTitle("{n1}", fields, row, "Base", 0); got != "Acme" {
		t.Fatalf("by-nodeId: %q", got)
	}
	// Fallback when empty.
	if got := renderTitle("", fields, row, "Base", 2); got != "Base 3" {
		t.Fatalf("fallback: %q", got)
	}
}
