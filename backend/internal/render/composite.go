// Layer compositing for the headless rasterizer: blend modes and drop shadows.
//
// The browser paints these through Canvas2D (`globalCompositeOperation` and the
// CSS filter string); the Go exporter drew every node straight into the page
// buffer, so a multiply layer exported as normal and a drop shadow exported as
// nothing. That is a what-you-see-is-not-what-you-export defect, not a missing
// nicety, so the two paths are brought together here.
//
// A node that needs isolation (a non-normal blend mode, or a drop shadow) is
// drawn into a transparent layer the size of the page, then composited. Nodes
// that need neither keep drawing straight into the page buffer, so the common
// case pays nothing. Blend maths follow the W3C compositing spec, which is what
// Canvas2D implements, so the two renderers agree.
package render

import (
	"image"
	"image/color"
	"math"
	"sync"
)

// separable blend modes operate per channel on unpremultiplied [0,1] values.
func blendChannel(mode string, cb, cs float64) float64 {
	switch mode {
	case "multiply":
		return cb * cs
	case "screen":
		return cb + cs - cb*cs
	case "overlay":
		return blendChannel("hard-light", cs, cb)
	case "darken":
		return math.Min(cb, cs)
	case "lighten":
		return math.Max(cb, cs)
	case "color-dodge":
		if cb == 0 {
			return 0
		}
		if cs == 1 {
			return 1
		}
		return math.Min(1, cb/(1-cs))
	case "color-burn":
		if cb == 1 {
			return 1
		}
		if cs == 0 {
			return 0
		}
		return 1 - math.Min(1, (1-cb)/cs)
	case "hard-light":
		if cs <= 0.5 {
			return cb * 2 * cs
		}
		return blendChannel("screen", cb, 2*cs-1)
	case "soft-light":
		if cs <= 0.5 {
			return cb - (1-2*cs)*cb*(1-cb)
		}
		var d float64
		if cb <= 0.25 {
			d = ((16*cb-12)*cb + 4) * cb
		} else {
			d = math.Sqrt(cb)
		}
		return cb + (2*cs-1)*(d-cb)
	case "difference":
		return math.Abs(cb - cs)
	case "exclusion":
		return cb + cs - 2*cb*cs
	}
	return cs // normal
}

func lum(r, g, b float64) float64 { return 0.3*r + 0.59*g + 0.11*b }

func clipColor(r, g, b float64) (float64, float64, float64) {
	l := lum(r, g, b)
	n := math.Min(r, math.Min(g, b))
	x := math.Max(r, math.Max(g, b))
	if n < 0 && l != n {
		r = l + (r-l)*l/(l-n)
		g = l + (g-l)*l/(l-n)
		b = l + (b-l)*l/(l-n)
	}
	if x > 1 && x != l {
		r = l + (r-l)*(1-l)/(x-l)
		g = l + (g-l)*(1-l)/(x-l)
		b = l + (b-l)*(1-l)/(x-l)
	}
	return r, g, b
}

func setLum(r, g, b, l float64) (float64, float64, float64) {
	d := l - lum(r, g, b)
	return clipColor(r+d, g+d, b+d)
}

func sat(r, g, b float64) float64 {
	return math.Max(r, math.Max(g, b)) - math.Min(r, math.Min(g, b))
}

// setSat rescales the channels to the target saturation, preserving their order.
func setSat(r, g, b, s float64) (float64, float64, float64) {
	ch := []*float64{&r, &g, &b}
	// order by value: mn < md < mx
	mn, md, mx := ch[0], ch[1], ch[2]
	if *mn > *md {
		mn, md = md, mn
	}
	if *md > *mx {
		md, mx = mx, md
	}
	if *mn > *md {
		mn, md = md, mn
	}
	if *mx > *mn {
		*md = (*md - *mn) * s / (*mx - *mn)
		*mx = s
	} else {
		*md, *mx = 0, 0
	}
	*mn = 0
	return r, g, b
}

// blendNonSeparable handles the four modes that mix whole colors rather than
// channels (hue, saturation, color, luminosity).
func blendNonSeparable(mode string, br, bg, bb, sr, sg, sb float64) (float64, float64, float64) {
	switch mode {
	case "hue":
		r, g, b := setSat(sr, sg, sb, sat(br, bg, bb))
		return setLum(r, g, b, lum(br, bg, bb))
	case "saturation":
		r, g, b := setSat(br, bg, bb, sat(sr, sg, sb))
		return setLum(r, g, b, lum(br, bg, bb))
	case "color":
		return setLum(sr, sg, sb, lum(br, bg, bb))
	case "luminosity":
		return setLum(br, bg, bb, lum(sr, sg, sb))
	}
	return sr, sg, sb
}

func isNonSeparable(mode string) bool {
	switch mode {
	case "hue", "saturation", "color", "luminosity":
		return true
	}
	return false
}

// blendModeOf reads a node's blend mode, normalizing the values that mean
// "just draw it" to the empty string so callers can skip isolation entirely.
func blendModeOf(node map[string]any) string {
	m := asStr(node["blendMode"])
	if m == "normal" || m == "pass-through" {
		return ""
	}
	return m
}

// compositeLayer draws src over dst using the given blend mode, following the
// W3C source-over compositing formula with the blended color. Both images are
// premultiplied RGBA of the same bounds.
func compositeLayer(dst, src *image.RGBA, mode string) {
	b := dst.Rect
	nonSep := isNonSeparable(mode)
	for y := b.Min.Y; y < b.Max.Y; y++ {
		di := dst.PixOffset(b.Min.X, y)
		si := src.PixOffset(b.Min.X, y)
		for x := b.Min.X; x < b.Max.X; x++ {
			sa := float64(src.Pix[si+3]) / 255
			if sa > 0 {
				// Unpremultiply both sides; the blend maths are defined on
				// straight color.
				sr := float64(src.Pix[si+0]) / 255 / sa
				sg := float64(src.Pix[si+1]) / 255 / sa
				sb := float64(src.Pix[si+2]) / 255 / sa
				da := float64(dst.Pix[di+3]) / 255
				var br, bg, bb float64
				if da > 0 {
					br = float64(dst.Pix[di+0]) / 255 / da
					bg = float64(dst.Pix[di+1]) / 255 / da
					bb = float64(dst.Pix[di+2]) / 255 / da
				}
				var cr, cg, cb float64
				if nonSep {
					cr, cg, cb = blendNonSeparable(mode, br, bg, bb, sr, sg, sb)
				} else {
					cr = blendChannel(mode, br, sr)
					cg = blendChannel(mode, bg, sg)
					cb = blendChannel(mode, bb, sb)
				}
				// Where the backdrop is transparent the blend has nothing to
				// mix with, so the source shows through unchanged.
				cr = sr + da*(cr-sr)
				cg = sg + da*(cg-sg)
				cb = sb + da*(cb-sb)
				// source-over with the blended color, back to premultiplied.
				oa := sa + da*(1-sa)
				or := cr*sa + br*da*(1-sa)
				og := cg*sa + bg*da*(1-sa)
				ob := cb*sa + bb*da*(1-sa)
				dst.Pix[di+0] = clamp8(or)
				dst.Pix[di+1] = clamp8(og)
				dst.Pix[di+2] = clamp8(ob)
				dst.Pix[di+3] = clamp8(oa)
			}
			di += 4
			si += 4
		}
	}
}

func clamp8(v float64) uint8 {
	if v <= 0 {
		return 0
	}
	if v >= 1 {
		return 255
	}
	return uint8(math.Round(v * 255))
}

// boxBlurAlpha blurs the alpha channel in place with three box passes, which
// approximates a Gaussian closely enough for a drop shadow and stays linear in
// the radius rather than quadratic.
func boxBlurAlpha(a []float64, w, h, radius int) {
	if radius <= 0 {
		return
	}
	// Clamp to the only radius that can still change the image. The value comes
	// from the file, so an absurd one (a JSON number like 1e300 saturates the
	// int conversion) would otherwise make `win` overflow negative and the seed
	// loop run for approximately forever, wedging the export on a spinning core.
	max := w
	if h > max {
		max = h
	}
	if radius > max {
		radius = max
	}
	tmp := scratchPlane(len(a))
	defer releasePlane(tmp)
	for pass := 0; pass < 3; pass++ {
		blurPassH(a, tmp, w, h, radius)
		blurPassV(tmp, a, w, h, radius)
	}
}

func blurPassH(src, dst []float64, w, h, r int) {
	win := float64(2*r + 1)
	for y := 0; y < h; y++ {
		row := y * w
		var sum float64
		for i := -r; i <= r; i++ {
			sum += src[row+clampi(i, 0, w-1)]
		}
		for x := 0; x < w; x++ {
			dst[row+x] = sum / win
			sum -= src[row+clampi(x-r, 0, w-1)]
			sum += src[row+clampi(x+r+1, 0, w-1)]
		}
	}
}

func blurPassV(src, dst []float64, w, h, r int) {
	win := float64(2*r + 1)
	for x := 0; x < w; x++ {
		var sum float64
		for i := -r; i <= r; i++ {
			sum += src[clampi(i, 0, h-1)*w+x]
		}
		for y := 0; y < h; y++ {
			dst[y*w+x] = sum / win
			sum -= src[clampi(y-r, 0, h-1)*w+x]
			sum += src[clampi(y+r+1, 0, h-1)*w+x]
		}
	}
}

func clampi(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// offsetXform carries how a node's transform maps an effect's offset vector
// into device space. The offset rotates and skews with the node (the browser
// applies the filter under the current transform), while a blur radius is
// scalar and uses the geometric mean of the axis scales.
type offsetXform struct {
	a, b, c, d float64 // the matrix's linear part
	scale      float64
}

func offsetXformOf(m mat) offsetXform {
	sx := math.Hypot(m.a, m.b)
	sy := math.Hypot(m.c, m.d)
	return offsetXform{a: m.a, b: m.b, c: m.c, d: m.d, scale: math.Sqrt(math.Max(sx*sy, 0))}
}

func (x offsetXform) apply(dx, dy float64) (float64, float64) {
	return x.a*dx + x.c*dy, x.b*dx + x.d*dy
}

// shadowSpec is one drop shadow read off a node's effects array.
type shadowSpec struct {
	dx, dy  float64
	blur    float64
	col     color.RGBA
	opacity float64
}

// shadowColor reads a shadow's color, which the format writes two different
// ways: a node `Effect` carries a bare `Color` (`{srgb}`), while a text effect
// carries a `Fill` (`{type:"solid", color:{srgb}}`). Reading only one of them
// silently renders every shadow of the other kind black. The alpha rides on the
// color, so it is returned separately and folded into the shadow's opacity.
func shadowColor(v map[string]any) (pdfColor, float64) {
	if v == nil {
		return pdfColor{ok: true}, 1 // no color given: opaque black
	}
	srgb := asObj(v["srgb"])
	if srgb == nil {
		// A Fill wrapper: unwrap to its color, keeping gradient degradation.
		c := pdfPaint(v)
		if inner := asObj(v["color"]); inner != nil {
			if is := asObj(inner["srgb"]); is != nil {
				a := 1.0
				if av, ok := is["a"].(float64); ok {
					a = av
				}
				return c, a
			}
		}
		if !c.ok {
			c = pdfColor{ok: true}
		}
		return c, 1
	}
	a := 1.0
	if av, ok := srgb["a"].(float64); ok {
		a = av
	}
	return colorComponents(v), a
}

// shadowsOf reads the drop shadows a node declares. The format has two shapes
// and both ship: a node `effects` entry (offsetX/offsetY, alpha carried on the
// color) and a `textEffects` entry on text nodes (dx/dy plus an explicit
// opacity). Inner shadows are skipped rather than
// faked as drop shadows, and `spread` is not applied (documented in the
// rasterizer's fidelity notes).
func shadowsOf(node map[string]any) []shadowSpec {
	var out []shadowSpec
	add := func(o map[string]any) {
		if o == nil {
			return
		}
		if asStr(o["type"]) == "inner" {
			return // not rendered; drawing it as a drop shadow would be worse
		}
		op := 1.0
		if v, ok := o["opacity"].(float64); ok {
			op = v
		}
		c, ca := shadowColor(asObj(o["color"]))
		op *= ca
		if op <= 0 {
			return
		}
		// Node effects use offsetX/offsetY; text effects use dx/dy.
		dx, dy := asNum(o["offsetX"]), asNum(o["offsetY"])
		if dx == 0 && dy == 0 {
			dx, dy = asNum(o["dx"]), asNum(o["dy"])
		}
		out = append(out, shadowSpec{
			dx: dx, dy: dy,
			blur: asNum(o["blur"]), col: rasterColor(c, 1), opacity: op,
		})
	}
	if effs, ok := node["effects"].([]any); ok {
		for _, e := range effs {
			eo := asObj(e)
			if eo == nil || asStr(eo["kind"]) != "shadow" {
				continue
			}
			if v, ok := eo["enabled"].(bool); ok && !v {
				continue
			}
			add(eo)
		}
	}
	// Text carries its shadows on `textEffects` (a separate list with the
	// dx/dy plus explicit-opacity shape), which is why a text drop shadow
	// exported as nothing while the canvas showed it.
	if tfx, ok := node["textEffects"].([]any); ok {
		for _, e := range tfx {
			eo := asObj(e)
			if eo == nil || asStr(eo["kind"]) != "shadow" {
				continue
			}
			if v, ok := eo["enabled"].(bool); ok && !v {
				continue
			}
			add(eo)
		}
	}
	return out
}

// drawShadows paints each shadow beneath the node's own layer: the layer's
// alpha is the silhouette, offset, blurred, and tinted.
func drawShadows(dst *image.RGBA, layer *image.RGBA, shadows []shadowSpec, xf offsetXform, alpha float64) {
	b := layer.Rect
	w, h := b.Dx(), b.Dy()
	if w <= 0 || h <= 0 {
		return
	}
	a := scratchPlane(w * h)
	defer releasePlane(a)
	for _, sh := range shadows {
		for i := range a {
			a[i] = 0 // each shadow starts from the node's own silhouette
		}
		ox, oy := xf.apply(sh.dx, sh.dy)
		odx := int(math.Round(ox))
		ody := int(math.Round(oy))
		for y := 0; y < h; y++ {
			sy := y - ody
			if sy < 0 || sy >= h {
				continue
			}
			for x := 0; x < w; x++ {
				sx := x - odx
				if sx < 0 || sx >= w {
					continue
				}
				a[y*w+x] = float64(layer.Pix[layer.PixOffset(b.Min.X+sx, b.Min.Y+sy)+3]) / 255
			}
		}
		boxBlurAlpha(a, w, h, int(math.Round(sh.blur*xf.scale/2)))
		sr := float64(sh.col.R) / 255
		sg := float64(sh.col.G) / 255
		sb := float64(sh.col.B) / 255
		for y := 0; y < h; y++ {
			di := dst.PixOffset(b.Min.X, b.Min.Y+y)
			for x := 0; x < w; x++ {
				sa := a[y*w+x] * sh.opacity * alpha
				if sa > 0.0005 {
					da := float64(dst.Pix[di+3]) / 255
					oa := sa + da*(1-sa)
					dst.Pix[di+0] = clamp8(sr*sa + float64(dst.Pix[di+0])/255*(1-sa))
					dst.Pix[di+1] = clamp8(sg*sa + float64(dst.Pix[di+1])/255*(1-sa))
					dst.Pix[di+2] = clamp8(sb*sa + float64(dst.Pix[di+2])/255*(1-sa))
					dst.Pix[di+3] = clamp8(oa)
				}
				di += 4
			}
		}
	}
}

// scaleLayerAlpha multiplies a premultiplied layer by a constant alpha.
func scaleLayerAlpha(layer *image.RGBA, a float64) {
	if a >= 1 {
		return
	}
	for i := 0; i < len(layer.Pix); i++ {
		layer.Pix[i] = uint8(math.Round(float64(layer.Pix[i]) * a))
	}
}

// takeLayer returns a cleared page-sized layer, reusing a pooled buffer when one
// is free. Without pooling, every blended or shadowed node allocates a fresh
// page-sized RGBA: on a large print page that is hundreds of megabytes of
// churn for a single export. Peak cost is now the NESTING depth (usually one),
// not the number of isolated nodes.
func (rc *rctx) takeLayer() *image.RGBA {
	if n := len(rc.layerPool); n > 0 {
		l := rc.layerPool[n-1]
		rc.layerPool = rc.layerPool[:n-1]
		for i := range l.Pix {
			l.Pix[i] = 0
		}
		return l
	}
	return image.NewRGBA(rc.dst.Rect)
}

func (rc *rctx) releaseLayer(l *image.RGBA) {
	// Keep a couple around; a design nested deeper than that is rare enough to
	// pay for its own allocation rather than hold the memory forever.
	if len(rc.layerPool) < 2 {
		rc.layerPool = append(rc.layerPool, l)
	}
}

// Scratch float64 planes for the blur passes. Blurring needs a work plane per
// call and a shadow needs one per silhouette; at 8 bytes a pixel those dominate
// the memory of a large export, so they are pooled and reused rather than
// allocated per node. A plane MUST be released only after its last use: a blur
// nested inside a shadow holds two at once, and handing the same array to both
// would corrupt the result.
var planePool = sync.Pool{New: func() any { s := make([]float64, 0); return &s }}

func scratchPlane(n int) []float64 {
	p := planePool.Get().(*[]float64)
	if cap(*p) < n {
		*p = make([]float64, n)
	}
	buf := (*p)[:n]
	for i := range buf {
		buf[i] = 0
	}
	return buf
}

func releasePlane(buf []float64) {
	s := buf[:0]
	planePool.Put(&s)
}
