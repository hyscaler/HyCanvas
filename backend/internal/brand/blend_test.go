package brand

import "testing"

func TestBrandColourSpaceHoldsTintsShadesAndBlends(t *testing.T) {
	blue := rgb{0x1d / 255.0, 0x4e / 255.0, 0xd8 / 255.0}
	orange := rgb{0xf9 / 255.0, 0x73 / 255.0, 0x16 / 255.0}
	palette := []rgb{blue, orange}
	tint := lerp(brandWhite, blue, 0.13)  // a panel fill
	shade := lerp(blue, brandBlack, 0.35) // a dark ink of the hue
	blend := lerp(blue, orange, 0.5)      // a gradient's middle
	muted := lerp(shade, tint, 0.35)      // a caption: a blend of two derived colours
	for name, c := range map[string]rgb{"swatch": blue, "tint": tint, "shade": shade, "blend": blend, "muted": muted, "white": brandWhite, "black": brandBlack} {
		if !onBrand(c, palette) {
			t.Errorf("%s should be on brand (distance %.2f)", name, onBrandDistance(c, palette))
		}
	}
	green := rgb{0.2, 0.8, 0.3}
	if onBrand(green, palette) {
		t.Errorf("a foreign green must not pass (distance %.2f)", onBrandDistance(green, palette))
	}
}

func TestFindBrandViolationsAcceptsADerivedPalette(t *testing.T) {
	kit := BrandKit{Controls: BrandControls{LockColors: true}, Palettes: []byte(`[{"colors":[{"value":{"srgb":{"r":0.114,"g":0.306,"b":0.847,"a":1}}},{"value":{"srgb":{"r":0.976,"g":0.451,"b":0.086,"a":1}}}]}]`)}
	file := map[string]any{"pages": []any{map[string]any{
		"id":         "p1",
		"background": map[string]any{"type": "solid", "color": map[string]any{"srgb": map[string]any{"r": 0.885, "g": 0.910, "b": 0.980, "a": 1.0}}},
		"children": []any{
			map[string]any{"id": "n1", "type": "shape", "fills": []any{map[string]any{"type": "solid", "color": map[string]any{"srgb": map[string]any{"r": 0.074, "g": 0.199, "b": 0.551, "a": 1.0}}}}},
			map[string]any{"id": "n2", "type": "shape", "fills": []any{map[string]any{"type": "solid", "color": map[string]any{"srgb": map[string]any{"r": 0.2, "g": 0.8, "b": 0.3, "a": 1.0}}}}},
		},
	}}}
	vs := findBrandViolations(file, kit)
	if len(vs) != 1 || vs[0].NodeID != "n2" {
		t.Fatalf("want only the green shape flagged, got %+v", vs)
	}
}
