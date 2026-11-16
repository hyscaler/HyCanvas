package render

import "testing"

// A design font the server has no file for exports in the embedded fallback,
// which used to happen silently (#85). The renderer names each such family
// once, so an operator can see which fonts to put in FONTS_DIR.
func TestMissingFontFamilyIsReportedOnce(t *testing.T) {
	const family = "Unregistered Display Face"
	if lookupFont(family, 400) != nil {
		t.Skip("the test family is registered in this process")
	}
	var reported []string
	SetMissingFamilyReporter(func(f string) { reported = append(reported, f) })
	t.Cleanup(func() { SetMissingFamilyReporter(nil) })

	col := map[string]any{"srgb": map[string]any{"r": 0.0, "g": 0.0, "b": 0.0, "a": 1.0}}
	text := func(id string) map[string]any {
		return map[string]any{
			"id": id, "type": "text",
			"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
			"size":      map[string]any{"width": 200.0, "height": 40.0},
			"content": []any{map[string]any{
				"runs":  []any{map[string]any{"text": "Hello", "style": map[string]any{"fontSize": 20.0, "fontFamily": family, "fill": map[string]any{"type": "solid", "color": col}}}},
				"style": map[string]any{"direction": "auto"},
			}},
		}
	}
	design := Design{"pages": []any{map[string]any{
		"width": 200.0, "height": 80.0,
		"children": []any{text("a"), text("b")},
	}}}
	for i := 0; i < 2; i++ {
		if _, err := toRaster(design, 0, 1, false); err != nil {
			t.Fatalf("toRaster: %v", err)
		}
	}
	if len(reported) != 1 || reported[0] != family {
		t.Fatalf("reported %q, want exactly [%q]", reported, family)
	}
}

// The stock templates' fonts ship in the binary (#85), so a template exported
// from the server keeps its fonts with no FONTS_DIR. Every family the template
// seed names must resolve, and drawing in it must differ from the fallback.
func TestStockTemplateFontsAreBuiltIn(t *testing.T) {
	for _, fam := range []string{"Outfit", "Caveat", "Playfair Display", "Bebas Neue", "JetBrains Mono"} {
		if lookupFont(fam, 700) == nil {
			t.Errorf("%s: no built-in face", fam)
		}
	}
	if StockFontFamilies() < 100 {
		t.Fatalf("only %d stock families embedded", StockFontFamilies())
	}

	col := map[string]any{"srgb": map[string]any{"r": 0.0, "g": 0.0, "b": 0.0, "a": 1.0}}
	draw := func(family string) []uint8 {
		d := Design{"pages": []any{map[string]any{
			"width": 300.0, "height": 80.0,
			"children": []any{map[string]any{
				"id": "t", "type": "text",
				"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
				"size":      map[string]any{"width": 300.0, "height": 80.0},
				"content": []any{map[string]any{
					"runs":  []any{map[string]any{"text": "Handwriting", "style": map[string]any{"fontSize": 40.0, "fontFamily": family, "fill": map[string]any{"type": "solid", "color": col}}}},
					"style": map[string]any{"direction": "auto"},
				}},
			}},
		}}}
		img, err := toRaster(d, 0, 1, false)
		if err != nil {
			t.Fatalf("toRaster: %v", err)
		}
		return img.Pix
	}
	if string(draw("Caveat")) == string(draw("No Such Family Here")) {
		t.Fatal("Caveat rendered exactly like the fallback font")
	}
}
