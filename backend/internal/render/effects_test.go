package render

import (
	"image"
	"image/color"
	"math"
	"testing"
)

// The colour matrices must match the CSS filter functions the browser applies,
// or an image exports with different colour than the canvas shows.
func TestColorMatricesMatchCssFilters(t *testing.T) {
	apply := func(m colorMatrix, r, g, b float64) (float64, float64, float64) {
		return clamp01f(m[0]*r + m[1]*g + m[2]*b + m[4]),
			clamp01f(m[5]*r + m[6]*g + m[7]*b + m[9]),
			clamp01f(m[10]*r + m[11]*g + m[12]*b + m[14])
	}
	near := func(name string, got, want float64) {
		t.Helper()
		if math.Abs(got-want) > 0.002 {
			t.Errorf("%s = %.4f, want %.4f", name, got, want)
		}
	}
	// brightness(2) doubles.
	r, _, _ := apply(brightnessMatrix(2), 0.25, 0.25, 0.25)
	near("brightness(2)", r, 0.5)
	// contrast(0) collapses to mid grey.
	r, _, _ = apply(contrastMatrix(0), 1, 1, 1)
	near("contrast(0)", r, 0.5)
	// grayscale(1) yields the luminance for all three channels.
	r, g, b := apply(grayscaleMatrix(1), 1, 0, 0)
	near("grayscale r", r, 0.213)
	if math.Abs(r-g) > 1e-9 || math.Abs(g-b) > 1e-9 {
		t.Errorf("grayscale(1) did not equalize channels: %v %v %v", r, g, b)
	}
	// invert(1) flips.
	r, _, _ = apply(invertMatrix(1), 0.25, 0.25, 0.25)
	near("invert(1)", r, 0.75)
	// saturate(1) and hue-rotate(0) are identities.
	if saturateMatrix(1) != identityMatrix() {
		t.Error("saturate(1) is not the identity")
	}
	r, g, b = apply(hueRotateMatrix(0), 0.2, 0.4, 0.6)
	near("hue-rotate(0) r", r, 0.2)
	near("hue-rotate(0) g", g, 0.4)
	near("hue-rotate(0) b", b, 0.6)
	// A neutral slider must be a true no-op, for every extended op.
	for _, name := range []string{"exposure", "vibrance", "warmth", "temperature", "tint", "highlights", "shadows", "hue-rotate"} {
		m, blur, known := adjustmentMatrix(name, 0)
		if !known {
			t.Errorf("%s is not a known adjustment op", name)
		}
		if m != identityMatrix() || blur != 0 {
			t.Errorf("%s at its neutral value is not a no-op", name)
		}
	}
	// An unknown op is ignored rather than corrupting the stack.
	if _, _, known := adjustmentMatrix("not-a-real-op", 0.5); known {
		t.Error("an unknown adjustment op was treated as known")
	}
}

// Matrix composition must apply in sequence: the browser chains CSS filters, so
// order changes the result and the export has to chain them the same way.
func TestColorMatrixCompositionOrder(t *testing.T) {
	// invert then brightness(2) is not the same as brightness(2) then invert.
	a := invertMatrix(1).mul(brightnessMatrix(2))
	b := brightnessMatrix(2).mul(invertMatrix(1))
	if a == b {
		t.Fatal("matrix composition is order-independent, so it is not composing")
	}
	// invert(1) then invert(1) is the identity again.
	round := invertMatrix(1).mul(invertMatrix(1))
	for i, v := range round {
		want := identityMatrix()[i]
		if math.Abs(v-want) > 1e-9 {
			t.Fatalf("invert twice is not the identity at %d: %v want %v", i, v, want)
		}
	}
}

// applyColorMatrix works on straight colour and must leave alpha alone and skip
// fully transparent pixels (an effect must not tint empty space).
func TestApplyColorMatrixPreservesAlpha(t *testing.T) {
	l := image.NewRGBA(image.Rect(0, 0, 2, 1))
	// x=0: 50% white (premultiplied). x=1: fully transparent.
	l.Pix[0], l.Pix[1], l.Pix[2], l.Pix[3] = 128, 128, 128, 128
	applyColorMatrix(l, invertMatrix(1))
	got := l.RGBAAt(0, 0)
	if got.A != 128 {
		t.Fatalf("alpha changed: %+v", got)
	}
	// Straight colour was 1.0; inverted to 0, re-premultiplied to 0.
	if got.R > 3 {
		t.Fatalf("invert did not operate on straight colour: %+v", got)
	}
	if empty := l.RGBAAt(1, 0); empty.R != 0 || empty.A != 0 {
		t.Fatalf("a transparent pixel was tinted: %+v", empty)
	}
}

// Blur must spread coverage and preserve total energy roughly, and must not
// bleed colour out of transparent regions (which is why it runs premultiplied).
func TestBlurLayerSpreads(t *testing.T) {
	l := image.NewRGBA(image.Rect(0, 0, 64, 64))
	for y := 28; y < 36; y++ {
		for x := 28; x < 36; x++ {
			l.SetRGBA(x, y, color.RGBA{255, 0, 0, 255})
		}
	}
	blurLayer(l, 6)
	if c := l.RGBAAt(20, 32); c.A == 0 {
		t.Fatal("blur did not spread beyond the source region")
	}
	if c := l.RGBAAt(32, 32); c.A == 255 {
		t.Fatal("blur left the centre untouched")
	}
	// Colour must stay red-ish, not turn black from bleeding transparent pixels.
	c := l.RGBAAt(32, 32)
	if c.R <= c.G || c.R <= c.B {
		t.Fatalf("blur bled colour: %+v", c)
	}
}

// Duotone maps luminance onto the shadows/highlights ramp; at full intensity a
// mid-grey pixel must land between the two colours, and alpha is preserved.
func TestApplyDuotoneLayer(t *testing.T) {
	l := image.NewRGBA(image.Rect(0, 0, 1, 1))
	l.SetRGBA(0, 0, color.RGBA{128, 128, 128, 255})
	applyDuotoneLayer(l, map[string]any{
		"shadows":    map[string]any{"srgb": map[string]any{"r": 0.0, "g": 0.0, "b": 1.0, "a": 1.0}},
		"highlights": map[string]any{"srgb": map[string]any{"r": 1.0, "g": 0.0, "b": 0.0, "a": 1.0}},
		"intensity":  1.0,
	})
	got := l.RGBAAt(0, 0)
	if got.A != 255 {
		t.Fatalf("duotone changed alpha: %+v", got)
	}
	if got.G > 5 {
		t.Fatalf("duotone produced green from a blue/red ramp: %+v", got)
	}
	if got.R < 80 || got.B < 80 {
		t.Fatalf("mid grey did not land between the two ramp colours: %+v", got)
	}
	// Zero intensity is a no-op.
	l2 := image.NewRGBA(image.Rect(0, 0, 1, 1))
	l2.SetRGBA(0, 0, color.RGBA{10, 200, 30, 255})
	applyDuotoneLayer(l2, map[string]any{
		// A ramp that WOULD change the pixel if intensity were ignored, so the
		// zero-intensity guard is actually under test.
		"shadows":    map[string]any{"srgb": map[string]any{"r": 1.0, "g": 0.0, "b": 0.0, "a": 1.0}},
		"highlights": map[string]any{"srgb": map[string]any{"r": 0.0, "g": 0.0, "b": 1.0, "a": 1.0}},
		"intensity":  0.0,
	})
	if c := l2.RGBAAt(0, 0); c.G != 200 {
		t.Fatalf("zero-intensity duotone altered the pixel: %+v", c)
	}
}

// End to end: the effect kinds the editor writes must all reach the exported
// pixels. Each was previously ignored by the exporter while rendering on canvas.
func TestRasterHonorsRemainingEffects(t *testing.T) {
	col := func(r, g, b, a float64) map[string]any {
		return map[string]any{"srgb": map[string]any{"r": r, "g": g, "b": b, "a": a}}
	}
	render := func(effects []any) *image.RGBA {
		t.Helper()
		node := map[string]any{
			"id": "n1", "type": "shape", "shape": "rect",
			"transform": map[string]any{"x": 25.0, "y": 25.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
			"size":      map[string]any{"width": 50.0, "height": 50.0},
			"fills":     []any{map[string]any{"type": "solid", "color": col(1, 1, 1, 1)}},
		}
		if effects != nil {
			node["effects"] = effects
		}
		design := Design{"pages": []any{map[string]any{
			"width": 100.0, "height": 100.0,
			"background": map[string]any{"type": "solid", "color": col(0.5, 0.5, 0.5, 1)},
			"children":   []any{node},
		}}}
		img, err := toRaster(design, 0, 1, false)
		if err != nil {
			t.Fatalf("toRaster: %v", err)
		}
		return img
	}

	base := render(nil)
	if c := base.RGBAAt(50, 50); c.R < 250 {
		t.Fatalf("baseline square is not white: %+v", c)
	}

	// An adjustment (what every image filter preset writes) must change the pixels.
	adj := render([]any{map[string]any{"kind": "adjustment", "ops": []any{
		map[string]any{"name": "brightness", "value": 0.25},
	}}})
	if c := adj.RGBAAt(50, 50); c.R > 200 {
		t.Fatalf("brightness adjustment did not export: %+v", c)
	}

	// Duotone recolours the node.
	duo := render([]any{map[string]any{
		"kind": "duotone", "intensity": 1.0,
		"shadows": col(0, 0, 1, 1), "highlights": col(0, 0, 1, 1),
	}})
	if c := duo.RGBAAt(50, 50); c.B < 200 || c.R > 80 {
		t.Fatalf("duotone did not export: %+v", c)
	}

	// Blur softens the edge: a pixel just outside the square gains coverage.
	blur := render([]any{map[string]any{"kind": "blur", "radius": 6.0}})
	if bc, nc := blur.RGBAAt(50, 20), base.RGBAAt(50, 20); bc.R <= nc.R {
		t.Fatalf("blur did not spread past the shape edge: blurred %+v, sharp %+v", bc, nc)
	}

	// Glow paints a halo outside the shape.
	glow := render([]any{map[string]any{"kind": "glow", "radius": 10.0, "intensity": 1.0, "color": col(1, 0, 0, 1)}})
	if g, n := glow.RGBAAt(50, 18), base.RGBAAt(50, 18); g.R <= n.R || g.G >= n.G {
		t.Fatalf("glow did not export as a tinted halo: glow %+v, plain %+v", g, n)
	}

	// Outline strokes the node's BOX centred on its edge, which is what the
	// browser does (strokeRect with the effect width), so it straddles the
	// boundary and leaves the middle of the shape alone.
	out := render([]any{map[string]any{"kind": "outline", "width": 4.0, "color": col(1, 0, 0, 1)}})
	if e := out.RGBAAt(50, 25); e.R < 200 || e.G > 100 {
		t.Fatalf("outline did not stroke the box edge: %+v", e)
	}
	if in := out.RGBAAt(50, 50); in.R < 250 || in.G < 250 {
		t.Fatalf("outline covered the shape interior: %+v", in)
	}
	// Text consumes an outline as a glyph stroke in the browser, so the box
	// outline must NOT be drawn for text.
	textNode := map[string]any{
		"id": "t1", "type": "text",
		"transform": map[string]any{"x": 10.0, "y": 10.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 80.0, "height": 30.0},
		"effects":   []any{map[string]any{"kind": "outline", "width": 6.0, "color": col(1, 0, 0, 1)}},
		"content":   []any{},
	}
	timg, err := toRaster(Design{"pages": []any{map[string]any{
		"width": 100.0, "height": 100.0,
		"background": map[string]any{"type": "solid", "color": col(1, 1, 1, 1)},
		"children":   []any{textNode},
	}}}, 0, 1, false)
	if err != nil {
		t.Fatalf("toRaster(text): %v", err)
	}
	if c := timg.RGBAAt(10, 25); c.R > 250 && c.G < 100 {
		t.Fatalf("a text node was boxed by its outline effect: %+v", c)
	}
}
