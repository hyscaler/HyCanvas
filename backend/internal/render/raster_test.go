package render

import (
	"bytes"
	"image"
	"image/png"
	"testing"
)

func TestToPNG(t *testing.T) {
	data, err := ToPNG(sampleDesign(), 0, 1)
	if err != nil {
		t.Fatalf("ToPNG: %v", err)
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("decode png: %v", err)
	}
	b := img.Bounds()
	if b.Dx() != 200 || b.Dy() != 100 {
		t.Fatalf("png dimensions wrong: %dx%d", b.Dx(), b.Dy())
	}
	// The red rect (fill rgb(255,0,0)) sits at x[10..60], y[20..60]; sample center.
	r, g, bl, _ := img.At(30, 40).RGBA()
	if r>>8 < 200 || g>>8 > 60 || bl>>8 > 60 {
		t.Fatalf("expected red at (30,40), got r=%d g=%d b=%d", r>>8, g>>8, bl>>8)
	}
	// Background is white (top-left corner, away from any shape).
	wr, wg, wb, _ := img.At(190, 5).RGBA()
	if wr>>8 < 240 || wg>>8 < 240 || wb>>8 < 240 {
		t.Fatalf("expected white background, got r=%d g=%d b=%d", wr>>8, wg>>8, wb>>8)
	}
}

func TestToPNGScale(t *testing.T) {
	data, err := ToPNG(sampleDesign(), 0, 2)
	if err != nil {
		t.Fatalf("ToPNG x2: %v", err)
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("decode config: %v", err)
	}
	if cfg.Width != 400 || cfg.Height != 200 {
		t.Fatalf("scaled dimensions wrong: %dx%d", cfg.Width, cfg.Height)
	}
}

func TestToJPEG(t *testing.T) {
	data, err := ToJPEG(sampleDesign(), 0, 1, 80)
	if err != nil {
		t.Fatalf("ToJPEG: %v", err)
	}
	if _, _, err := image.Decode(bytes.NewReader(data)); err != nil {
		t.Fatalf("decode jpeg: %v", err)
	}
}

func TestRasterLinearGradientBackground(t *testing.T) {
	// A vertical (angle 90) red->blue gradient page background should render as a
	// real gradient: red near the top, blue near the bottom, not a flat color.
	col := func(r, g, b float64) map[string]any {
		return map[string]any{"srgb": map[string]any{"r": r, "g": g, "b": b, "a": 1.0}}
	}
	design := Design{"pages": []any{map[string]any{
		"width": 100.0, "height": 100.0,
		"background": map[string]any{
			"type": "gradient", "gradient": "linear", "angle": 90.0,
			"stops": []any{
				map[string]any{"position": 0.0, "color": col(1, 0, 0)},
				map[string]any{"position": 1.0, "color": col(0, 0, 1)},
			},
		},
		"children": []any{},
	}}}
	img, err := ToRaster(design, 0, 1)
	if err != nil {
		t.Fatalf("ToRaster: %v", err)
	}
	tr, _, tb, _ := img.At(50, 3).RGBA()
	br, _, bb, _ := img.At(50, 96).RGBA()
	if tr>>8 < 200 || tb>>8 > 60 {
		t.Fatalf("expected red near top, got r=%d b=%d", tr>>8, tb>>8)
	}
	if bb>>8 < 200 || br>>8 > 60 {
		t.Fatalf("expected blue near bottom, got r=%d b=%d", br>>8, bb>>8)
	}
}

func TestRasterEllipseGradient(t *testing.T) {
	// A gradient-filled ellipse must rasterize as a real gradient (not the flat
	// first stop), matching the other shapes and the SVG/editor output.
	col := func(r, g, b float64) map[string]any {
		return map[string]any{"srgb": map[string]any{"r": r, "g": g, "b": b, "a": 1.0}}
	}
	design := Design{"pages": []any{map[string]any{
		"width": 100.0, "height": 100.0,
		"children": []any{map[string]any{
			"type": "shape", "shape": "ellipse",
			"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
			"size":      map[string]any{"width": 100.0, "height": 100.0},
			"fills": []any{map[string]any{
				"type": "gradient", "gradient": "linear", "angle": 90.0,
				"stops": []any{
					map[string]any{"position": 0.0, "color": col(1, 0, 0)},
					map[string]any{"position": 1.0, "color": col(0, 0, 1)},
				},
			}},
		}},
	}}}
	img, err := ToRaster(design, 0, 1)
	if err != nil {
		t.Fatalf("ToRaster: %v", err)
	}
	// Center column is fully inside the ellipse: red near top, blue near bottom.
	tr, _, tb, _ := img.At(50, 12).RGBA()
	br, _, bb, _ := img.At(50, 88).RGBA()
	if tr>>8 < 180 || tb>>8 > 80 {
		t.Fatalf("expected red-ish near top of ellipse, got r=%d b=%d", tr>>8, tb>>8)
	}
	if bb>>8 < 180 || br>>8 > 80 {
		t.Fatalf("expected blue-ish near bottom of ellipse, got r=%d b=%d", br>>8, bb>>8)
	}
}

func TestRasterGradientStopAlpha(t *testing.T) {
	// A vertical gradient from opaque red to fully transparent red, over the white
	// page base, must fade from red (top) to white (bottom) - per-stop alpha is honored.
	col := func(r, g, b, a float64) map[string]any {
		return map[string]any{"srgb": map[string]any{"r": r, "g": g, "b": b, "a": a}}
	}
	design := Design{"pages": []any{map[string]any{
		"width": 100.0, "height": 100.0,
		"background": map[string]any{
			"type": "gradient", "gradient": "linear", "angle": 90.0,
			"stops": []any{
				map[string]any{"position": 0.0, "color": col(1, 0, 0, 1)},
				map[string]any{"position": 1.0, "color": col(1, 0, 0, 0)},
			},
		},
		"children": []any{},
	}}}
	img, err := ToRaster(design, 0, 1)
	if err != nil {
		t.Fatalf("ToRaster: %v", err)
	}
	tr, tg, tb, _ := img.At(50, 3).RGBA()
	br, bg, bb, _ := img.At(50, 97).RGBA()
	if tr>>8 < 200 || tg>>8 > 60 || tb>>8 > 60 {
		t.Fatalf("expected opaque red near top, got r=%d g=%d b=%d", tr>>8, tg>>8, tb>>8)
	}
	// Transparent-red stop over white => near white (all channels high).
	if br>>8 < 220 || bg>>8 < 220 || bb>>8 < 220 {
		t.Fatalf("expected ~white (transparent stop over white) near bottom, got r=%d g=%d b=%d", br>>8, bg>>8, bb>>8)
	}
}

func TestRasterPageRange(t *testing.T) {
	if _, err := ToPNG(sampleDesign(), 7, 1); err != ErrPageRange {
		t.Fatalf("out-of-range page should error, got %v", err)
	}
}

// A compound path (schema v15 contours) must cut a hole for the interior
// contour under the even-odd rule, even when both contours wind the same way.
func TestRasterCompoundPathHole(t *testing.T) {
	seg := func(x, y float64) map[string]any { return map[string]any{"x": x, "y": y} }
	design := Design{
		"pages": []any{
			map[string]any{
				"width": 100.0, "height": 100.0,
				"background": map[string]any{"type": "solid", "color": map[string]any{"srgb": map[string]any{"r": 1.0, "g": 1.0, "b": 1.0, "a": 1.0}}},
				"children": []any{
					map[string]any{
						"id": "p1", "type": "path", "closed": true,
						"size":      map[string]any{"width": 80.0, "height": 80.0},
						"transform": map[string]any{"x": 10.0, "y": 10.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
						// Outer square 0..80 and interior square 20..60, both clockwise.
						"segments": []any{seg(0, 0), seg(80, 0), seg(80, 80), seg(0, 80)},
						"contours": []any{map[string]any{
							"closed":   true,
							"segments": []any{seg(20, 20), seg(60, 20), seg(60, 60), seg(20, 60)},
						}},
						"fills": []any{map[string]any{"type": "solid", "color": map[string]any{"srgb": map[string]any{"r": 0.0, "g": 0.0, "b": 0.0, "a": 1.0}}}},
					},
				},
			},
		},
		"assets": []any{},
	}
	img, err := ToRaster(design, 0, 1)
	if err != nil {
		t.Fatalf("ToRaster: %v", err)
	}
	// The ring (between the contours) is black.
	r, g, b, _ := img.At(25, 50).RGBA()
	if r>>8 > 60 || g>>8 > 60 || b>>8 > 60 {
		t.Fatalf("expected black ring at (25,50), got r=%d g=%d b=%d", r>>8, g>>8, b>>8)
	}
	// The interior contour cut a hole: page background shows through.
	hr, hg, hb, _ := img.At(50, 50).RGBA()
	if hr>>8 < 240 || hg>>8 < 240 || hb>>8 < 240 {
		t.Fatalf("expected white hole at (50,50), got r=%d g=%d b=%d", hr>>8, hg>>8, hb>>8)
	}
}
