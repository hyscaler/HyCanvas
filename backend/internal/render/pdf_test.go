package render

import (
	"bytes"
	"strings"
	"testing"
)

func TestToPDF(t *testing.T) {
	pdf, err := ToPDF(sampleDesign(), 0)
	if err != nil {
		t.Fatalf("ToPDF: %v", err)
	}
	if !bytes.HasPrefix(pdf, []byte("%PDF-1.7")) {
		t.Fatal("missing PDF header")
	}
	s := string(pdf)
	for _, m := range []string{
		"/Type /Catalog", "/Type /Pages", "/Type /Page",
		"/MediaBox [0 0 200 100]", "/BaseFont /Helvetica",
		" re\n", // rect op (background + rect node)
		" Tj\n", // text op
		" c\n",  // ellipse/curve op
		"xref", "trailer", "startxref",
	} {
		if !strings.Contains(s, m) {
			t.Fatalf("pdf missing %q", m)
		}
	}
	if !strings.HasSuffix(strings.TrimSpace(s), "%%EOF") {
		t.Fatal("missing EOF trailer")
	}
	// The single xref free entry + one entry per object must be present.
	if !strings.Contains(s, "0000000000 65535 f") {
		t.Fatal("missing xref free entry")
	}
	if _, err := ToPDF(sampleDesign(), 9); err != ErrPageRange {
		t.Fatalf("out-of-range page should error, got %v", err)
	}
}

// Blend/opacity parity (F38): the PDF must carry /BM and /ca graphics states
// for nodes that blend or fade, instead of silently flattening them.
func TestPDFEmitsBlendAndOpacityGState(t *testing.T) {
	col := func(r, g, b float64) map[string]any {
		return map[string]any{"srgb": map[string]any{"r": r, "g": g, "b": b, "a": 1.0}}
	}
	design := Design{"pages": []any{map[string]any{
		"width": 200.0, "height": 100.0,
		"background": map[string]any{"type": "solid", "color": col(1, 1, 1)},
		"children": []any{map[string]any{
			"id": "n1", "type": "shape", "shape": "rect",
			"transform": map[string]any{"x": 10.0, "y": 10.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
			"size":      map[string]any{"width": 50.0, "height": 40.0},
			"fills":     []any{map[string]any{"type": "solid", "color": col(1, 0, 0)}},
			"blendMode": "multiply",
			"opacity":   0.5,
		}},
	}}}
	pdf, err := ToPDF(design, 0, nil)
	if err != nil {
		t.Fatalf("ToPDF: %v", err)
	}
	out := string(pdf)
	if !strings.Contains(out, "/BM /Multiply") {
		t.Error("blend mode /BM missing from the PDF")
	}
	if !strings.Contains(out, "/ca 0.5") || !strings.Contains(out, "/CA 0.5") {
		t.Error("node opacity /ca missing from the PDF")
	}
	if !strings.Contains(out, "/ExtGState") || !strings.Contains(out, " gs\n") {
		t.Error("graphics state not referenced by the content stream")
	}
}

// Opacity multiplies down the ancestor chain: a child's gs REPLACES the
// inherited alpha in PDF, so a node inside a half-opaque group must bake the
// product into its own /ca (parity with the raster path).
func TestPDFNestedOpacityMultiplies(t *testing.T) {
	col := func(r, g, b float64) map[string]any {
		return map[string]any{"srgb": map[string]any{"r": r, "g": g, "b": b, "a": 1.0}}
	}
	design := Design{"pages": []any{map[string]any{
		"width": 200.0, "height": 100.0,
		"background": map[string]any{"type": "solid", "color": col(1, 1, 1)},
		"children": []any{map[string]any{
			"id": "g1", "type": "group",
			"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
			"size":      map[string]any{"width": 100.0, "height": 100.0},
			"opacity":   0.5,
			"children": []any{map[string]any{
				"id": "n1", "type": "shape", "shape": "rect",
				"transform": map[string]any{"x": 10.0, "y": 10.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
				"size":      map[string]any{"width": 50.0, "height": 40.0},
				"fills":     []any{map[string]any{"type": "solid", "color": col(1, 0, 0)}},
				"opacity":   0.8,
			}},
		}},
	}}}
	pdf, err := ToPDF(design, 0, nil)
	if err != nil {
		t.Fatalf("ToPDF: %v", err)
	}
	out := string(pdf)
	if !strings.Contains(out, "/ca 0.4") {
		t.Error("child /ca should be 0.5*0.8=0.4, the effective opacity")
	}
	if !strings.Contains(out, "/ca 0.5") {
		t.Error("group's own /ca 0.5 missing")
	}
}

// The v18 first-class `language` wins over the legacy `meta.language`.
func TestPDFLangPrefersFirstClassField(t *testing.T) {
	file := Design{"language": "hi-IN", "meta": map[string]any{"language": "fr-FR"}}
	if got := pdfLang(file); got != "hi-IN" {
		t.Fatalf("pdfLang = %q, want hi-IN", got)
	}
	legacy := Design{"meta": map[string]any{"language": "fr-FR"}}
	if got := pdfLang(legacy); got != "fr-FR" {
		t.Fatalf("pdfLang legacy = %q, want fr-FR", got)
	}
	if got := pdfLang(Design{}); got != "en-US" {
		t.Fatalf("pdfLang unset = %q, want en-US", got)
	}
}

// Gradient parity (F38): linear/radial fills paint as real shadings clipped
// to the path instead of flattening to the first stop.
func TestPDFEmitsGradientShading(t *testing.T) {
	col := func(r, g, b float64) map[string]any {
		return map[string]any{"srgb": map[string]any{"r": r, "g": g, "b": b, "a": 1.0}}
	}
	design := Design{"pages": []any{map[string]any{
		"width": 200.0, "height": 100.0,
		"background": map[string]any{"type": "solid", "color": col(1, 1, 1)},
		"children": []any{
			map[string]any{
				"id": "n1", "type": "shape", "shape": "rect",
				"transform": map[string]any{"x": 10.0, "y": 10.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
				"size":      map[string]any{"width": 50.0, "height": 40.0},
				"stroke":    map[string]any{"width": 2.0, "fill": map[string]any{"type": "solid", "color": col(0, 0, 0)}},
				"fills": []any{map[string]any{
					"type": "gradient", "gradient": "linear", "angle": 90.0,
					"stops": []any{
						map[string]any{"position": 0.0, "color": col(1, 0, 0)},
						map[string]any{"position": 0.5, "color": col(0, 1, 0)},
						map[string]any{"position": 1.0, "color": col(0, 0, 1)},
					},
				}},
			},
			map[string]any{
				"id": "n2", "type": "shape", "shape": "ellipse",
				"transform": map[string]any{"x": 100.0, "y": 10.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
				"size":      map[string]any{"width": 60.0, "height": 40.0},
				"fills": []any{map[string]any{
					"type": "gradient", "gradient": "radial",
					"stops": []any{
						map[string]any{"position": 0.0, "color": col(1, 1, 0)},
						map[string]any{"position": 1.0, "color": col(0, 0, 0)},
					},
				}},
			},
		},
	}}}
	pdf, err := ToPDF(design, 0, nil)
	if err != nil {
		t.Fatalf("ToPDF: %v", err)
	}
	out := string(pdf)
	for _, want := range []string{
		"/ShadingType 2",  // linear axial
		"/ShadingType 3",  // radial
		"/FunctionType 3", // 3-stop ramp needs a stitching function
		"/Sh0 sh",         // shading painted in the content stream
		"/Shading <<",     // page resources carry the dicts
		"W n",             // fill clipped to the path
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in PDF output", want)
		}
	}
	if !strings.Contains(out, "\nS\n") {
		t.Error("gradient-filled rect lost its stroke")
	}
}

// Raster effect layers (F38): a shadow becomes an embedded image UNDERLAY
// beneath the still-vector body; a layer blur REPLACES the body with the
// processed raster; a blurred text node stays vector (text extraction wins).
func TestPDFEmbedsRasterEffectLayers(t *testing.T) {
	col := func(r, g, b float64) map[string]any {
		return map[string]any{"srgb": map[string]any{"r": r, "g": g, "b": b, "a": 1.0}}
	}
	base := func(children ...any) Design {
		return Design{"pages": []any{map[string]any{
			"width": 200.0, "height": 100.0,
			"background": map[string]any{"type": "solid", "color": col(1, 1, 1)},
			"children":   children,
		}}}
	}
	rect := func(effects ...any) map[string]any {
		return map[string]any{
			"id": "n1", "type": "shape", "shape": "rect",
			"transform": map[string]any{"x": 40.0, "y": 30.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
			"size":      map[string]any{"width": 50.0, "height": 40.0},
			"fills":     []any{map[string]any{"type": "solid", "color": col(1, 0, 0)}},
			"effects":   effects,
		}
	}

	// Shadow: underlay image + the vector rect both present.
	pdf, err := ToPDF(base(rect(map[string]any{"kind": "shadow", "offsetX": 6.0, "offsetY": 6.0, "blur": 10.0, "color": col(0, 0, 0)})), 0, nil)
	if err != nil {
		t.Fatalf("ToPDF shadow: %v", err)
	}
	out := string(pdf)
	if !strings.Contains(out, "/Im0 Do") || !strings.Contains(out, "/XObject") {
		t.Error("shadow underlay image missing from the PDF")
	}
	if !strings.Contains(out, "0 0 50 40 re") {
		t.Error("the vector body should survive a shadow (only the underlay rasterizes)")
	}

	// Layer blur: the body is replaced by the processed raster.
	pdf, err = ToPDF(base(rect(map[string]any{"kind": "blur", "radius": 6.0})), 0, nil)
	if err != nil {
		t.Fatalf("ToPDF blur: %v", err)
	}
	out = string(pdf)
	if !strings.Contains(out, "/Im0 Do") {
		t.Error("blurred body raster missing")
	}
	if strings.Contains(out, "0 0 50 40 re") {
		t.Error("blurred body should not also draw its vector rect")
	}

	// Blurred TEXT keeps its vector glyphs (and simply drops the blur).
	text := map[string]any{
		"id": "t1", "type": "text",
		"transform": map[string]any{"x": 10.0, "y": 10.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 100.0, "height": 30.0},
		"content": []any{map[string]any{"runs": []any{map[string]any{
			"text": "Keep me searchable", "style": map[string]any{"fontSize": 16.0, "fontFamily": "Inter", "fill": map[string]any{"type": "solid", "color": col(0, 0, 0)}},
		}}}},
		"effects": []any{map[string]any{"kind": "blur", "radius": 5.0}},
	}
	pdf, err = ToPDF(base(text), 0, nil)
	if err != nil {
		t.Fatalf("ToPDF text: %v", err)
	}
	out = string(pdf)
	if strings.Contains(out, "/Im0 Do") {
		t.Error("text subtree must not rasterize")
	}
	if !strings.Contains(out, "Keep me searchable") && !strings.Contains(out, "Tj") {
		t.Error("text body lost its glyph operators")
	}
}

// Review fixes: an ancestor at opacity 0 keeps its subtree invisible; a
// blend+shadow node composes ONE layer (no blending against its own shadow);
// a node type the PDF body path cannot draw rasterizes wholesale instead of
// leaving an orphan shadow.
func TestPDFEffectEdgeCases(t *testing.T) {
	col := func(r, g, b float64) map[string]any {
		return map[string]any{"srgb": map[string]any{"r": r, "g": g, "b": b, "a": 1.0}}
	}
	page := func(children ...any) Design {
		return Design{"pages": []any{map[string]any{
			"width": 200.0, "height": 100.0,
			"background": map[string]any{"type": "solid", "color": col(1, 1, 1)},
			"children":   children,
		}}}
	}

	// Opacity-0 ancestor: the child's gs must carry /ca 0, not 0.8.
	pdf, err := ToPDF(page(map[string]any{
		"id": "g1", "type": "group", "opacity": 0.0,
		"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 100.0, "height": 100.0},
		"children": []any{map[string]any{
			"id": "n1", "type": "shape", "shape": "rect", "opacity": 0.8,
			"transform": map[string]any{"x": 10.0, "y": 10.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
			"size":      map[string]any{"width": 50.0, "height": 40.0},
			"fills":     []any{map[string]any{"type": "solid", "color": col(1, 0, 0)}},
		}},
	}), 0, nil)
	if err != nil {
		t.Fatalf("ToPDF opacity-0: %v", err)
	}
	if strings.Contains(string(pdf), "/ca 0.8") {
		t.Error("child inside an opacity-0 group must not resurrect at /ca 0.8")
	}

	// Blend + shadow: one composed image, no separate vector rect that would
	// blend against its own shadow underlay.
	pdf, err = ToPDF(page(map[string]any{
		"id": "n2", "type": "shape", "shape": "rect", "blendMode": "multiply",
		"transform": map[string]any{"x": 40.0, "y": 30.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 50.0, "height": 40.0},
		"fills":     []any{map[string]any{"type": "solid", "color": col(1, 0.6, 0.2)}},
		"effects":   []any{map[string]any{"kind": "shadow", "offsetX": 0.0, "offsetY": 0.0, "blur": 20.0, "color": col(0, 0, 0)}},
	}), 0, nil)
	if err != nil {
		t.Fatalf("ToPDF blend+shadow: %v", err)
	}
	out := string(pdf)
	if !strings.Contains(out, "/Im0 Do") {
		t.Error("blend+shadow should compose into one raster layer")
	}
	if strings.Contains(out, "0 0 50 40 re") {
		t.Error("blend+shadow must not also draw the vector body (it would blend against its own shadow)")
	}
	if !strings.Contains(out, "/BM /Multiply") {
		t.Error("the composed layer must still blend")
	}

	// A chart (not drawable by the PDF body path) with a shadow must not
	// leave an orphan underlay: the whole node rasterizes.
	pdf, err = ToPDF(page(map[string]any{
		"id": "c1", "type": "chart", "chart": "bar",
		"transform": map[string]any{"x": 20.0, "y": 20.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 120.0, "height": 60.0},
		"series":    []any{map[string]any{"values": []any{1.0, 3.0, 2.0}}},
		"effects":   []any{map[string]any{"kind": "shadow", "offsetX": 4.0, "offsetY": 4.0, "blur": 8.0, "color": col(0, 0, 0)}},
	}), 0, nil)
	if err != nil {
		t.Fatalf("ToPDF chart: %v", err)
	}
	out = string(pdf)
	ims := strings.Count(out, " Do\n")
	if ims != 1 {
		t.Errorf("chart+shadow should draw exactly one composed image, got %d Do ops", ims)
	}
}
