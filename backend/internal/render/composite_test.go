package render

import (
	"image"
	"image/color"
	"math"
	"testing"
)

// unitXform is the identity offset transform (no scale, no rotation).
func unitXform() offsetXform { return offsetXform{a: 1, d: 1, scale: 1} }

// fill paints the whole image with one opaque color.
func fill(img *image.RGBA, c color.RGBA) {
	for i := 0; i < len(img.Pix); i += 4 {
		img.Pix[i+0], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = c.R, c.G, c.B, c.A
	}
}

// The blend maths must match what Canvas2D computes for the same two colors, or
// a design's export stops matching its canvas. These are the W3C reference
// results for a mid-grey source over a known backdrop.
func TestBlendChannelMatchesSpec(t *testing.T) {
	const cb, cs = 0.5, 0.25
	cases := map[string]float64{
		"normal":      0.25,
		"multiply":    0.125,
		"screen":      0.625,
		"darken":      0.25,
		"lighten":     0.5,
		"difference":  0.25,
		"exclusion":   0.5,
		"color-dodge": 0.6666666667,
		"color-burn":  0.0,
		"hard-light":  0.25,
	}
	for mode, want := range cases {
		if got := blendChannel(mode, cb, cs); math.Abs(got-want) > 1e-6 {
			t.Errorf("blendChannel(%s, %v, %v) = %v, want %v", mode, cb, cs, got, want)
		}
	}
	// A second sample where the modes DIFFER from plain source (cs). At
	// (0.5, 0.25) darken and difference both happen to equal cs, so a single
	// sample cannot tell them from a missing case arm.
	for _, c := range []struct {
		mode string
		want float64
	}{
		{"darken", 0.25},
		{"lighten", 0.75},
		{"difference", 0.5},
		{"exclusion", 0.625},
		{"multiply", 0.1875},
		{"screen", 0.8125},
	} {
		if got := blendChannel(c.mode, 0.25, 0.75); math.Abs(got-c.want) > 1e-6 {
			t.Errorf("%s(0.25, 0.75) = %v, want %v", c.mode, got, c.want)
		}
	}

	// overlay is hard-light with the operands swapped, so it must be sampled
	// where the two DIFFER: at cb=0.5, cs=0.25 both give 0.25 and a broken
	// delegation would pass unnoticed.
	if got := blendChannel("overlay", 0.25, 0.75); math.Abs(got-0.375) > 1e-6 {
		t.Errorf("overlay(0.25, 0.75) = %v, want 0.375 (hard-light with operands swapped)", got)
	}
	if blendChannel("overlay", 0.25, 0.75) == blendChannel("hard-light", 0.25, 0.75) {
		t.Error("overlay is not swapping its operands")
	}
	// soft-light, across both branches of its piecewise definition.
	for _, c := range []struct{ cb, cs, want float64 }{
		{0.5, 0.25, 0.375},      // cs <= 0.5 branch
		{0.5, 0.75, 0.60355339}, // cs > 0.5, cb > 0.25 branch
		{0.16, 0.75, 0.279168},  // cs > 0.5, cb <= 0.25 branch (the D(Cb) polynomial)
	} {
		if got := blendChannel("soft-light", c.cb, c.cs); math.Abs(got-c.want) > 1e-6 {
			t.Errorf("soft-light(%v, %v) = %.8f, want %.8f", c.cb, c.cs, got, c.want)
		}
	}

	// Edge cases the formulas special-case.
	if got := blendChannel("color-dodge", 0, 0.5); got != 0 {
		t.Errorf("color-dodge on a black backdrop = %v, want 0", got)
	}
	if got := blendChannel("color-burn", 1, 0.5); got != 1 {
		t.Errorf("color-burn on a white backdrop = %v, want 1", got)
	}
}

// multiply is the mode users reach for most; a red source over a grey backdrop
// must darken, and the result must be the product of the two.
func TestCompositeLayerMultiply(t *testing.T) {
	r := image.Rect(0, 0, 4, 4)
	dst := image.NewRGBA(r)
	fill(dst, color.RGBA{128, 128, 128, 255})
	src := image.NewRGBA(r)
	fill(src, color.RGBA{255, 0, 0, 255})

	compositeLayer(dst, src, "multiply")

	got := dst.RGBAAt(1, 1)
	// 0.5 * 1.0 = 0.5 red, 0.5 * 0 = 0 green/blue.
	if got.R < 126 || got.R > 130 || got.G != 0 || got.B != 0 || got.A != 255 {
		t.Fatalf("multiply = %+v, want ~{128 0 0 255}", got)
	}
}

// A blend has nothing to mix with where the page is empty, so the source must
// come through unchanged rather than blending against transparent black.
func TestCompositeLayerOverTransparentBackdrop(t *testing.T) {
	r := image.Rect(0, 0, 2, 2)
	dst := image.NewRGBA(r) // fully transparent
	src := image.NewRGBA(r)
	fill(src, color.RGBA{200, 100, 50, 255})

	compositeLayer(dst, src, "multiply")

	got := dst.RGBAAt(0, 0)
	if got.R != 200 || got.G != 100 || got.B != 50 || got.A != 255 {
		t.Fatalf("multiply over an empty page = %+v, want the source unchanged", got)
	}
}

// normal must behave exactly like plain source-over, so routing a node through
// the layer path can never change how it looks.
func TestCompositeLayerNormalIsSourceOver(t *testing.T) {
	r := image.Rect(0, 0, 2, 2)
	dst := image.NewRGBA(r)
	fill(dst, color.RGBA{0, 0, 255, 255})
	src := image.NewRGBA(r)
	// 50% white, premultiplied.
	for i := 0; i < len(src.Pix); i += 4 {
		src.Pix[i+0], src.Pix[i+1], src.Pix[i+2], src.Pix[i+3] = 128, 128, 128, 128
	}
	compositeLayer(dst, src, "normal")
	got := dst.RGBAAt(0, 0)
	// 0.5 white over blue: r=g=0.5, b = 0.5 + 0.5*1
	if got.R < 126 || got.R > 130 || got.B < 253 {
		t.Fatalf("normal composite = %+v, want ~{128 128 255 255}", got)
	}
}

// The shadow is the node's silhouette, offset, blurred, and tinted. It must land
// where the offset says and must not paint where the node itself is opaque.
func TestDrawShadowsOffsetsAndTints(t *testing.T) {
	r := image.Rect(0, 0, 32, 32)
	page := image.NewRGBA(r)
	layer := image.NewRGBA(r)
	// An opaque 8x8 square at (8,8).
	for y := 8; y < 16; y++ {
		for x := 8; x < 16; x++ {
			layer.SetRGBA(x, y, color.RGBA{255, 255, 255, 255})
		}
	}
	shadows := []shadowSpec{{dx: 6, dy: 6, blur: 0, col: color.RGBA{255, 0, 0, 255}, opacity: 1}}
	drawShadows(page, layer, shadows, unitXform(), 1)

	// Offset by (6,6): the shadow covers (14,14) and not (8,8).
	if got := page.RGBAAt(16, 16); got.R < 250 || got.A < 250 {
		t.Fatalf("shadow missing at its offset position: %+v", got)
	}
	if got := page.RGBAAt(9, 9); got.A != 0 {
		t.Fatalf("shadow painted where the node has not moved from: %+v", got)
	}
}

// A blurred shadow must spread beyond the silhouette and fade, otherwise the
// blur radius is being ignored.
func TestDrawShadowsBlurSpreads(t *testing.T) {
	r := image.Rect(0, 0, 64, 64)
	page := image.NewRGBA(r)
	layer := image.NewRGBA(r)
	for y := 24; y < 40; y++ {
		for x := 24; x < 40; x++ {
			layer.SetRGBA(x, y, color.RGBA{255, 255, 255, 255})
		}
	}
	drawShadows(page, layer, []shadowSpec{{blur: 12, col: color.RGBA{0, 0, 0, 255}, opacity: 1}}, unitXform(), 1)

	edge := page.RGBAAt(20, 32) // outside the square, inside the blur
	if edge.A == 0 {
		t.Fatal("a blurred shadow did not spread past the silhouette")
	}
	if edge.A == 255 {
		t.Fatal("a blurred shadow did not fade at its edge")
	}
}

// shadowsOf must read BOTH shapes the format uses: a node effect
// (offsetX/offsetY, a bare Color whose alpha is the opacity) and a text effect
// (dx/dy plus an explicit opacity, color wrapped in a Fill). Reading only one
// renders the other at the wrong offset and in the wrong color.
func TestShadowsOf(t *testing.T) {
	got := shadowsOf(map[string]any{
		"effects": []any{
			map[string]any{"kind": "shadow", "dx": 2.0, "dy": 3.0, "blur": 4.0, "opacity": 0.5},
			map[string]any{"kind": "shadow", "enabled": false, "dx": 9.0},
			map[string]any{"kind": "blur", "radius": 3.0},
		},
	})
	if len(got) != 1 {
		t.Fatalf("shadowsOf = %d shadows, want 1 (disabled and non-shadow effects skipped)", len(got))
	}
	if got[0].dx != 2 || got[0].dy != 3 || got[0].blur != 4 || got[0].opacity != 0.5 {
		t.Fatalf("text-effect shadow read wrong: %+v", got[0])
	}

	// The node Effect shape: offsetX/offsetY, color as a bare Color, alpha on it.
	nodeShadow := shadowsOf(map[string]any{"effects": []any{map[string]any{
		"kind": "shadow", "offsetX": 6.0, "offsetY": -4.0, "blur": 8.0, "spread": 0.0,
		"color": map[string]any{"srgb": map[string]any{"r": 1.0, "g": 0.0, "b": 0.0, "a": 0.25}},
	}}})
	if len(nodeShadow) != 1 {
		t.Fatalf("node-effect shadow not read: %+v", nodeShadow)
	}
	s0 := nodeShadow[0]
	if s0.dx != 6 || s0.dy != -4 {
		t.Fatalf("offsetX/offsetY ignored: %+v", s0)
	}
	if s0.col.R < 250 || s0.col.G > 5 || s0.col.B > 5 {
		t.Fatalf("shadow color lost (a node Effect carries a bare Color): %+v", s0.col)
	}
	if math.Abs(s0.opacity-0.25) > 1e-9 {
		t.Fatalf("color alpha not used as opacity: %v", s0.opacity)
	}

	// Inner shadows are skipped, not drawn as drop shadows.
	if n := shadowsOf(map[string]any{"effects": []any{map[string]any{
		"kind": "shadow", "type": "inner", "offsetX": 3.0,
		"color": map[string]any{"srgb": map[string]any{"r": 0.0, "g": 0.0, "b": 0.0, "a": 1.0}},
	}}}); len(n) != 0 {
		t.Fatalf("inner shadow was drawn as a drop shadow: %+v", n)
	}

	// A fully transparent color contributes nothing.
	if n := shadowsOf(map[string]any{"effects": []any{map[string]any{
		"kind": "shadow", "offsetX": 3.0,
		"color": map[string]any{"srgb": map[string]any{"r": 0.0, "g": 0.0, "b": 0.0, "a": 0.0}},
	}}}); len(n) != 0 {
		t.Fatalf("a fully transparent shadow was kept: %+v", n)
	}

	if len(shadowsOf(map[string]any{})) != 0 {
		t.Fatal("a node with no effects reported a shadow")
	}
}

// blendModeOf must treat the values that mean "just draw it" as no mode at all,
// so ordinary nodes never pay for layer isolation.
func TestBlendModeOf(t *testing.T) {
	for _, m := range []string{"", "normal", "pass-through"} {
		if got := blendModeOf(map[string]any{"blendMode": m}); got != "" {
			t.Errorf("blendModeOf(%q) = %q, want empty", m, got)
		}
	}
	if got := blendModeOf(map[string]any{"blendMode": "multiply"}); got != "multiply" {
		t.Errorf("blendModeOf(multiply) = %q", got)
	}
}

// End to end: the defect users actually hit. A design whose shape declares a
// blend mode or a drop shadow must export with it. Before layer compositing
// existed the exporter drew both as a plain opaque shape, so a multiply layer
// came out normal and a shadow came out missing.
func TestRasterHonorsBlendModeAndShadow(t *testing.T) {
	col := func(r, g, b float64) map[string]any {
		return map[string]any{"srgb": map[string]any{"r": r, "g": g, "b": b, "a": 1.0}}
	}
	shape := func(extra map[string]any) map[string]any {
		n := map[string]any{
			"id": "s1", "type": "shape", "shape": "rect",
			"transform": map[string]any{"x": 20.0, "y": 20.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
			"size":      map[string]any{"width": 60.0, "height": 60.0},
			"fills":     []any{map[string]any{"type": "solid", "color": col(1, 1, 1)}},
		}
		for k, v := range extra {
			n[k] = v
		}
		return n
	}
	page := func(node map[string]any) Design {
		return Design{"pages": []any{map[string]any{
			"width": 100.0, "height": 100.0,
			"background": map[string]any{"type": "solid", "color": col(0.5, 0.5, 0.5)},
			"children":   []any{node},
		}}}
	}

	// A white square multiplied over a mid-grey page must stay grey, not turn white.
	img, err := toRaster(page(shape(map[string]any{"blendMode": "multiply"})), 0, 1, false)
	if err != nil {
		t.Fatalf("toRaster(multiply): %v", err)
	}
	got := img.RGBAAt(50, 50)
	if got.R > 200 {
		t.Fatalf("multiply exported as normal: center = %+v, want the grey backdrop preserved", got)
	}

	// The same square with no blend mode is white, proving the test discriminates.
	plain, err := toRaster(page(shape(nil)), 0, 1, false)
	if err != nil {
		t.Fatalf("toRaster(plain): %v", err)
	}
	if p := plain.RGBAAt(50, 50); p.R < 250 {
		t.Fatalf("plain square did not render white: %+v", p)
	}

	// A drop shadow must darken the page outside the square's own bounds.
	withShadow := shape(map[string]any{"effects": []any{map[string]any{
		"kind": "shadow", "dx": 10.0, "dy": 10.0, "blur": 4.0, "opacity": 1.0, "color": col(0, 0, 0),
	}}})
	simg, err := toRaster(page(withShadow), 0, 1, false)
	if err != nil {
		t.Fatalf("toRaster(shadow): %v", err)
	}
	// (85,85) is past the square (which ends at 80) but inside the offset shadow.
	sh := simg.RGBAAt(85, 85)
	base := plain.RGBAAt(85, 85)
	if sh.R >= base.R {
		t.Fatalf("no shadow outside the shape: got %+v, unshadowed %+v", sh, base)
	}
}

// A stroked shape must export with its border. The rasterizer filled shapes and
// never stroked them, so a bordered rectangle came out as a plain fill.
func TestRasterStrokesShapes(t *testing.T) {
	col := func(r, g, b float64) map[string]any {
		return map[string]any{"srgb": map[string]any{"r": r, "g": g, "b": b, "a": 1.0}}
	}
	node := map[string]any{
		"id": "s1", "type": "shape", "shape": "rect",
		"transform": map[string]any{"x": 20.0, "y": 20.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 60.0, "height": 60.0},
		"fills":     []any{map[string]any{"type": "solid", "color": col(1, 1, 1)}},
		"stroke": map[string]any{
			"fill":  map[string]any{"type": "solid", "color": col(1, 0, 0)},
			"width": 6.0, "align": "center", "cap": "round", "join": "round",
		},
	}
	design := Design{"pages": []any{map[string]any{
		"width": 100.0, "height": 100.0,
		"background": map[string]any{"type": "solid", "color": col(0, 0, 1)},
		"children":   []any{node},
	}}}
	img, err := toRaster(design, 0, 1, false)
	if err != nil {
		t.Fatalf("toRaster: %v", err)
	}
	// On the border (x=20 edge, mid-height) the stroke is red.
	edge := img.RGBAAt(20, 50)
	if edge.R < 200 || edge.G > 80 || edge.B > 80 {
		t.Fatalf("shape border did not export: edge = %+v, want red", edge)
	}
	// Well inside is still the white fill, and well outside is still the page.
	if in := img.RGBAAt(50, 50); in.R < 250 || in.G < 250 {
		t.Fatalf("fill was overpainted: %+v", in)
	}
	if out := img.RGBAAt(5, 5); out.B < 200 {
		t.Fatalf("stroke leaked outside the shape: %+v", out)
	}

	// A shape with no stroke must be unchanged by the new path.
	delete(node, "stroke")
	plain, err := toRaster(design, 0, 1, false)
	if err != nil {
		t.Fatalf("toRaster(plain): %v", err)
	}
	if e := plain.RGBAAt(20, 50); e.R > 250 && e.G < 80 {
		t.Fatal("an unstroked shape drew a stroke")
	}
}

// A node's own opacity must be applied exactly once. The layered path draws the
// subtree (which already applies the node's opacity) and then fades the layer on
// the way back in, so it is easy to apply it twice and export a shape at 25%
// when the canvas shows 50%.
func TestRasterLayeredOpacityAppliedOnce(t *testing.T) {
	col := func(r, g, b float64) map[string]any {
		return map[string]any{"srgb": map[string]any{"r": r, "g": g, "b": b, "a": 1.0}}
	}
	build := func(extra map[string]any) Design {
		n := map[string]any{
			"id": "s1", "type": "shape", "shape": "rect",
			"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
			"size":      map[string]any{"width": 100.0, "height": 100.0},
			"fills":     []any{map[string]any{"type": "solid", "color": col(1, 1, 1)}},
			"opacity":   0.5,
		}
		for k, v := range extra {
			n[k] = v
		}
		return Design{"pages": []any{map[string]any{
			"width": 100.0, "height": 100.0,
			"background": map[string]any{"type": "solid", "color": col(0, 0, 0)},
			"children":   []any{n},
		}}}
	}

	// Baseline: a 50% white square on black, drawn through the direct path.
	plain, err := toRaster(build(nil), 0, 1, false)
	if err != nil {
		t.Fatalf("toRaster(plain): %v", err)
	}
	want := plain.RGBAAt(50, 50).R
	if want < 120 || want > 136 {
		t.Fatalf("baseline 50%% white on black = %d, want ~128", want)
	}

	// The same square routed through the LAYER path by a drop shadow must land
	// at the same brightness: the shadow changes what is behind it, not the
	// node's own opacity.
	// A shadow with a real opacity forces the layer path (a zero-opacity shadow
	// is skipped entirely), and offsetting it clean off the page keeps it from
	// touching the sample point, so only the opacity handling is under test.
	layered, err := toRaster(build(map[string]any{"effects": []any{map[string]any{
		"kind": "shadow", "dx": 5000.0, "dy": 5000.0, "blur": 0.0, "opacity": 1.0, "color": col(0, 0, 0),
	}}}), 0, 1, false)
	if err != nil {
		t.Fatalf("toRaster(layered): %v", err)
	}
	got := layered.RGBAAt(50, 50).R
	if int(got) < int(want)-6 || int(got) > int(want)+6 {
		t.Fatalf("opacity applied twice through the layer path: got %d, direct path %d", got, want)
	}
}

// The shape the EDITOR actually writes. PropertiesPanel's shadow presets emit
// {kind:"shadow", type:"drop", color:{srgb{...a}}, offsetX, offsetY, blur,
// spread}, so this is the payload that has to work; a reader built for the
// text-effect shape (dx/dy plus an explicit opacity) would silently render
// every user-created shadow at zero offset in solid black.
func TestRasterHonorsEditorAuthoredShadow(t *testing.T) {
	col := func(r, g, b, a float64) map[string]any {
		return map[string]any{"srgb": map[string]any{"r": r, "g": g, "b": b, "a": a}}
	}
	// Verbatim from the editor's "Shadow" preset, only the color made red so the
	// test can tell tint from the default black.
	effect := map[string]any{
		"kind": "shadow", "type": "drop",
		"color": col(1, 0, 0, 0.35), "offsetX": 0.0, "offsetY": 12.0, "blur": 0.0, "spread": 0.0,
	}
	node := map[string]any{
		"id": "s1", "type": "shape", "shape": "rect",
		"transform": map[string]any{"x": 20.0, "y": 20.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 60.0, "height": 60.0},
		"fills":     []any{map[string]any{"type": "solid", "color": col(1, 1, 1, 1)}},
		"effects":   []any{effect},
	}
	design := Design{"pages": []any{map[string]any{
		"width": 100.0, "height": 100.0,
		"background": map[string]any{"type": "solid", "color": col(1, 1, 1, 1)},
		"children":   []any{node},
	}}}
	img, err := toRaster(design, 0, 1, false)
	if err != nil {
		t.Fatalf("toRaster: %v", err)
	}
	// The square spans y 20..80; offsetY 12 puts the shadow band at y 80..92.
	band := img.RGBAAt(50, 86)
	if band.R == band.G && band.G == band.B {
		t.Fatalf("shadow at the offset position is grey, so the color was dropped: %+v", band)
	}
	if band.G > 220 || band.B > 220 {
		t.Fatalf("shadow is not tinted red: %+v", band)
	}
	// 35% alpha over white: clearly tinted, but nowhere near opaque.
	if band.G < 120 {
		t.Fatalf("shadow ignored the color alpha and painted near-opaque: %+v", band)
	}
	// Above the square there is no shadow at all (offset is downward only).
	if above := img.RGBAAt(50, 12); above.R < 250 || above.G < 250 || above.B < 250 {
		t.Fatalf("shadow painted above the shape: %+v", above)
	}
}

// The non-separable modes mix whole colours rather than channels, and setSat
// sorts through pointers, which is the easiest place in this file to get a
// silent aliasing bug. Anchor each mode on a property the spec guarantees.
func TestNonSeparableBlendModes(t *testing.T) {
	near := func(name string, got, want float64) {
		t.Helper()
		if math.Abs(got-want) > 1e-6 {
			t.Errorf("%s = %.6f, want %.6f", name, got, want)
		}
	}
	// luminosity takes the source's luminosity with the backdrop's colour.
	br, bg, bb := 0.2, 0.6, 0.4
	sr, sg, sb := 0.9, 0.9, 0.9
	r, g, b := blendNonSeparable("luminosity", br, bg, bb, sr, sg, sb)
	near("luminosity result lum", lum(r, g, b), lum(sr, sg, sb))
	// color takes the source's colour with the backdrop's luminosity.
	r, g, b = blendNonSeparable("color", br, bg, bb, sr, sg, sb)
	near("color result lum", lum(r, g, b), lum(br, bg, bb))
	// hue keeps the backdrop's luminosity AND saturation.
	r, g, b = blendNonSeparable("hue", br, bg, bb, 0.8, 0.1, 0.1)
	near("hue result lum", lum(r, g, b), lum(br, bg, bb))
	near("hue result sat", sat(r, g, b), sat(br, bg, bb))
	// saturation keeps the backdrop's luminosity and moves toward the source's
	// saturation. It is not an equality: restoring the luminosity can push a
	// channel out of range, and the spec's ClipColor then compresses back in,
	// which legitimately lowers the final saturation.
	r, g, b = blendNonSeparable("saturation", br, bg, bb, 0.9, 0.1, 0.5)
	near("saturation result lum", lum(r, g, b), lum(br, bg, bb))
	if s := sat(r, g, b); s <= sat(br, bg, bb) || s > sat(0.9, 0.1, 0.5)+1e-9 {
		t.Errorf("saturation result sat = %v, want between the backdrop's %v and the source's %v", s, sat(br, bg, bb), sat(0.9, 0.1, 0.5))
	}
	// A grey source has no hue to donate, so hue over grey leaves grey.
	r, g, b = blendNonSeparable("hue", 0.5, 0.5, 0.5, 0.3, 0.7, 0.2)
	if math.Abs(r-g) > 1e-6 || math.Abs(g-b) > 1e-6 {
		t.Errorf("hue over a grey backdrop produced colour: %v %v %v", r, g, b)
	}
	// setSat must survive ties in every arrangement without writing through the
	// wrong pointer.
	for _, tri := range [][3]float64{{0.5, 0.5, 0.5}, {0.2, 0.2, 0.9}, {0.9, 0.2, 0.2}, {0.2, 0.9, 0.2}, {0.1, 0.5, 0.9}, {0.9, 0.5, 0.1}} {
		r, g, b := setSat(tri[0], tri[1], tri[2], 0.6)
		got := sat(r, g, b)
		want := 0.6
		if tri[0] == tri[1] && tri[1] == tri[2] {
			want = 0 // a flat colour has no range to rescale
		}
		if math.Abs(got-want) > 1e-6 {
			t.Errorf("setSat%v = (%v %v %v), saturation %v, want %v", tri, r, g, b, got, want)
		}
	}
}

// A text node's shadow lives on `textEffects`, not `effects`. Reading only the
// node-effect list meant text drop shadows exported as nothing.
func TestShadowsOfReadsTextEffects(t *testing.T) {
	got := shadowsOf(map[string]any{"textEffects": []any{
		map[string]any{"kind": "shadow", "dx": 3.0, "dy": 4.0, "blur": 2.0, "opacity": 0.6,
			"color": map[string]any{"type": "solid", "color": map[string]any{"srgb": map[string]any{"r": 0.0, "g": 0.0, "b": 1.0, "a": 1.0}}}},
		map[string]any{"kind": "glow", "radius": 4.0},
	}})
	if len(got) != 1 {
		t.Fatalf("text shadow not read: %+v", got)
	}
	if got[0].dx != 3 || got[0].dy != 4 || math.Abs(got[0].opacity-0.6) > 1e-9 {
		t.Fatalf("text shadow read wrong: %+v", got[0])
	}
	if got[0].col.B < 200 {
		t.Fatalf("text shadow color lost (a text effect wraps it in a Fill): %+v", got[0].col)
	}
}

// A shadow belongs to the node's own image, so it must go through the node's
// blend mode with it. Painting it straight onto the page would exempt it.
func TestShadowParticipatesInBlendMode(t *testing.T) {
	col := func(r, g, b, a float64) map[string]any {
		return map[string]any{"srgb": map[string]any{"r": r, "g": g, "b": b, "a": a}}
	}
	node := map[string]any{
		"id": "s1", "type": "shape", "shape": "rect",
		"transform": map[string]any{"x": 20.0, "y": 10.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 60.0, "height": 40.0},
		"fills":     []any{map[string]any{"type": "solid", "color": col(0.5, 0.5, 0.5, 1)}},
		"blendMode": "screen",
		"effects": []any{map[string]any{
			"kind": "shadow", "type": "drop", "offsetX": 0.0, "offsetY": 40.0, "blur": 0.0,
			"color": col(0, 0, 0, 1),
		}},
	}
	img, err := toRaster(Design{"pages": []any{map[string]any{
		"width": 100.0, "height": 100.0,
		"background": map[string]any{"type": "solid", "color": col(1, 1, 1, 1)},
		"children":   []any{node},
	}}}, 0, 1, false)
	if err != nil {
		t.Fatalf("toRaster: %v", err)
	}
	// Screen with black is a no-op, so the shadow band over white stays white.
	if c := img.RGBAAt(50, 70); c.R < 250 || c.G < 250 || c.B < 250 {
		t.Fatalf("shadow bypassed the node's screen blend: %+v", c)
	}
	// Control: the SAME shadow under a normally-blended node must darken that
	// band. Without this the assertion above would also pass if the shadow were
	// simply missing.
	node["blendMode"] = "normal"
	plain, err := toRaster(Design{"pages": []any{map[string]any{
		"width": 100.0, "height": 100.0,
		"background": map[string]any{"type": "solid", "color": col(1, 1, 1, 1)},
		"children":   []any{node},
	}}}, 0, 1, false)
	if err != nil {
		t.Fatalf("toRaster(control): %v", err)
	}
	if c := plain.RGBAAt(50, 70); c.R > 100 {
		t.Fatalf("the control shadow did not darken, so the test cannot detect a missing shadow: %+v", c)
	}
}

// A stroke is drawn as one non-zero-winding pass over per-segment quads plus
// join polygons. If a join winds against the quads it CANCELS them, biting a
// hole out of the stroke at every corner. Mid-edge samples never see it, so
// this test walks the corners and the full circumference.
func TestStrokeHasNoHolesAtJoins(t *testing.T) {
	col := func(r, g, b float64) map[string]any {
		return map[string]any{"srgb": map[string]any{"r": r, "g": g, "b": b, "a": 1.0}}
	}
	design := func(shape string) Design {
		return Design{"pages": []any{map[string]any{
			"width": 120.0, "height": 120.0,
			"background": map[string]any{"type": "solid", "color": col(1, 1, 1)},
			"children": []any{map[string]any{
				"id": "s1", "type": "shape", "shape": shape,
				"transform": map[string]any{"x": 30.0, "y": 30.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
				"size":      map[string]any{"width": 60.0, "height": 60.0},
				"stroke": map[string]any{
					"fill":  map[string]any{"type": "solid", "color": col(1, 0, 0)},
					"width": 8.0, "align": "center", "cap": "round", "join": "round",
				},
			}},
		}}}
	}

	// A stroked circle: every point on the centreline must be covered.
	img, err := toRaster(design("ellipse"), 0, 1, false)
	if err != nil {
		t.Fatalf("toRaster(ellipse): %v", err)
	}
	holes := 0
	for i := 0; i < 360; i++ {
		th := float64(i) * math.Pi / 180
		x := int(math.Round(60 + 30*math.Cos(th)))
		y := int(math.Round(60 + 30*math.Sin(th)))
		if c := img.RGBAAt(x, y); c.R < 200 || c.G > 80 {
			holes++
		}
	}
	if holes > 0 {
		t.Fatalf("%d of 360 points on the stroked circle are not covered (joins are cancelling the stroke)", holes)
	}

	// A stroked rectangle: the four corners are where joins pile up.
	rimg, err := toRaster(design("rect"), 0, 1, false)
	if err != nil {
		t.Fatalf("toRaster(rect): %v", err)
	}
	for _, p := range [][2]int{{30, 30}, {90, 30}, {90, 90}, {30, 90}} {
		if c := rimg.RGBAAt(p[0], p[1]); c.R < 200 || c.G > 80 {
			t.Fatalf("corner %v is not stroked: %+v", p, c)
		}
	}
}

// A shadow offset is a VECTOR in the node's own space, so it must rotate and
// stretch with the node. Scaling it by an averaged scalar leaves a rotated
// node's shadow pointing the wrong way and gives an anisotropically scaled node
// the mean of its two axes.
func TestShadowOffsetFollowsNodeTransform(t *testing.T) {
	xf := offsetXformOf(mat{a: 1, b: 0, c: 0, d: 1})
	if x, y := xf.apply(20, 0); math.Abs(x-20) > 1e-9 || math.Abs(y) > 1e-9 {
		t.Fatalf("identity moved the offset: (%v, %v)", x, y)
	}
	// Rotated 90 degrees: a rightward offset must become downward.
	rot := offsetXformOf(mat{a: 0, b: 1, c: -1, d: 0})
	x, y := rot.apply(20, 0)
	if math.Abs(x) > 1e-9 || math.Abs(y-20) > 1e-9 {
		t.Fatalf("a rotated node's shadow did not rotate: (%v, %v), want (0, 20)", x, y)
	}
	if math.Abs(rot.scale-1) > 1e-9 {
		t.Fatalf("pure rotation changed the blur scale: %v", rot.scale)
	}
	// Anisotropic scale: the x offset follows the x axis exactly, not the mean.
	an := offsetXformOf(mat{a: 3, b: 0, c: 0, d: 1})
	if x, _ := an.apply(20, 0); math.Abs(x-60) > 1e-9 {
		t.Fatalf("anisotropic offset = %v, want 60 (20 x the x-axis scale)", x)
	}
	// The blur radius is scalar: the geometric mean of the axis scales.
	if math.Abs(an.scale-math.Sqrt(3)) > 1e-9 {
		t.Fatalf("blur scale = %v, want sqrt(3)", an.scale)
	}
}
