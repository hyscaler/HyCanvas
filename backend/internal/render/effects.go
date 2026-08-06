// Node effects for the headless rasterizer: colour adjustments, blur, glow,
// outline, and duotone.
//
// The browser applies most of these through the CSS filter string that
// `@hc/engine`'s `effectsFilter` builds, plus an offscreen pass for duotone and
// a separate stroke for outlines. The Go exporter implemented none of them, so
// every image filter, blur, glow, outline, and duotone a user applied was
// missing from PNG and PDF export while looking correct on the canvas.
//
// These run over the isolated layer the node was drawn into (see composite.go),
// which is what makes them possible at all: an effect needs the node's own
// pixels separated from the page behind it. The maths mirror the CSS filter
// functions the browser uses, in the same declared order, so the two agree.
package render

import (
	"image"
	"math"
)

// effectSpec is one node effect, read loosely from the file format.
type effectSpec struct {
	kind string
	raw  map[string]any
}

// effectsOf lists a node's effects in declared order. Order matters: CSS
// filters compose in sequence, so brightness-then-saturate is not the same as
// saturate-then-brightness.
func effectsOf(node map[string]any) []effectSpec {
	arr, _ := node["effects"].([]any)
	out := make([]effectSpec, 0, len(arr))
	for _, e := range arr {
		eo := asObj(e)
		if eo == nil {
			continue
		}
		if v, ok := eo["enabled"].(bool); ok && !v {
			continue
		}
		out = append(out, effectSpec{kind: asStr(eo["kind"]), raw: eo})
	}
	return out
}

// needsLayer reports whether a node has any effect this renderer implements
// with a layer pass. Shadows are handled separately (they draw beneath).
func hasLayerEffect(effects []effectSpec) bool {
	for _, e := range effects {
		switch e.kind {
		case "adjustment", "blur", "glow", "outline", "duotone":
			return true
		}
	}
	return false
}

// --- colour adjustments ------------------------------------------------------

// colorMatrix is a 4x5 row-major matrix over straight (unpremultiplied) RGB.
// Composing adjustments into one matrix keeps a stack of filters to a single
// pass over the pixels and matches how the browser chains CSS filter functions.
type colorMatrix [20]float64

func identityMatrix() colorMatrix {
	return colorMatrix{
		1, 0, 0, 0, 0,
		0, 1, 0, 0, 0,
		0, 0, 1, 0, 0,
		0, 0, 0, 1, 0,
	}
}

// mul returns b applied after a.
func (a colorMatrix) mul(b colorMatrix) colorMatrix {
	var out colorMatrix
	for r := 0; r < 4; r++ {
		for c := 0; c < 5; c++ {
			var sum float64
			for k := 0; k < 4; k++ {
				sum += b[r*5+k] * a[k*5+c]
			}
			if c == 4 {
				sum += b[r*5+4]
			}
			out[r*5+c] = sum
		}
	}
	return out
}

func brightnessMatrix(v float64) colorMatrix {
	return colorMatrix{v, 0, 0, 0, 0, 0, v, 0, 0, 0, 0, 0, v, 0, 0, 0, 0, 0, 1, 0}
}

func contrastMatrix(v float64) colorMatrix {
	i := (1 - v) / 2
	return colorMatrix{v, 0, 0, 0, i, 0, v, 0, 0, i, 0, 0, v, 0, i, 0, 0, 0, 1, 0}
}

// saturateMatrix is the SVG/CSS saturate matrix (luminance-preserving).
func saturateMatrix(s float64) colorMatrix {
	const lr, lg, lb = 0.213, 0.715, 0.072
	return colorMatrix{
		lr + (1-lr)*s, lg - lg*s, lb - lb*s, 0, 0,
		lr - lr*s, lg + (1-lg)*s, lb - lb*s, 0, 0,
		lr - lr*s, lg - lg*s, lb + (1-lb)*s, 0, 0,
		0, 0, 0, 1, 0,
	}
}

func grayscaleMatrix(v float64) colorMatrix { return saturateMatrix(1 - clamp01f(v)) }

func sepiaMatrix(v float64) colorMatrix {
	v = clamp01f(v)
	return colorMatrix{
		0.393 + 0.607*(1-v), 0.769 - 0.769*(1-v), 0.189 - 0.189*(1-v), 0, 0,
		0.349 - 0.349*(1-v), 0.686 + 0.314*(1-v), 0.168 - 0.168*(1-v), 0, 0,
		0.272 - 0.272*(1-v), 0.534 - 0.534*(1-v), 0.131 + 0.869*(1-v), 0, 0,
		0, 0, 0, 1, 0,
	}
}

func invertMatrix(v float64) colorMatrix {
	v = clamp01f(v)
	a := 1 - 2*v
	return colorMatrix{a, 0, 0, 0, v, 0, a, 0, 0, v, 0, 0, a, 0, v, 0, 0, 0, 1, 0}
}

// hueRotateMatrix is the SVG/CSS hueRotate matrix.
func hueRotateMatrix(deg float64) colorMatrix {
	rad := deg * math.Pi / 180
	c, s := math.Cos(rad), math.Sin(rad)
	return colorMatrix{
		0.213 + c*0.787 - s*0.213, 0.715 - c*0.715 - s*0.715, 0.072 - c*0.072 + s*0.928, 0, 0,
		0.213 - c*0.213 + s*0.143, 0.715 + c*0.285 + s*0.140, 0.072 - c*0.072 - s*0.283, 0, 0,
		0.213 - c*0.213 - s*0.787, 0.715 - c*0.715 + s*0.715, 0.072 + c*0.928 + s*0.072, 0, 0,
		0, 0, 0, 1, 0,
	}
}

func clamp01f(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

// adjustmentMatrix folds one adjustment op into a colour matrix, mirroring
// `adjustmentOpToFilters` in `@hc/engine` op for op, including the extended ops
// that are approximated there from native filters. A blur op is NOT a matrix;
// it is reported separately so the caller can run a spatial pass.
func adjustmentMatrix(name string, value float64) (colorMatrix, float64, bool) {
	switch name {
	case "brightness":
		return brightnessMatrix(value), 0, true
	case "contrast":
		return contrastMatrix(value), 0, true
	case "saturate":
		return saturateMatrix(value), 0, true
	case "grayscale":
		return grayscaleMatrix(value), 0, true
	case "sepia":
		return sepiaMatrix(value), 0, true
	case "invert":
		return invertMatrix(value), 0, true
	case "hue-rotate":
		if value == 0 {
			return identityMatrix(), 0, true
		}
		return hueRotateMatrix(value), 0, true
	case "blur", "blur-amount":
		if value > 0 {
			return identityMatrix(), value, true
		}
		return identityMatrix(), 0, true
	// Extended ops, approximated exactly as the browser approximates them.
	case "exposure":
		if value == 0 {
			return identityMatrix(), 0, true
		}
		return brightnessMatrix(1 + value), 0, true
	case "vibrance":
		if value == 0 {
			return identityMatrix(), 0, true
		}
		return saturateMatrix(1 + value*0.5), 0, true
	case "warmth", "temperature":
		if value == 0 {
			return identityMatrix(), 0, true
		}
		return hueRotateMatrix(-value * 12).mul(saturateMatrix(1 + math.Abs(value)*0.1)), 0, true
	case "tint":
		if value == 0 {
			return identityMatrix(), 0, true
		}
		return hueRotateMatrix(value * 40), 0, true
	case "highlights":
		if value == 0 {
			return identityMatrix(), 0, true
		}
		return brightnessMatrix(1 + value*0.25).mul(contrastMatrix(1 - value*0.08)), 0, true
	case "shadows":
		if value == 0 {
			return identityMatrix(), 0, true
		}
		return contrastMatrix(1 - value*0.18).mul(brightnessMatrix(1 + value*0.12)), 0, true
	}
	return identityMatrix(), 0, false // unknown op: no-op, same as the browser
}

// applyColorMatrix runs a colour matrix over a premultiplied layer, operating on
// straight colour and re-premultiplying. Fully transparent pixels are skipped so
// an effect cannot tint empty space.
func applyColorMatrix(layer *image.RGBA, m colorMatrix) {
	if m == identityMatrix() {
		return
	}
	b := layer.Rect
	for y := b.Min.Y; y < b.Max.Y; y++ {
		i := layer.PixOffset(b.Min.X, y)
		for x := b.Min.X; x < b.Max.X; x++ {
			a := float64(layer.Pix[i+3]) / 255
			if a > 0 {
				r := float64(layer.Pix[i+0]) / 255 / a
				g := float64(layer.Pix[i+1]) / 255 / a
				bl := float64(layer.Pix[i+2]) / 255 / a
				nr := m[0]*r + m[1]*g + m[2]*bl + m[4]
				ng := m[5]*r + m[6]*g + m[7]*bl + m[9]
				nb := m[10]*r + m[11]*g + m[12]*bl + m[14]
				layer.Pix[i+0] = clamp8(clamp01f(nr) * a)
				layer.Pix[i+1] = clamp8(clamp01f(ng) * a)
				layer.Pix[i+2] = clamp8(clamp01f(nb) * a)
			}
			i += 4
		}
	}
}

// --- blur --------------------------------------------------------------------

// blurLayer blurs a premultiplied layer with three box passes per channel, the
// same approximation the shadow path uses. Premultiplied data is what should be
// blurred: blurring straight colour bleeds colour out of transparent pixels.
func blurLayer(layer *image.RGBA, radiusPx float64) {
	r := int(math.Round(radiusPx))
	if r <= 0 {
		return
	}
	b := layer.Rect
	w, h := b.Dx(), b.Dy()
	if w <= 0 || h <= 0 {
		return
	}
	buf := make([]float64, w*h)
	for ch := 0; ch < 4; ch++ {
		for y := 0; y < h; y++ {
			row := layer.PixOffset(b.Min.X, b.Min.Y+y)
			for x := 0; x < w; x++ {
				buf[y*w+x] = float64(layer.Pix[row+x*4+ch])
			}
		}
		boxBlurAlpha(buf, w, h, r)
		for y := 0; y < h; y++ {
			row := layer.PixOffset(b.Min.X, b.Min.Y+y)
			for x := 0; x < w; x++ {
				v := buf[y*w+x]
				if v < 0 {
					v = 0
				} else if v > 255 {
					v = 255
				}
				layer.Pix[row+x*4+ch] = uint8(math.Round(v))
			}
		}
	}
}

// --- duotone -----------------------------------------------------------------

// applyDuotone maps each pixel's luminance onto the shadows/highlights ramp and
// blends by intensity, matching `duotoneLut` + `applyDuotone` in `@hc/engine`.
func applyDuotoneLayer(layer *image.RGBA, e map[string]any) {
	k := 1.0
	if v, ok := e["intensity"].(float64); ok {
		k = clamp01f(v)
	}
	if k == 0 {
		return
	}
	sc, _ := shadowColor(asObj(e["shadows"]))
	hc, _ := shadowColor(asObj(e["highlights"]))
	b := layer.Rect
	for y := b.Min.Y; y < b.Max.Y; y++ {
		i := layer.PixOffset(b.Min.X, y)
		for x := b.Min.X; x < b.Max.X; x++ {
			a := float64(layer.Pix[i+3]) / 255
			if a > 0 {
				r := float64(layer.Pix[i+0]) / 255 / a
				g := float64(layer.Pix[i+1]) / 255 / a
				bl := float64(layer.Pix[i+2]) / 255 / a
				// Rec.601 luminance, the same weights the browser LUT uses.
				t := 0.299*r + 0.587*g + 0.114*bl
				dr := sc.r + (hc.r-sc.r)*t
				dg := sc.g + (hc.g-sc.g)*t
				db := sc.b + (hc.b-sc.b)*t
				layer.Pix[i+0] = clamp8(clamp01f(r+(dr-r)*k) * a)
				layer.Pix[i+1] = clamp8(clamp01f(g+(dg-g)*k) * a)
				layer.Pix[i+2] = clamp8(clamp01f(bl+(db-bl)*k) * a)
			}
			i += 4
		}
	}
}

// --- glow and outline --------------------------------------------------------

// drawGlow paints a blurred, tinted copy of the node's silhouette beneath it,
// which is how the browser renders a glow (a zero-offset drop shadow).
func drawGlow(dst, layer *image.RGBA, e map[string]any, xf offsetXform, alpha float64) {
	radius := asNum(e["radius"])
	if radius <= 0 {
		return
	}
	col, ca := shadowColor(asObj(e["color"]))
	intensity := 1.0
	if v, ok := e["intensity"].(float64); ok {
		intensity = v
	}
	op := ca * clamp01f(intensity)
	if op <= 0 {
		return
	}
	// Pass the radius through unchanged: the browser emits
	// drop-shadow(0 0 <radius>px), and drawShadows applies the same
	// blur-is-twice-the-standard-deviation convention a CSS drop-shadow uses.
	drawShadows(dst, layer, []shadowSpec{{
		blur: radius, col: rasterColor(col, 1), opacity: op,
	}}, xf, alpha)
}

func hasGlow(effects []effectSpec) bool {
	for _, e := range effects {
		if e.kind == "glow" {
			return true
		}
	}
	return false
}

func hasOutline(effects []effectSpec) bool {
	for _, e := range effects {
		if e.kind == "outline" {
			return true
		}
	}
	return false
}

// outlineBox strokes the node's bounding box for each outline effect, which is
// what the browser does (`strokeRect(0, 0, w, h)` with the effect width, drawn
// over the node's own content). Text is skipped: the browser consumes an
// outline effect as a glyph stroke there, which this renderer cannot reproduce,
// and boxing the text instead would be worse than omitting it.
func (rc *rctx) outlineBox(m mat, node map[string]any, effects []effectSpec) {
	if asStr(node["type"]) == "text" {
		return
	}
	w, h := sizeOf(node)
	if w <= 0 || h <= 0 {
		return
	}
	box := transformPts(m, [][2]float64{{0, 0}, {w, 0}, {w, h}, {0, h}})
	for _, e := range effects {
		if e.kind != "outline" {
			continue
		}
		width := asNum(e.raw["width"])
		if width <= 0 {
			continue
		}
		col, ca := shadowColor(asObj(e.raw["color"]))
		if ca <= 0 {
			continue
		}
		rc.strokePolyline(box, width*avgScale(m), rasterColor(col, rc.alpha*ca), true)
	}
}
