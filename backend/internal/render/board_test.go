package render

import (
	"strings"
	"testing"
)

// boardDesign returns a whiteboard with two stickies, a labeled arrowed connector
// attaching them, and an ink stroke - the F30 board nodes that must export.
func boardDesign() Design {
	solid := func(r, g, b, a float64) map[string]any {
		return map[string]any{"type": "solid", "color": map[string]any{"srgb": map[string]any{"r": r, "g": g, "b": b, "a": a}}}
	}
	color := func(r, g, b, a float64) map[string]any {
		return map[string]any{"srgb": map[string]any{"r": r, "g": g, "b": b, "a": a}}
	}
	return Design{
		"meta": map[string]any{"kind": "whiteboard"},
		"pages": []any{
			map[string]any{
				"width": 600.0, "height": 400.0,
				"background": solid(1, 1, 1, 1),
				"children": []any{
					map[string]any{
						"id": "sa", "type": "sticky", "text": "First note",
						"size":      map[string]any{"width": 120.0, "height": 120.0},
						"transform": map[string]any{"x": 40.0, "y": 40.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
						"fill":      solid(1, 0.9, 0.4, 1), "textColor": color(0, 0, 0, 1), "fontScale": 1.0, "autoSize": true,
					},
					map[string]any{
						"id": "sb", "type": "sticky", "text": "Second",
						"size":      map[string]any{"width": 120.0, "height": 120.0},
						"transform": map[string]any{"x": 400.0, "y": 40.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
						"fill":      solid(0.7, 0.9, 1, 1), "textColor": color(0, 0, 0, 1), "fontScale": 1.0, "autoSize": true,
					},
					map[string]any{
						"id": "c1", "type": "connector", "route": "elbow",
						"start":     map[string]any{"attach": map[string]any{"nodeId": "sa", "anchor": "auto"}},
						"end":       map[string]any{"attach": map[string]any{"nodeId": "sb", "anchor": "auto"}},
						"size":      map[string]any{"width": 1.0, "height": 1.0},
						"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
						"stroke":    map[string]any{"fill": solid(0.28, 0.33, 0.41, 1), "width": 3.0},
						"endCap":    map[string]any{"kind": "arrow", "size": 12.0},
						"label":     map[string]any{"text": "leads to", "position": 0.5},
					},
					map[string]any{
						"id": "ik", "type": "ink", "smoothing": 0.5,
						"size":      map[string]any{"width": 100.0, "height": 60.0},
						"transform": map[string]any{"x": 60.0, "y": 240.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
						"brush":     map[string]any{"width": 6.0, "opacity": 1.0, "color": color(0.1, 0.1, 0.1, 1), "mode": "pen"},
						"points": []any{
							map[string]any{"x": 0.0, "y": 0.0},
							map[string]any{"x": 40.0, "y": 30.0},
							map[string]any{"x": 90.0, "y": 10.0},
						},
					},
				},
			},
		},
		"assets": []any{},
	}
}

func TestExportBoardNodesSVG(t *testing.T) {
	svg, err := ToSVG(boardDesign(), 0)
	if err != nil {
		t.Fatalf("ToSVG: %v", err)
	}
	must := []string{
		`data-oc-id="sa"`,         // sticky group present
		`First`,                   // sticky text rendered (wraps to fit the card)
		`data-oc-id="c1"`,         // connector present
		`<polyline`,               // connector (and ink) polyline drawn
		`leads to`,                // connector label rendered
		`<polygon`,                // arrowhead drawn
		`data-oc-id="ik"`,         // ink present
		`stroke="rgb(26,26,26)"`,  // ink-distinct stroke color (brush 0.1,0.1,0.1)
		`stroke="rgb(71,84,105)"`, // connector-distinct stroke color
		`stroke-linecap="round"`,  // ink/connector round stroke
	}
	for _, m := range must {
		if !strings.Contains(svg, m) {
			t.Fatalf("board SVG missing %q\n---\n%s", m, svg)
		}
	}
	// The connector must NOT be the "unsupported node" comment anymore.
	if strings.Contains(svg, "unsupported node type for svg: connector") {
		t.Fatal("connector still unsupported in SVG export")
	}
}

func TestExportBoardNodesPDFRaster(t *testing.T) {
	// Both must render without error and produce non-trivial output.
	pdf, err := ToPDF(boardDesign(), 0)
	if err != nil || len(pdf) < 200 {
		t.Fatalf("ToPDF board: err=%v len=%d", err, len(pdf))
	}
	img, err := ToRaster(boardDesign(), 0, 1)
	if err != nil {
		t.Fatalf("ToRaster board: %v", err)
	}
	rgb := func(x, y int) (int, int, int) {
		r, g, b, _ := img.At(x, y).RGBA()
		return int(r >> 8), int(g >> 8), int(b >> 8)
	}
	// Node-specific samples (scale 1, so page coords == pixels): the connector
	// line runs horizontally at y=100 between the stickies; sample left of the
	// label chip and assert it is the slate connector color (bluish: b > r).
	cr, cg, cb := rgb(200, 100)
	if cr > 0xf0 && cg > 0xf0 && cb > 0xf0 {
		t.Fatalf("connector corridor pixel is blank at (200,100): rgb=%d,%d,%d", cr, cg, cb)
	}
	if !(cb > cr) {
		t.Fatalf("connector pixel not the slate stroke color (expected b>r): rgb=%d,%d,%d", cr, cg, cb)
	}
	// The ink ribbon passes through its middle vertex at page (100,270); assert a
	// dark (near-black) ink pixel there.
	ir, ig, ib := rgb(100, 270)
	if !(ir < 90 && ig < 90 && ib < 90) {
		t.Fatalf("ink ribbon pixel not dark at (100,270): rgb=%d,%d,%d", ir, ig, ib)
	}
}
