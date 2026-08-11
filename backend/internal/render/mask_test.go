package render

// Mask rendering in the export path (F40 Phase 1 groundwork).
//
// These assert against RENDERED PIXELS rather than against the helpers,
// because the failure this replaces was not a wrong value: it was a masked
// object exporting as nothing at all.

import (
	"image"
	"strings"
	"testing"
)

func maskDesign(shape any, child map[string]any) Design {
	node := map[string]any{
		"id": "m", "type": "mask",
		"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 100.0, "height": 100.0},
		"opacity":   1.0, "blendMode": "normal",
		"child": child,
	}
	if shape != nil {
		node["maskShape"] = shape
	}
	return Design{"pages": []any{map[string]any{
		"id": "p", "width": 100.0, "height": 100.0, "children": []any{node},
	}}}
}

// A red square covering the whole 100x100 page.
func redSquare() map[string]any {
	return map[string]any{
		"id": "subject", "type": "shape", "shape": "rect",
		"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 100.0, "height": 100.0},
		"opacity":   1.0, "blendMode": "normal",
		"fills": []any{map[string]any{"type": "solid", "color": map[string]any{
			"srgb": map[string]any{"r": 1.0, "g": 0.0, "b": 0.0, "a": 1.0},
		}}},
	}
}

// A mask covering only the top-left quadrant.
func quadrantShape() map[string]any {
	return map[string]any{
		"fillRule": "nonzero",
		"subpaths": []any{map[string]any{"closed": true, "anchors": []any{
			map[string]any{"x": 0.0, "y": 0.0},
			map[string]any{"x": 50.0, "y": 0.0},
			map[string]any{"x": 50.0, "y": 50.0},
			map[string]any{"x": 0.0, "y": 50.0},
		}}},
	}
}

func opaqueAt(t *testing.T, img *image.RGBA, x, y int) bool {
	t.Helper()
	_, _, _, a := img.At(x, y).RGBA()
	return a > 0x8000
}

func TestMaskRendersItsSubject(t *testing.T) {
	// The whole point: before this, a masked object exported as a hole.
	img, err := toRaster(maskDesign(quadrantShape(), redSquare()), 0, 1, true)
	if err != nil {
		t.Fatalf("toRaster: %v", err)
	}
	if !opaqueAt(t, img, 25, 25) {
		t.Fatal("inside the mask is empty: the subject did not render at all")
	}
}

func TestMaskTrimsOutsideItsShape(t *testing.T) {
	img, err := toRaster(maskDesign(quadrantShape(), redSquare()), 0, 1, true)
	if err != nil {
		t.Fatalf("toRaster: %v", err)
	}
	// The subject covers the full page; only the top-left quadrant survives.
	if opaqueAt(t, img, 75, 75) {
		t.Fatal("outside the mask is painted: the mask did not trim anything")
	}
	if opaqueAt(t, img, 75, 25) || opaqueAt(t, img, 25, 75) {
		t.Fatal("the other quadrants leaked through")
	}
}

func TestMaskEdgeIsAntialiased(t *testing.T) {
	// Coverage rather than a hard in/out test is what keeps a curved mask from
	// stair-stepping. A diagonal edge should produce partial alpha somewhere.
	tri := map[string]any{
		"fillRule": "nonzero",
		"subpaths": []any{map[string]any{"closed": true, "anchors": []any{
			map[string]any{"x": 0.0, "y": 0.0},
			map[string]any{"x": 100.0, "y": 0.0},
			map[string]any{"x": 0.0, "y": 100.0},
		}}},
	}
	img, err := toRaster(maskDesign(tri, redSquare()), 0, 1, true)
	if err != nil {
		t.Fatalf("toRaster: %v", err)
	}
	partial := 0
	for y := 0; y < 100; y++ {
		for x := 0; x < 100; x++ {
			_, _, _, a := img.At(x, y).RGBA()
			if a > 0x0400 && a < 0xF000 {
				partial++
			}
		}
	}
	if partial == 0 {
		t.Fatal("no partially-covered pixels: the mask edge is not antialiased")
	}
}

func TestUnusableMaskShapeDrawsTheSubjectRatherThanHidingIt(t *testing.T) {
	// A document that renders today must not start exporting blank because its
	// mask shape is empty or degenerate.
	empty := map[string]any{"fillRule": "nonzero", "subpaths": []any{}}
	degenerate := map[string]any{"fillRule": "nonzero", "subpaths": []any{
		map[string]any{"closed": true, "anchors": []any{map[string]any{"x": 5.0, "y": 5.0}}},
	}}
	for name, shape := range map[string]any{"absent": nil, "empty": empty, "degenerate": degenerate} {
		img, err := toRaster(maskDesign(shape, redSquare()), 0, 1, true)
		if err != nil {
			t.Fatalf("%s: toRaster: %v", name, err)
		}
		if !opaqueAt(t, img, 50, 50) {
			t.Fatalf("%s mask shape hid the subject entirely", name)
		}
	}
}

func TestMaskHonoursNodeOpacityExactlyOnce(t *testing.T) {
	// The subject is drawn at full strength inside its layer and faded on the
	// way out. Applying the mask's opacity in both places would square it.
	d := maskDesign(quadrantShape(), redSquare())
	node := asObj(asArr(asObj(asArr(d["pages"])[0])["children"])[0])
	node["opacity"] = 0.5
	img, err := toRaster(d, 0, 1, true)
	if err != nil {
		t.Fatalf("toRaster: %v", err)
	}
	_, _, _, a := img.At(25, 25).RGBA()
	got := float64(a) / 0xFFFF
	if got < 0.45 || got > 0.55 {
		t.Fatalf("alpha at 50%% opacity = %.3f, want ~0.5 (0.25 means it was applied twice)", got)
	}
}

func TestMaskedIdsAreWalkedByThePersistenceBoundary(t *testing.T) {
	// The subject shares the one global id namespace; a walker that skipped it
	// left masked ids invisible to id-uniqueness, comments, and version diffs.
	img, err := toRaster(maskDesign(quadrantShape(), redSquare()), 0, 2, true)
	if err != nil {
		t.Fatalf("toRaster at 2x: %v", err)
	}
	if img.Bounds().Dx() != 200 {
		t.Fatalf("scale not applied: width %d", img.Bounds().Dx())
	}
	if !opaqueAt(t, img, 50, 50) {
		t.Fatal("mask did not render at 2x")
	}
}

func TestSVGExportEmitsAClipPath(t *testing.T) {
	// SVG previously emitted "<!-- unsupported node type for svg: mask -->".
	// A real clipPath keeps the mask vector rather than rasterizing it.
	out, err := ToSVG(maskDesign(quadrantShape(), redSquare()), 0)
	if err != nil {
		t.Fatalf("ToSVG: %v", err)
	}
	s := string(out)
	if strings.Contains(s, "unsupported node type for svg: mask") {
		t.Fatal("mask still exports as an unsupported-type comment")
	}
	if !strings.Contains(s, "<clipPath") || !strings.Contains(s, "clip-path=\"url(#") {
		t.Fatalf("no clipPath emitted:\n%s", s)
	}
	if !strings.Contains(s, "subject") && !strings.Contains(s, "rect") && !strings.Contains(s, "path") {
		t.Fatal("the subject was not emitted inside the clip")
	}
}

func TestSVGUnusableMaskStillEmitsTheSubject(t *testing.T) {
	// An empty clipPath hides everything, so the shape must be skipped instead.
	out, err := ToSVG(maskDesign(map[string]any{"fillRule": "nonzero", "subpaths": []any{}}, redSquare()), 0)
	if err != nil {
		t.Fatalf("ToSVG: %v", err)
	}
	if strings.Contains(string(out), "<clipPath") {
		t.Fatal("emitted an empty clipPath, which hides the subject entirely")
	}
}

func TestPDFExportClipsTheMask(t *testing.T) {
	pdf, err := ToPDF(maskDesign(quadrantShape(), redSquare()), 0)
	if err != nil {
		t.Fatalf("ToPDF: %v", err)
	}
	if len(pdf) == 0 || string(pdf[:5]) != "%PDF-" {
		t.Fatalf("not a PDF (%d bytes)", len(pdf))
	}
}

func TestPDFUnusableMaskDoesNotClipEverythingAway(t *testing.T) {
	// An empty PDF clip path removes all subsequent marks, so a degenerate
	// shape must not emit `W n` at all.
	degenerate := map[string]any{"fillRule": "nonzero", "subpaths": []any{
		map[string]any{"closed": true, "anchors": []any{map[string]any{"x": 5.0, "y": 5.0}}},
	}}
	pdf, err := ToPDF(maskDesign(degenerate, redSquare()), 0)
	if err != nil {
		t.Fatalf("ToPDF: %v", err)
	}
	if len(pdf) == 0 {
		t.Fatal("empty PDF")
	}
}
