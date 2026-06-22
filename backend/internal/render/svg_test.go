package render

import (
	"strings"
	"testing"
)

func sampleDesign() Design {
	solid := func(r, g, b, a float64) map[string]any {
		return map[string]any{"type": "solid", "color": map[string]any{"srgb": map[string]any{"r": r, "g": g, "b": b, "a": a}}}
	}
	return Design{
		"pages": []any{
			map[string]any{
				"width": 200.0, "height": 100.0,
				"background": solid(1, 1, 1, 1),
				"children": []any{
					map[string]any{
						"id": "n1", "type": "shape", "shape": "rect",
						"size":      map[string]any{"width": 50.0, "height": 40.0},
						"transform": map[string]any{"x": 10.0, "y": 20.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
						"fills":     []any{solid(1, 0, 0, 1)},
					},
					map[string]any{
						"id": "n2", "type": "shape", "shape": "ellipse",
						"size":      map[string]any{"width": 30.0, "height": 30.0},
						"transform": map[string]any{"x": 100.0, "y": 10.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
						"fills": []any{map[string]any{
							"type": "gradient", "gradient": "linear", "angle": 90.0,
							"stops": []any{
								map[string]any{"position": 0.0, "color": map[string]any{"srgb": map[string]any{"r": 0.0, "g": 0.0, "b": 1.0, "a": 1.0}}},
								map[string]any{"position": 1.0, "color": map[string]any{"srgb": map[string]any{"r": 0.0, "g": 1.0, "b": 0.0, "a": 1.0}}},
							},
						}},
					},
					map[string]any{
						"id": "n3", "type": "shape", "shape": "star", "sides": 5.0, "innerRadius": 0.5,
						"size":      map[string]any{"width": 40.0, "height": 40.0},
						"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
						"fills":     []any{solid(0, 0, 0, 1)},
					},
					map[string]any{
						"id": "t1", "type": "text",
						"size":      map[string]any{"width": 80.0, "height": 20.0},
						"transform": map[string]any{"x": 5.0, "y": 60.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
						"content": []any{map[string]any{"runs": []any{
							map[string]any{"text": "Hi <there>", "style": map[string]any{"fontSize": 18.0, "fontFamily": "Inter", "fill": solid(0, 0, 0, 1)}},
						}}},
					},
				},
			},
		},
		"assets": []any{},
	}
}

func TestToSVG(t *testing.T) {
	svg, err := ToSVG(sampleDesign(), 0)
	if err != nil {
		t.Fatalf("ToSVG: %v", err)
	}
	must := []string{
		`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"`,
		`viewBox="0 0 200 100"`,
		`<rect x="0" y="0" width="50" height="40" fill="rgb(255,0,0)"`,
		`<ellipse cx="15" cy="15" rx="15" ry="15"`,
		`<linearGradient id="grad-1"`, // gradient def emitted
		`fill="url(#grad-1)"`,
		`<path d="M `, // star path
		`data-oc-id="n1"`,
		`transform="matrix(1,0,0,1,10,20)"`,
		`<text x="0"`,
		`Hi &lt;there&gt;`, // text escaped
		`font-size="18"`,
	}
	for _, m := range must {
		if !strings.Contains(svg, m) {
			t.Fatalf("svg missing %q\n---\n%s", m, svg)
		}
	}
	if _, err := ToSVG(sampleDesign(), 5); err != ErrPageRange {
		t.Fatalf("out-of-range page should error, got %v", err)
	}
}

func TestToSVGRotationMatrix(t *testing.T) {
	d := sampleDesign()
	// Rotate n1 by 90deg and verify the matrix is the R*S form.
	page := d["pages"].([]any)[0].(map[string]any)
	n1 := page["children"].([]any)[0].(map[string]any)
	n1["transform"].(map[string]any)["rotation"] = 90.0
	svg, _ := ToSVG(d, 0)
	// cos90=0, sin90=1 -> matrix(0,1,-1,0,10,20)
	if !strings.Contains(svg, "matrix(0,1,-1,0,10,20)") {
		t.Fatalf("90deg rotation matrix wrong:\n%s", svg)
	}
}
