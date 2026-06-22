package brand

import (
	"encoding/json"
	"testing"
)

// kitRow builds a BrandKitRow from JSON fragments for the pure lint test.
func kitRow(palettes, fonts, logos, controls string) *BrandKitRow {
	return &BrandKitRow{
		Palettes: json.RawMessage(palettes),
		Fonts:    json.RawMessage(fonts),
		Logos:    json.RawMessage(logos),
		Controls: json.RawMessage(controls),
	}
}

func solidFill(r, g, b float64) map[string]any {
	return map[string]any{"type": "solid", "color": map[string]any{"srgb": map[string]any{"r": r, "g": g, "b": b, "a": 1.0}}}
}

func TestLintFile_OffBrandColorAndFont(t *testing.T) {
	// Brand: one swatch (pure red), one approved font, both locks on.
	kit := parseLintKit(kitRow(
		`[{"colors":[{"value":{"srgb":{"r":1,"g":0,"b":0,"a":1}}}]}]`,
		`[{"fontFamily":"Brand Sans","role":"body"}]`,
		`[]`,
		`{"lockColors":true,"lockFonts":true,"lintPolicy":"block"}`,
	))

	file := map[string]any{
		"meta": map[string]any{},
		"pages": []any{map[string]any{"id": "pg", "width": 800.0, "height": 600.0, "children": []any{
			// Off-brand blue fill.
			map[string]any{"id": "rect", "type": "shape", "fills": []any{solidFill(0, 0, 1)}},
			// Off-brand font.
			map[string]any{"id": "txt", "type": "text", "content": []any{
				map[string]any{"runs": []any{map[string]any{"text": "Hi", "style": map[string]any{"fontFamily": "Comic Sans"}}}},
			}},
		}}},
	}

	v := lintFile(file, kit)
	kinds := map[string]int{}
	for _, x := range v {
		kinds[x.Kind]++
	}
	if kinds["off-brand-color"] == 0 {
		t.Fatalf("expected off-brand-color, got %+v", v)
	}
	if kinds["off-brand-font"] == 0 {
		t.Fatalf("expected off-brand-font, got %+v", v)
	}

	// An on-brand color (matching swatch) is not flagged.
	file2 := map[string]any{"meta": map[string]any{}, "pages": []any{map[string]any{"id": "pg", "children": []any{
		map[string]any{"id": "rect", "type": "shape", "fills": []any{solidFill(1, 0, 0)}},
	}}}}
	for _, x := range lintFile(file2, kit) {
		if x.Kind == "off-brand-color" {
			t.Fatalf("on-brand color should not be flagged: %+v", x)
		}
	}
}

func TestLintFile_PolicyOffAndLocksOff(t *testing.T) {
	file := map[string]any{"meta": map[string]any{}, "pages": []any{map[string]any{"id": "pg", "children": []any{
		map[string]any{"id": "rect", "type": "shape", "fills": []any{solidFill(0, 0, 1)}},
	}}}}

	// policy off -> no violations at all.
	off := parseLintKit(kitRow(`[{"colors":[{"value":{"srgb":{"r":1,"g":0,"b":0,"a":1}}}]}]`, `[]`, `[]`, `{"lockColors":true,"lintPolicy":"off"}`))
	if len(lintFile(file, off)) != 0 {
		t.Fatal("policy off should produce no violations")
	}

	// locks off -> color not enforced (contrast/logo/spacing only, none here).
	warn := parseLintKit(kitRow(`[{"colors":[{"value":{"srgb":{"r":1,"g":0,"b":0,"a":1}}}]}]`, `[]`, `[]`, `{"lockColors":false,"lintPolicy":"warn"}`))
	for _, x := range lintFile(file, warn) {
		if x.Kind == "off-brand-color" {
			t.Fatal("lockColors off should not flag colors")
		}
	}
}
