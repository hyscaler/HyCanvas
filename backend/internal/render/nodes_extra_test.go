package render

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"strings"
	"testing"
)

// scanImage decodes a PNG and counts pixels matching pred.
func scanImage(t *testing.T, data []byte, pred func(r, g, b, a uint32) bool) int {
	t.Helper()
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	n := 0
	b := img.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			r, g, bl, a := img.At(x, y).RGBA()
			if pred(r, g, bl, a) {
				n++
			}
		}
	}
	return n
}

func page(w, h float64, node map[string]any) Design {
	return Design{"pages": []any{map[string]any{
		"width": w, "height": h, "children": []any{node},
		"background": map[string]any{"type": "solid", "color": map[string]any{"srgb": map[string]any{"r": 1.0, "g": 1.0, "b": 1.0, "a": 1.0}}},
	}}}
}

func solidFill(r, g, b float64) map[string]any {
	return map[string]any{"type": "solid", "color": map[string]any{"srgb": map[string]any{"r": r, "g": g, "b": b, "a": 1.0}}}
}

var isRed = func(r, g, b, a uint32) bool { return r > 40000 && g < 20000 && b < 20000 }
var isBlue = func(r, g, b, a uint32) bool { return b > 40000 && r < 20000 && g < 25000 }
var isGreen = func(r, g, b, a uint32) bool { return g > 30000 && r < 25000 && b < 25000 }
var isBlack = func(r, g, b, a uint32) bool { return r < 16384 && g < 16384 && b < 16384 && a > 40000 }
var isYellow = func(r, g, b, a uint32) bool { return r > 40000 && g > 40000 && b < 25000 }

// TestRasterStampGlyph: the fixed stamp glyphs render as colored vector icons.
func TestRasterStampGlyph(t *testing.T) {
	mk := func(glyph string) []byte {
		node := map[string]any{
			"type": "stamp", "kind": "vote", "glyph": glyph,
			"transform": map[string]any{"x": 10.0, "y": 10.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
			"size":      map[string]any{"width": 80.0, "height": 80.0},
		}
		data, err := ToPNG(page(100, 100, node), 0, 1)
		if err != nil {
			t.Fatalf("ToPNG: %v", err)
		}
		return data
	}
	if red := scanImage(t, mk("🔴"), isRed); red < 500 {
		t.Fatalf("red-circle stamp not drawn: red=%d", red)
	}
	if yellow := scanImage(t, mk("⭐"), isYellow); yellow < 300 {
		t.Fatalf("star stamp not drawn: yellow=%d", yellow)
	}
	if green := scanImage(t, mk("✅"), isGreen); green < 500 {
		t.Fatalf("check stamp not drawn: green=%d", green)
	}
}

// TestSVGImageFill: an image shape fill becomes a <pattern> def with the data URL.
func TestSVGImageFill(t *testing.T) {
	const dataURL = "data:image/png;base64,iVBORw0KGgoAAAANSVGFILLTEST"
	node := map[string]any{
		"type": "shape", "shape": "rect",
		"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 50.0, "height": 50.0},
		"fills": []any{map[string]any{
			"type": "image", "fit": "cover",
			"source": map[string]any{"assetId": "a1"},
			"src":    dataURL,
		}},
	}
	svg, err := ToSVG(Design{"pages": []any{map[string]any{"width": 100.0, "height": 100.0, "children": []any{node}}}}, 0)
	if err != nil {
		t.Fatalf("ToSVG: %v", err)
	}
	if !strings.Contains(svg, "<pattern") || !strings.Contains(svg, dataURL) || !strings.Contains(svg, "url(#img-") {
		t.Fatalf("SVG image fill did not emit a pattern with the image")
	}
}

// TestRasterTableRunColor: cell text honors the run's flat fontSize/weight/color
// (a non-header red run renders red text, not the default ink).
func TestRasterTableRunColor(t *testing.T) {
	node := map[string]any{
		"type":      "table",
		"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 160.0, "height": 60.0},
		"rows":      1.0, "cols": 1.0,
		"colWidths":   []any{160.0},
		"rowHeights":  []any{60.0},
		"headerStyle": map[string]any{"enabled": false},
		"borderStyle": map[string]any{"show": false},
		"cells": []any{
			map[string]any{"row": 0.0, "col": 0.0, "rowSpan": 1.0, "colSpan": 1.0, "align": "left",
				"content": []any{map[string]any{"text": "RED", "fontId": "system", "fontSize": 40.0, "weight": 700.0,
					"color": map[string]any{"srgb": map[string]any{"r": 1.0, "g": 0.0, "b": 0.0, "a": 1.0}}}}},
		},
	}
	data, err := ToPNG(page(160, 60, node), 0, 1)
	if err != nil {
		t.Fatalf("ToPNG: %v", err)
	}
	if red := scanImage(t, data, isRed); red < 80 {
		t.Fatalf("table run color/size not honored: red text pixels=%d", red)
	}
}

// TestRasterChartChrome: a bar chart with title + legend + axes renders the
// bars, the title text, and axis lines (exercises the chart chrome port).
func TestRasterChartChrome(t *testing.T) {
	node := map[string]any{
		"type": "chart", "chartType": "bar",
		"transform":  map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":       map[string]any{"width": 300.0, "height": 200.0},
		"categories": []any{"a", "b", "c"},
		"series": []any{map[string]any{"name": "Series One", "values": []any{2.0, 5.0, 3.0},
			"color": map[string]any{"srgb": map[string]any{"r": 0.0, "g": 0.0, "b": 1.0, "a": 1.0}}}},
		"style": map[string]any{
			"title":  "My Chart",
			"legend": map[string]any{"show": true, "position": "bottom"},
			"axes":   map[string]any{"showX": true, "showY": true, "xLabel": "X", "yLabel": "Y"},
		},
	}
	data, err := ToPNG(page(300, 200, node), 0, 1)
	if err != nil {
		t.Fatalf("ToPNG: %v", err)
	}
	if blue := scanImage(t, data, isBlue); blue < 200 {
		t.Fatalf("chart bars not drawn: blue=%d", blue)
	}
	if dark := scanImage(t, data, isBlack); dark < 20 {
		t.Fatalf("chart title/labels not drawn: dark=%d", dark)
	}
}

// redDataURL is a 16x16 solid-red PNG as a data URL, for image/logo tests.
func redDataURL(t *testing.T) string {
	t.Helper()
	red := image.NewRGBA(image.Rect(0, 0, 16, 16))
	for y := 0; y < 16; y++ {
		for x := 0; x < 16; x++ {
			red.Set(x, y, color.RGBA{R: 255, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, red); err != nil {
		t.Fatalf("encode: %v", err)
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
}

// TestSVGQR: a QR node exports to SVG (background + module path + logo image).
func TestSVGQR(t *testing.T) {
	logo := redDataURL(t)
	node := map[string]any{
		"type": "qr", "value": "x",
		"transform":  map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":       map[string]any{"width": 200.0, "height": 200.0},
		"foreground": map[string]any{"srgb": map[string]any{"r": 0.0, "g": 0.0, "b": 0.0, "a": 1.0}},
		"background": map[string]any{"srgb": map[string]any{"r": 1.0, "g": 1.0, "b": 1.0, "a": 1.0}},
		"modules":    []any{[]any{true, false, true}, []any{false, true, false}, []any{true, false, true}},
		"logoSrc":    logo,
	}
	svg, err := ToSVG(Design{"pages": []any{map[string]any{"width": 200.0, "height": 200.0, "children": []any{node}}}}, 0)
	if err != nil {
		t.Fatalf("ToSVG: %v", err)
	}
	if !strings.Contains(svg, "<path") || !strings.Contains(svg, `<image href="`+logo) {
		t.Fatalf("SVG QR missing module path or logo image")
	}
}

// TestSVGStamp: a stamp exports to SVG as <text> with the glyph and emoji font.
func TestSVGStamp(t *testing.T) {
	node := map[string]any{
		"type": "stamp", "glyph": "🔥",
		"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 60.0, "height": 60.0},
	}
	svg, err := ToSVG(Design{"pages": []any{map[string]any{"width": 100.0, "height": 100.0, "children": []any{node}}}}, 0)
	if err != nil {
		t.Fatalf("ToSVG: %v", err)
	}
	if !strings.Contains(svg, "🔥") || !strings.Contains(svg, "Emoji") {
		t.Fatalf("SVG stamp missing glyph or emoji font")
	}
}

// TestSVGImageFillFit: a non-square image fill uses a userSpaceOnUse pattern
// sized to the shape (so cover/contain fit is exact), not objectBoundingBox.
func TestSVGImageFillFit(t *testing.T) {
	node := map[string]any{
		"type": "shape", "shape": "rect",
		"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 200.0, "height": 50.0},
		"fills": []any{map[string]any{
			"type": "image", "fit": "cover",
			"source": map[string]any{"assetId": "a1"},
			"src":    redDataURL(t),
		}},
	}
	svg, err := ToSVG(Design{"pages": []any{map[string]any{"width": 200.0, "height": 100.0, "children": []any{node}}}}, 0)
	if err != nil {
		t.Fatalf("ToSVG: %v", err)
	}
	if !strings.Contains(svg, `patternUnits="userSpaceOnUse"`) || !strings.Contains(svg, `width="200"`) {
		t.Fatalf("SVG image fill did not size the pattern to the shape (non-square fit)")
	}
}

// TestRasterConicGradient: a conic red->blue fill produces both hues (a sweep),
// not a single flat color (the old behavior degraded conic to linear/first-stop).
func TestRasterConicGradient(t *testing.T) {
	node := map[string]any{
		"type": "shape", "shape": "rect",
		"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 100.0, "height": 100.0},
		"fills": []any{map[string]any{
			"type": "gradient", "gradient": "conic", "angle": 0.0,
			"center": map[string]any{"x": 0.5, "y": 0.5},
			"stops": []any{
				map[string]any{"position": 0.0, "color": map[string]any{"srgb": map[string]any{"r": 1.0, "g": 0.0, "b": 0.0, "a": 1.0}}},
				map[string]any{"position": 1.0, "color": map[string]any{"srgb": map[string]any{"r": 0.0, "g": 0.0, "b": 1.0, "a": 1.0}}},
			},
		}},
	}
	data, err := ToPNG(page(100, 100, node), 0, 1)
	if err != nil {
		t.Fatalf("ToPNG: %v", err)
	}
	red := scanImage(t, data, isRed)
	blue := scanImage(t, data, isBlue)
	if red < 100 || blue < 100 {
		t.Fatalf("conic gradient not swept: red=%d blue=%d (expected both hues)", red, blue)
	}
}

// TestRasterBoolean: a boolean node draws its baked result path with the fill.
func TestRasterBoolean(t *testing.T) {
	node := map[string]any{
		"type": "boolean", "op": "union",
		"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 100.0, "height": 100.0},
		"result": map[string]any{"subpaths": []any{map[string]any{
			"closed": true,
			"anchors": []any{
				map[string]any{"x": 10.0, "y": 10.0},
				map[string]any{"x": 90.0, "y": 10.0},
				map[string]any{"x": 50.0, "y": 90.0},
			},
		}}},
		"fills": []any{solidFill(1, 0, 0)},
	}
	data, err := ToPNG(page(100, 100, node), 0, 1)
	if err != nil {
		t.Fatalf("ToPNG: %v", err)
	}
	if red := scanImage(t, data, isRed); red < 500 {
		t.Fatalf("boolean result not filled: red=%d", red)
	}
}

// TestRasterQR: the module matrix paints foreground squares over the background.
func TestRasterQR(t *testing.T) {
	node := map[string]any{
		"type": "qr", "value": "x", "ecLevel": "M",
		"transform":  map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":       map[string]any{"width": 110.0, "height": 110.0},
		"foreground": map[string]any{"srgb": map[string]any{"r": 0.0, "g": 0.0, "b": 0.0, "a": 1.0}},
		"background": map[string]any{"srgb": map[string]any{"r": 1.0, "g": 1.0, "b": 1.0, "a": 1.0}},
		"modules": []any{
			[]any{true, false, true},
			[]any{false, true, false},
			[]any{true, false, true},
		},
	}
	data, err := ToPNG(page(110, 110, node), 0, 1)
	if err != nil {
		t.Fatalf("ToPNG: %v", err)
	}
	if black := scanImage(t, data, isBlack); black < 100 {
		t.Fatalf("qr foreground modules not drawn: black=%d", black)
	}
}

// TestRasterQRLogo: a QR node with an embedded logo (logoSrc) draws the logo
// centered over the modules.
func TestRasterQRLogo(t *testing.T) {
	red := image.NewRGBA(image.Rect(0, 0, 16, 16))
	for y := 0; y < 16; y++ {
		for x := 0; x < 16; x++ {
			red.Set(x, y, color.RGBA{R: 255, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, red); err != nil {
		t.Fatalf("encode: %v", err)
	}
	node := map[string]any{
		"type": "qr", "value": "x", "ecLevel": "H",
		"transform":  map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":       map[string]any{"width": 200.0, "height": 200.0},
		"foreground": map[string]any{"srgb": map[string]any{"r": 0.0, "g": 0.0, "b": 0.0, "a": 1.0}},
		"background": map[string]any{"srgb": map[string]any{"r": 1.0, "g": 1.0, "b": 1.0, "a": 1.0}},
		"modules": []any{
			[]any{true, false, true}, []any{false, true, false}, []any{true, false, true},
		},
		"logoSrc": "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes()),
	}
	data, err := ToPNG(page(200, 200, node), 0, 1)
	if err != nil {
		t.Fatalf("ToPNG: %v", err)
	}
	if r := scanImage(t, data, isRed); r < 300 {
		t.Fatalf("QR logo not drawn: red=%d", r)
	}
}

// TestRasterQRLogoScale: a larger logoScale draws a bigger logo (more red).
func TestRasterQRLogoScale(t *testing.T) {
	red := image.NewRGBA(image.Rect(0, 0, 16, 16))
	for y := 0; y < 16; y++ {
		for x := 0; x < 16; x++ {
			red.Set(x, y, color.RGBA{R: 255, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, red); err != nil {
		t.Fatalf("encode: %v", err)
	}
	src := "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
	render := func(scale float64) int {
		node := map[string]any{
			"type": "qr", "value": "x", "ecLevel": "H",
			"transform":  map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
			"size":       map[string]any{"width": 200.0, "height": 200.0},
			"foreground": map[string]any{"srgb": map[string]any{"r": 0.0, "g": 0.0, "b": 0.0, "a": 1.0}},
			"background": map[string]any{"srgb": map[string]any{"r": 1.0, "g": 1.0, "b": 1.0, "a": 1.0}},
			"modules":    []any{[]any{true, false, true}, []any{false, true, false}, []any{true, false, true}},
			"logoSrc":    src,
			"logoScale":  scale,
		}
		data, err := ToPNG(page(200, 200, node), 0, 1)
		if err != nil {
			t.Fatalf("ToPNG: %v", err)
		}
		return scanImage(t, data, isRed)
	}
	small, big := render(0.12), render(0.38)
	if big <= small*2 {
		t.Fatalf("logoScale not honored: small(0.12)=%d big(0.38)=%d", small, big)
	}
}

// TestRasterImageFill: a shape with an image fill blits the image, clipped.
func TestRasterImageFill(t *testing.T) {
	red := image.NewRGBA(image.Rect(0, 0, 16, 16))
	for y := 0; y < 16; y++ {
		for x := 0; x < 16; x++ {
			red.Set(x, y, color.RGBA{R: 255, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, red); err != nil {
		t.Fatalf("encode: %v", err)
	}
	dataURL := "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
	node := map[string]any{
		"type": "shape", "shape": "rect",
		"transform": map[string]any{"x": 20.0, "y": 20.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 60.0, "height": 60.0},
		"fills": []any{map[string]any{
			"type": "image", "fit": "cover",
			"source": map[string]any{"assetId": "a1", "naturalWidth": 16.0, "naturalHeight": 16.0},
			"src":    dataURL,
		}},
	}
	data, err := ToPNG(page(100, 100, node), 0, 1)
	if err != nil {
		t.Fatalf("ToPNG: %v", err)
	}
	if r := scanImage(t, data, isRed); r < 1000 {
		t.Fatalf("image fill not drawn: red=%d", r)
	}
}

// TestRasterPathGradientFill: a path node with a gradient fill renders both
// hues (paths previously rendered non-solid fills as blank).
func TestRasterPathGradientFill(t *testing.T) {
	node := map[string]any{
		"type":      "path",
		"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 100.0, "height": 100.0},
		"closed":    true,
		"segments": []any{
			map[string]any{"x": 5.0, "y": 5.0},
			map[string]any{"x": 95.0, "y": 5.0},
			map[string]any{"x": 95.0, "y": 95.0},
			map[string]any{"x": 5.0, "y": 95.0},
		},
		"fills": []any{map[string]any{
			"type": "gradient", "gradient": "linear", "angle": 0.0,
			"stops": []any{
				map[string]any{"position": 0.0, "color": map[string]any{"srgb": map[string]any{"r": 1.0, "g": 0.0, "b": 0.0, "a": 1.0}}},
				map[string]any{"position": 1.0, "color": map[string]any{"srgb": map[string]any{"r": 0.0, "g": 0.0, "b": 1.0, "a": 1.0}}},
			},
		}},
	}
	data, err := ToPNG(page(100, 100, node), 0, 1)
	if err != nil {
		t.Fatalf("ToPNG: %v", err)
	}
	if red, blue := scanImage(t, data, isRed), scanImage(t, data, isBlue); red < 100 || blue < 100 {
		t.Fatalf("path gradient fill not drawn: red=%d blue=%d", red, blue)
	}
}

// TestSVGImageEmbeddedSrc: ToSVG emits the inlined data URL as the image href.
func TestSVGImageEmbeddedSrc(t *testing.T) {
	const dataURL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgTEST"
	node := map[string]any{
		"type":      "image",
		"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 50.0, "height": 50.0},
		"source":    map[string]any{"assetId": "a1"},
		"src":       dataURL,
	}
	svg, err := ToSVG(Design{"pages": []any{map[string]any{"width": 100.0, "height": 100.0, "children": []any{node}}}}, 0)
	if err != nil {
		t.Fatalf("ToSVG: %v", err)
	}
	if !strings.Contains(svg, dataURL) {
		t.Fatalf("SVG did not embed the image data URL as href")
	}
}

// TestRasterEllipseImageFill: an image fill on an ellipse shape blits the image
// clipped to the ellipse (image/pattern fills work on ellipses, not just rects).
func TestRasterEllipseImageFill(t *testing.T) {
	red := image.NewRGBA(image.Rect(0, 0, 16, 16))
	for y := 0; y < 16; y++ {
		for x := 0; x < 16; x++ {
			red.Set(x, y, color.RGBA{R: 255, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, red); err != nil {
		t.Fatalf("encode: %v", err)
	}
	dataURL := "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
	node := map[string]any{
		"type": "shape", "shape": "ellipse",
		"transform": map[string]any{"x": 10.0, "y": 10.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 80.0, "height": 80.0},
		"fills": []any{map[string]any{
			"type": "image", "fit": "cover",
			"source": map[string]any{"assetId": "a1", "naturalWidth": 16.0, "naturalHeight": 16.0},
			"src":    dataURL,
		}},
	}
	data, err := ToPNG(page(100, 100, node), 0, 1)
	if err != nil {
		t.Fatalf("ToPNG: %v", err)
	}
	if r := scanImage(t, data, isRed); r < 1000 {
		t.Fatalf("ellipse image fill not drawn: red=%d", r)
	}
}

// TestRasterTable: cell fills, text, and gridlines render.
func TestRasterTable(t *testing.T) {
	node := map[string]any{
		"type":        "table",
		"transform":   map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":        map[string]any{"width": 200.0, "height": 80.0},
		"rows":        2.0,
		"cols":        2.0,
		"colWidths":   []any{100.0, 100.0},
		"rowHeights":  []any{40.0, 40.0},
		"headerStyle": map[string]any{"enabled": false},
		// Thick blue border so the gridline check is independent of the (dark) cell text.
		"borderStyle": map[string]any{"show": true, "width": 4.0, "color": map[string]any{"srgb": map[string]any{"r": 0.0, "g": 0.0, "b": 1.0, "a": 1.0}}},
		"cells": []any{
			map[string]any{"row": 0.0, "col": 0.0, "rowSpan": 1.0, "colSpan": 1.0, "fill": solidFill(0, 1, 0),
				"content": []any{map[string]any{"text": "Hi", "fontSize": 18.0, "weight": 400.0}}},
		},
	}
	data, err := ToPNG(page(200, 80, node), 0, 1)
	if err != nil {
		t.Fatalf("ToPNG: %v", err)
	}
	if g := scanImage(t, data, isGreen); g < 1000 {
		t.Fatalf("table cell fill not drawn: green=%d", g)
	}
	if b := scanImage(t, data, isBlue); b < 100 {
		t.Fatalf("table gridlines not drawn: blue=%d", b)
	}
}

// TestRasterChartBar: a bar chart draws series-colored bars, taller for larger
// values (bar for value 3 covers more area than the bar for value 1).
func TestRasterChartBar(t *testing.T) {
	node := map[string]any{
		"type": "chart", "chartType": "bar",
		"transform":  map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":       map[string]any{"width": 220.0, "height": 140.0},
		"categories": []any{"a", "b", "c"},
		"series": []any{map[string]any{"name": "s", "values": []any{1.0, 2.0, 3.0},
			"color": map[string]any{"srgb": map[string]any{"r": 0.0, "g": 0.0, "b": 1.0, "a": 1.0}}}},
	}
	data, err := ToPNG(page(220, 140, node), 0, 1)
	if err != nil {
		t.Fatalf("ToPNG: %v", err)
	}
	if blue := scanImage(t, data, isBlue); blue < 300 {
		t.Fatalf("chart bars not drawn: blue=%d", blue)
	}
}
