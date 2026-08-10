// Raster export (PNG/JPG): pure-Go rasterization of the scene graph via
// golang.org/x/image/vector (anti-aliased, non-zero winding fills). The design
// space is top-left/y-down, matching image space, so no flip is needed; a base
// scale matrix yields the requested output resolution and each node's transform
// composes onto it.
//
// Fidelity notes (documented vs the browser @hc/engine): linear & radial
// gradient fills are rasterized (objectBoundingBox, per-pixel); shape strokes
// follow the shape outline as thick quads with filled joins (see strokeOutline).
//
// TEXT AND SCRIPT COVERAGE: bidirectional ordering ships (see bidi.go), so a
// right-to-left paragraph is ordered and aligned as the canvas shows it, and
// Arabic is SHAPED on this path (see shape.go: contextual forms, lam-alef
// ligatures, harakat). Glyph coverage: the embedded fallback (Liberation
// Sans) covers Latin/Greek/Cyrillic only, but the renderer falls back per
// glyph across the fonts registered at startup (FONTS_DIR), a presentation
// form no font covers decomposes to its base letters, and a character
// nothing can draw is reported once rather than dropped silently. Measure
// uses the same shaped text and fallback advances as the draw pass.
//
// blend modes, drop shadows, and node effects (colour adjustments, blur, glow,
// outline, duotone) composite through an isolated layer (see composite.go and
// effects.go; shadow `spread` is not applied, inner shadows are skipped, blur is
// a three-pass box approximation of a Gaussian, a node's effects apply to its
// whole subtree where the browser resets them before children, and stroke dash
// and align are ignored by both renderers alike);
// unregistered/"system" text
// uses the embedded Arial-metric fallback (Liberation Sans, so width-driven
// layout matches the editor), positioned by translation+scale (rotation not
// applied to glyphs) - legible and placed but not glyph-identical. Vector fills,
// colors, and transforms are faithful.
package render

import (
	"bytes"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"image/png"
	"math"
	"strings"

	xdraw "golang.org/x/image/draw"
	"golang.org/x/image/font"
	"golang.org/x/image/font/gofont/goregular"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/math/fixed"
	"golang.org/x/image/vector"
)

// mat is a 2D affine transform [a b c d e f]: (x,y) -> (a*x+c*y+e, b*x+d*y+f).
type mat struct{ a, b, c, d, e, f float64 }

func matIdentity() mat       { return mat{1, 0, 0, 1, 0, 0} }
func matScale(s float64) mat { return mat{s, 0, 0, s, 0, 0} }
func (m mat) apply(x, y float64) (float64, float64) {
	return m.a*x + m.c*y + m.e, m.b*x + m.d*y + m.f
}

// mul returns m followed by n applied to the result is n∘m... here we compose so
// that child = parent.compose(node): apply node first, then parent.
func (parent mat) compose(n mat) mat {
	return mat{
		a: parent.a*n.a + parent.c*n.b,
		b: parent.b*n.a + parent.d*n.b,
		c: parent.a*n.c + parent.c*n.d,
		d: parent.b*n.c + parent.d*n.d,
		e: parent.a*n.e + parent.c*n.f + parent.e,
		f: parent.b*n.e + parent.d*n.f + parent.f,
	}
}

func nodeMat(node map[string]any) mat {
	a, b, c, d, e, f := transformMatrix(node)
	return mat{a, b, c, d, e, f}
}

func rasterColor(c pdfColor, alpha float64) color.RGBA {
	if !c.ok {
		return color.RGBA{}
	}
	clamp := func(v float64) uint8 {
		if v < 0 {
			v = 0
		}
		if v > 1 {
			v = 1
		}
		return uint8(math.Round(v * 255))
	}
	// image.RGBA is alpha-premultiplied: scale the channels by alpha too, or a
	// translucent fill draws oversaturated.
	return color.RGBA{R: clamp(c.r * alpha), G: clamp(c.g * alpha), B: clamp(c.b * alpha), A: clamp(alpha)}
}

// alphaImage scales a paint source's premultiplied channels by a constant
// alpha, so gradients honor node opacity like flat colors do.
type alphaImage struct {
	src image.Image
	a   float64
}

func (ai alphaImage) ColorModel() color.Model { return ai.src.ColorModel() }
func (ai alphaImage) Bounds() image.Rectangle { return ai.src.Bounds() }
func (ai alphaImage) At(x, y int) color.Color {
	r, g, b, a := ai.src.At(x, y).RGBA()
	f := ai.a
	return color.RGBA64{R: uint16(float64(r) * f), G: uint16(float64(g) * f), B: uint16(float64(b) * f), A: uint16(float64(a) * f)}
}

// rctx carries the rasterization target.
type rctx struct {
	dst   *image.RGBA
	w, h  int
	font  *opentype.Font
	boxes map[string]rbox // page node world-boxes, for connector endpoint routing
	base  mat             // output-scale matrix (page->device), for page-space connectors
	alpha float64         // effective opacity of the node subtree being drawn
	// Reusable page-sized buffers for blend/shadow layer isolation.
	layerPool []*image.RGBA
}

// paint wraps a gradient/pattern source with the current subtree opacity.
func (rc *rctx) paint(src image.Image) image.Image {
	if rc.alpha >= 1 {
		return src
	}
	return alphaImage{src: src, a: rc.alpha}
}

func avgScale(m mat) float64 { return (math.Hypot(m.a, m.b) + math.Hypot(m.c, m.d)) / 2 }

// fillDot fills a small octagon at a device point (round-ish stroke join/cap).
func (rc *rctx) fillDot(cx, cy, r float64, col color.RGBA) {
	if r <= 0 || col.A == 0 {
		return
	}
	pts := make([][2]float64, 8)
	for i := 0; i < 8; i++ {
		a := float64(i) * math.Pi / 4
		pts[i] = [2]float64{cx + math.Cos(a)*r, cy + math.Sin(a)*r}
	}
	rc.fillPath(pts, col)
}

// fillPath rasterizes a closed polygon (device-space points) with a flat color.
func (rc *rctx) fillPath(pts [][2]float64, col color.RGBA) {
	if col.A == 0 {
		return
	}
	rc.fillPathSrc(pts, image.NewUniform(col))
}

// fillPathSrc rasterizes a closed polygon using an arbitrary paint source (flat
// color or gradient), sampled under the path's coverage mask.
func (rc *rctx) fillPathSrc(pts [][2]float64, src image.Image) {
	if len(pts) < 2 {
		return
	}
	r := vector.NewRasterizer(rc.w, rc.h)
	r.MoveTo(float32(pts[0][0]), float32(pts[0][1]))
	for _, p := range pts[1:] {
		r.LineTo(float32(p[0]), float32(p[1]))
	}
	r.ClosePath()
	r.Draw(rc.dst, rc.dst.Bounds(), src, image.Point{})
}

func firstFill(node map[string]any) map[string]any {
	fills := asArr(node["fills"])
	if len(fills) == 0 {
		return nil
	}
	return asObj(fills[0])
}

// fillPolyPaint fills a device-space polygon with a fill that may be a gradient
// (linear/radial/conic), an image, a pattern, or a solid color; an unusable fill
// draws nothing. scale is the node's transform scale (used to size image
// "none" fits and pattern tiles in device space).
func (rc *rctx) fillPolyPaint(pts [][2]float64, fill map[string]any, scale float64) {
	switch asStr(fill["type"]) {
	case "image":
		rc.fillPolyImage(pts, fill, scale)
		return
	case "pattern":
		rc.fillPolyPattern(pts, fill, scale)
		return
	}
	if g := parseGradient(fill); g.ok {
		rc.fillPathSrc(pts, rc.paint(g.source(bboxOf(pts), rc.dst.Bounds())))
		return
	}
	rc.fillPath(pts, rasterColor(pdfPaint(fill), rc.alpha))
}

// fillCubic rasterizes a path of cubic segments (device-space) with a flat color.
// segs is a flat list: first a MoveTo point, then triples of (c1,c2,end).
func (rc *rctx) fillBeziers(start [2]float64, cubics [][3][2]float64, col color.RGBA) {
	if col.A == 0 {
		return
	}
	rc.fillBeziersSrc(start, cubics, image.NewUniform(col))
}

// fillBeziersSrc rasterizes a closed cubic path with an arbitrary paint source
// (flat color or gradient), sampled under the path's coverage mask.
func (rc *rctx) fillBeziersSrc(start [2]float64, cubics [][3][2]float64, src image.Image) {
	r := vector.NewRasterizer(rc.w, rc.h)
	r.MoveTo(float32(start[0]), float32(start[1]))
	for _, c := range cubics {
		r.CubeTo(float32(c[0][0]), float32(c[0][1]), float32(c[1][0]), float32(c[1][1]), float32(c[2][0]), float32(c[2][1]))
	}
	r.ClosePath()
	r.Draw(rc.dst, rc.dst.Bounds(), src, image.Point{})
}

func transformPts(m mat, pts [][2]float64) [][2]float64 {
	out := make([][2]float64, len(pts))
	for i, p := range pts {
		x, y := m.apply(p[0], p[1])
		out[i] = [2]float64{x, y}
	}
	return out
}

func fillColorOf(node map[string]any) pdfColor {
	fills := asArr(node["fills"])
	if len(fills) == 0 {
		return pdfColor{}
	}
	return pdfPaint(asObj(fills[0]))
}

func (rc *rctx) rasterShape(m mat, node map[string]any) {
	w, h := sizeOf(node)
	fill := firstFill(node)
	// The outline the shape is stroked along, in local space. Kept so the stroke
	// can follow the same geometry the fill used; an ellipse is flattened to a
	// polyline for stroking only.
	var outline [][2]float64
	switch asStr(node["shape"]) {
	case "rect":
		outline = [][2]float64{{0, 0}, {w, 0}, {w, h}, {0, h}}
		rc.fillPolyPaint(transformPts(m, outline), fill, avgScale(m))
	case "ellipse":
		rc.rasterEllipse(m, w, h, fill)
		if asObj(node["stroke"]) != nil {
			outline = ellipseOutline(w, h, avgScale(m)) // only needed to stroke
		}
	case "polygon":
		sides := boundedSides(node["sides"], 3)
		outline = polygonPoints(w, h, sides)
		rc.fillPolyPaint(transformPts(m, outline), fill, avgScale(m))
	case "triangle":
		outline = polygonPoints(w, h, 3)
		rc.fillPolyPaint(transformPts(m, outline), fill, avgScale(m))
	case "star":
		pts := boundedSides(node["sides"], 5)
		ir := asNum(node["innerRadius"])
		if ir == 0 {
			ir = 0.5
		}
		outline = starPoints(w, h, pts, ir)
		rc.fillPolyPaint(transformPts(m, outline), fill, avgScale(m))
	}
	// Shapes were previously filled and never stroked, so a stroked rectangle
	// exported without its border. Stroke the closed outline the same way a line
	// node is stroked (thick quads per segment, round-ish joins).
	rc.strokeOutline(m, node, outline, true)
}

// maxShapeSides bounds a polygon or star's point count. Beyond this the shape
// is a circle to the eye, and the count comes from the file, so leaving it
// unbounded lets one integer multiply into the per-segment stroke cost.
const maxShapeSides = 512

func boundedSides(v any, def int) int {
	n := int(asNum(v))
	if n <= 0 {
		return def
	}
	if n < 3 {
		return 3
	}
	if n > maxShapeSides {
		return maxShapeSides
	}
	return n
}

// ellipseOutline flattens an ellipse to a polyline for stroking. The step count
// follows the DEVICE radius: a fixed count leaves a visible wobble once the
// exported ellipse is large (the sagitta grows with the radius), and the fill
// itself is drawn from exact cubics, so the stroke would drift off its own edge.
func ellipseOutline(w, h, scale float64) [][2]float64 {
	cx, cy := w/2, h/2
	r := math.Max(math.Abs(cx), math.Abs(cy)) * math.Max(scale, 0.01)
	// Keep the chord sagitta under ~1/3 device pixel: steps = pi / acos(1 - t/r).
	steps := 72
	if r > 1 {
		if want := int(math.Ceil(math.Pi / math.Acos(math.Max(-1, 1-0.33/r)))); want > steps {
			steps = want
		}
	}
	if steps > 2048 {
		steps = 2048
	}
	pts := make([][2]float64, 0, steps)
	for i := 0; i < steps; i++ {
		t := 2 * math.Pi * float64(i) / float64(steps)
		pts = append(pts, [2]float64{cx + cx*math.Cos(t), cy + cy*math.Sin(t)})
	}
	return pts
}

// strokeOutline draws a node's stroke along the given local-space outline.
// Joins are filled dots, matching how ink and line nodes are stroked, so a
// corner does not leave a notch.
func (rc *rctx) strokeOutline(m mat, node map[string]any, outline [][2]float64, closed bool) {
	if len(outline) < 2 {
		return
	}
	stroke := asObj(node["stroke"])
	if stroke == nil {
		return
	}
	paint := pdfPaint(asObj(stroke["fill"]))
	if !paint.ok {
		return
	}
	width := asNum(stroke["width"])
	if width <= 0 {
		return
	}
	rc.strokePolyline(transformPts(m, outline), width*avgScale(m), rasterColor(paint, rc.alpha), closed)
}

// strokePolyline strokes a device-space polyline as one thick quad per segment
// with filled joins, the same approximation line and ink nodes use. Shared by
// shape strokes and outline effects so both agree.
func (rc *rctx) strokePolyline(dev [][2]float64, widthDev float64, col color.RGBA, closed bool) {
	if len(dev) < 2 || widthDev <= 0 {
		return
	}
	if col.A == 0 {
		return
	}
	hw := widthDev / 2
	if hw < 0.4 {
		hw = 0.4 // keep a hairline visible instead of dropping out
	}
	n := len(dev)
	last := n - 1
	if closed {
		last = n
	}
	// One rasterizer for the whole stroke. Filling each segment separately
	// allocates a full-canvas rasterizer per segment, which for a flattened
	// ellipse is well over a hundred full-canvas passes and gigabytes of churn.
	// Non-zero winding also means the overlapping quads and joins merge into a
	// single shape, so a translucent stroke no longer double-darkens at joins.
	subpaths := make([][][2]float64, 0, last*2)
	for i := 0; i < last; i++ {
		p0 := dev[i]
		p1 := dev[(i+1)%n]
		dx, dy := p1[0]-p0[0], p1[1]-p0[1]
		length := math.Hypot(dx, dy)
		if length == 0 {
			continue
		}
		nx, ny := -dy/length*hw, dx/length*hw
		subpaths = append(subpaths, [][2]float64{{p0[0] + nx, p0[1] + ny}, {p1[0] + nx, p1[1] + ny}, {p1[0] - nx, p1[1] - ny}, {p0[0] - nx, p0[1] - ny}})
		if hw > 0.75 {
			subpaths = append(subpaths, octagon(p1[0], p1[1], hw)) // join
		}
	}
	rc.fillSubpaths(subpaths, col)
}

// fillSubpaths fills many polygons in ONE rasterizer pass (non-zero winding, so
// overlaps merge instead of compounding).
func (rc *rctx) fillSubpaths(polys [][][2]float64, col color.RGBA) {
	if col.A == 0 || len(polys) == 0 {
		return
	}
	r := vector.NewRasterizer(rc.w, rc.h)
	drew := false
	for _, pts := range polys {
		if len(pts) < 3 {
			continue
		}
		r.MoveTo(float32(pts[0][0]), float32(pts[0][1]))
		for _, p := range pts[1:] {
			r.LineTo(float32(p[0]), float32(p[1]))
		}
		r.ClosePath()
		drew = true
	}
	if drew {
		r.Draw(rc.dst, rc.dst.Bounds(), image.NewUniform(col), image.Point{})
	}
}

// octagon returns the round-ish join polygon, wound the SAME direction as the
// stroke quads. Winding matters because the whole stroke is one non-zero-winding
// rasterizer pass: a join wound the other way cancels the quads it overlaps and
// punches a hole clean through the stroke at every corner.
func octagon(cx, cy, r float64) [][2]float64 {
	pts := make([][2]float64, 0, 8)
	for i := 7; i >= 0; i-- {
		t := math.Pi * 2 * float64(i) / 8
		pts = append(pts, [2]float64{cx + r*math.Cos(t), cy + r*math.Sin(t)})
	}
	return pts
}

// rasterImage draws an image node into its (transformed) box. The pixel bytes
// come from an embedded data URL on node["src"] (set by the video export handler
// from the workspace asset); a node with only source.assetId and no embedded src
// draws nothing (design PNG image export is a separate gap). Fit is cover
// (default: fill the box, crop overflow) or contain (fit inside, letterbox).
// Rotation is approximated by clipping to the rotated box, not rotating pixels.
func (rc *rctx) rasterImage(m mat, node map[string]any) {
	src := asStr(node["src"])
	if src == "" {
		return
	}
	raw, ok := dataURLBytes(src)
	if !ok {
		return
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return
	}
	w, h := sizeOf(node)
	if w <= 0 || h <= 0 {
		return
	}
	pts := transformPts(m, [][2]float64{{0, 0}, {w, 0}, {w, h}, {0, h}})
	minX, minY, maxX, maxY := pts[0][0], pts[0][1], pts[0][0], pts[0][1]
	for _, p := range pts {
		minX, minY = math.Min(minX, p[0]), math.Min(minY, p[1])
		maxX, maxY = math.Max(maxX, p[0]), math.Max(maxY, p[1])
	}
	dst := image.Rect(int(math.Round(minX)), int(math.Round(minY)), int(math.Round(maxX)), int(math.Round(maxY)))
	if dst.Dx() <= 0 || dst.Dy() <= 0 {
		return
	}
	sb := img.Bounds()
	sw, sh := sb.Dx(), sb.Dy()
	if sw <= 0 || sh <= 0 {
		return
	}
	canvas := image.NewRGBA(image.Rect(0, 0, rc.w, rc.h))
	if asStr(node["fit"]) == "contain" {
		scale := math.Min(float64(dst.Dx())/float64(sw), float64(dst.Dy())/float64(sh))
		fw, fh := int(float64(sw)*scale), int(float64(sh)*scale)
		ox := dst.Min.X + (dst.Dx()-fw)/2
		oy := dst.Min.Y + (dst.Dy()-fh)/2
		xdraw.CatmullRom.Scale(canvas, image.Rect(ox, oy, ox+fw, oy+fh), img, sb, xdraw.Over, nil)
	} else {
		// cover: center-crop the source to the box aspect, then scale to fill.
		dstAspect := float64(dst.Dx()) / float64(dst.Dy())
		var crop image.Rectangle
		if float64(sw)/float64(sh) > dstAspect {
			cw := int(float64(sh) * dstAspect)
			x0 := sb.Min.X + (sw-cw)/2
			crop = image.Rect(x0, sb.Min.Y, x0+cw, sb.Max.Y)
		} else {
			ch := int(float64(sw) / dstAspect)
			y0 := sb.Min.Y + (sh-ch)/2
			crop = image.Rect(sb.Min.X, y0, sb.Max.X, y0+ch)
		}
		xdraw.CatmullRom.Scale(canvas, dst, img, crop, xdraw.Over, nil)
	}
	rc.fillPathSrc(pts, rc.paint(canvas))
}

func (rc *rctx) rasterEllipse(m mat, w, h float64, fill map[string]any) {
	rx, ry, cx, cy := w/2, h/2, w/2, h/2
	const k = 0.5522847498
	ox, oy := rx*k, ry*k
	tp := func(x, y float64) [2]float64 { ax, ay := m.apply(x, y); return [2]float64{ax, ay} }
	start := tp(cx-rx, cy)
	cubics := [][3][2]float64{
		{tp(cx-rx, cy+oy), tp(cx-ox, cy+ry), tp(cx, cy+ry)},
		{tp(cx+ox, cy+ry), tp(cx+rx, cy+oy), tp(cx+rx, cy)},
		{tp(cx+rx, cy-oy), tp(cx+ox, cy-ry), tp(cx, cy-ry)},
		{tp(cx-ox, cy-ry), tp(cx-rx, cy-oy), tp(cx-rx, cy)},
	}
	pts := [][2]float64{start}
	for _, c := range cubics {
		pts = append(pts, c[0], c[1], c[2])
	}
	// Image / pattern / gradient / solid fill, clipped to the ellipse (its
	// device bounding box drives the fill extent).
	switch asStr(fill["type"]) {
	case "image":
		if src := rc.imageFillSrc(bboxOf(pts), fill, avgScale(m)); src != nil {
			rc.fillBeziersSrc(start, cubics, rc.paint(src))
		}
		return
	case "pattern":
		if src := rc.patternFillSrc(bboxOf(pts), fill, avgScale(m)); src != nil {
			rc.fillBeziersSrc(start, cubics, rc.paint(src))
		}
		return
	}
	if g := parseGradient(fill); g.ok {
		rc.fillBeziersSrc(start, cubics, rc.paint(g.source(bboxOf(pts), rc.dst.Bounds())))
		return
	}
	rc.fillBeziers(start, cubics, rasterColor(pdfPaint(fill), rc.alpha))
}

// tracePathContour traces one subpath's segments into the rasterizer.
func tracePathContour(r *vector.Rasterizer, m mat, segs []any, closed bool) {
	first := asObj(segs[0])
	sx, sy := m.apply(asNum(first["x"]), asNum(first["y"]))
	r.MoveTo(float32(sx), float32(sy))
	count := len(segs) - 1
	if closed {
		count = len(segs)
	}
	for i := 0; i < count; i++ {
		from := asObj(segs[i])
		to := asObj(segs[(i+1)%len(segs)])
		cOut := asObj(from["cOut"])
		cIn := asObj(to["cIn"])
		tx, ty := m.apply(asNum(to["x"]), asNum(to["y"]))
		if cOut != nil || cIn != nil {
			c1x, c1y := asNum(from["x"]), asNum(from["y"])
			if cOut != nil {
				c1x, c1y = asNum(cOut["x"]), asNum(cOut["y"])
			}
			c2x, c2y := asNum(to["x"]), asNum(to["y"])
			if cIn != nil {
				c2x, c2y = asNum(cIn["x"]), asNum(cIn["y"])
			}
			a1, b1 := m.apply(c1x, c1y)
			a2, b2 := m.apply(c2x, c2y)
			r.CubeTo(float32(a1), float32(b1), float32(a2), float32(b2), float32(tx), float32(ty))
		} else {
			r.LineTo(float32(tx), float32(ty))
		}
	}
	r.ClosePath()
}

func (rc *rctx) rasterPath(m mat, node map[string]any) {
	segs := asArr(node["segments"])
	if len(segs) == 0 {
		return
	}
	closed := asBool(node["closed"])
	// Extra contours of a compound path (schema v15): all filled together under
	// the even-odd rule so interior contours cut holes.
	type contour struct {
		segs   []any
		closed bool
	}
	contours := []contour{{segs, closed}}
	for _, c := range asArr(node["contours"]) {
		co := asObj(c)
		if cs := asArr(co["segments"]); len(cs) >= 2 {
			contours = append(contours, contour{cs, asBool(co["closed"])})
		}
	}
	// Fill source: solid color, gradient, image, or pattern. Its extent is the
	// node's box (matching the browser's objectBoundingBox convention), or the
	// path's device bounds when the node carries no size.
	w, h := sizeOf(node)
	var bb [4]float64
	if w > 0 && h > 0 {
		bb = bboxOf(transformPts(m, [][2]float64{{0, 0}, {w, 0}, {w, h}, {0, h}}))
	} else {
		var pts [][2]float64
		for _, c := range contours {
			for _, sv := range c.segs {
				so := asObj(sv)
				x, y := m.apply(asNum(so["x"]), asNum(so["y"]))
				pts = append(pts, [2]float64{x, y})
			}
		}
		if len(pts) == 0 {
			return
		}
		bb = bboxOf(pts)
	}
	fill := firstFill(node)
	var src image.Image
	switch asStr(fill["type"]) {
	case "image":
		if isrc := rc.imageFillSrc(bb, fill, avgScale(m)); isrc != nil {
			src = rc.paint(isrc)
		}
	case "pattern":
		if psrc := rc.patternFillSrc(bb, fill, avgScale(m)); psrc != nil {
			src = rc.paint(psrc)
		}
	default:
		if g := parseGradient(fill); g.ok {
			src = rc.paint(g.source(bb, rc.dst.Bounds()))
		} else if col := rasterColor(pdfPaint(fill), rc.alpha); col.A != 0 {
			src = image.NewUniform(col)
		}
	}
	if src == nil {
		return
	}
	if len(contours) == 1 {
		r := vector.NewRasterizer(rc.w, rc.h)
		tracePathContour(r, m, segs, closed)
		r.Draw(rc.dst, rc.dst.Bounds(), src, image.Point{})
		return
	}
	// The vector rasterizer accumulates non-zero winding, which cannot cut a
	// hole whose contour winds the same direction as its parent. Rasterize each
	// contour's coverage separately and fold it in as |acc - mask| (a soft XOR),
	// which realizes the even-odd rule on antialiased coverage.
	acc := image.NewAlpha(rc.dst.Bounds())
	tmp := image.NewAlpha(rc.dst.Bounds())
	for _, c := range contours {
		for i := range tmp.Pix {
			tmp.Pix[i] = 0
		}
		r := vector.NewRasterizer(rc.w, rc.h)
		tracePathContour(r, m, c.segs, c.closed)
		r.Draw(tmp, tmp.Bounds(), image.Opaque, image.Point{})
		for i := range acc.Pix {
			d := int(acc.Pix[i]) - int(tmp.Pix[i])
			if d < 0 {
				d = -d
			}
			acc.Pix[i] = uint8(d)
		}
	}
	draw.DrawMask(rc.dst, rc.dst.Bounds(), src, image.Point{}, acc, image.Point{}, draw.Over)
}

// rasterLine draws each polyline segment as a thick filled quad (stroke approx).
func (rc *rctx) rasterLine(m mat, node map[string]any) {
	pts := asArr(node["points"])
	if len(pts) < 2 {
		return
	}
	stroke := asObj(node["stroke"])
	if stroke == nil {
		return
	}
	col := rasterColor(pdfPaint(asObj(stroke["fill"])), rc.alpha)
	width := asNum(stroke["width"])
	if width <= 0 {
		width = 1
	}
	// Half-width in device space (approx: scale by the matrix's average scale).
	scale := (math.Hypot(m.a, m.b) + math.Hypot(m.c, m.d)) / 2
	hw := width * scale / 2
	for i := 0; i < len(pts)-1; i++ {
		p0 := asObj(pts[i])
		p1 := asObj(pts[i+1])
		x0, y0 := m.apply(asNum(p0["x"]), asNum(p0["y"]))
		x1, y1 := m.apply(asNum(p1["x"]), asNum(p1["y"]))
		dx, dy := x1-x0, y1-y0
		length := math.Hypot(dx, dy)
		if length == 0 {
			continue
		}
		nx, ny := -dy/length*hw, dx/length*hw
		rc.fillPath([][2]float64{{x0 + nx, y0 + ny}, {x1 + nx, y1 + ny}, {x1 - nx, y1 - ny}, {x0 - nx, y0 - ny}}, col)
	}
}

// runText applies the run's case transform to its text.
func runText(ro, style map[string]any) string {
	text := asStr(ro["text"])
	switch asStr(style["case"]) {
	case "upper":
		return strings.ToUpper(text)
	case "lower":
		return strings.ToLower(text)
	}
	return text
}

// runLineHeight is the run's line height in design units: an explicit multiple
// or absolute wins, else the engine's default 1.2 multiple.
func runLineHeight(style map[string]any, size float64) float64 {
	switch lh := style["lineHeight"].(type) {
	case float64:
		return size * lh
	case map[string]any:
		v := asNum(lh["value"])
		if asStr(lh["mode"]) == "absolute" {
			return v
		}
		if v > 0 {
			return size * v
		}
	}
	return size * 1.2
}

// textChunk is a word or a whitespace run; line breaking happens between them.
type textChunk struct {
	text string
	ws   bool
}

// wrapChunks splits text into alternating word and whitespace chunks so greedy
// word wrapping can break between words, matching @hc/text's layout. A newline
// inside a run is treated as whitespace (not a hard break), as on the browser.
func wrapChunks(s string) []textChunk {
	var out []textChunk
	if s == "" {
		return out
	}
	var b strings.Builder
	curWS := false
	started := false
	isWS := func(r rune) bool { return r == ' ' || r == '\t' || r == '\n' || r == '\r' }
	for _, r := range s {
		w := isWS(r)
		if started && w != curWS {
			out = append(out, textChunk{text: b.String(), ws: curWS})
			b.Reset()
		}
		b.WriteRune(r)
		curWS = w
		started = true
	}
	if b.Len() > 0 {
		out = append(out, textChunk{text: b.String(), ws: curWS})
	}
	return out
}

func (rc *rctx) rasterText(m mat, node map[string]any) {
	scale := avgScale(m)
	// Letter spacing means per-glyph drawing, so measuring shares the walk.
	// Measure what will DRAW: Arabic measures its SHAPED forms (a lam-alef
	// ligature merges two runes into one glyph, changing the width), and an
	// uncovered rune measures through the same registered-font fallback the
	// draw pass uses instead of contributing zero width - otherwise wrap and
	// alignment are computed from widths the drawn line does not have. A
	// style run that splits mid-word shapes each fragment without seam
	// context here (the draw pass joins them), a small documented
	// approximation.
	measure := func(face font.Face, style map[string]any, text string, ls float64) float64 {
		if hasArabic(text) {
			text = ShapeArabic(text, 0, 0)
		}
		fam := asStr(style["fontFamily"])
		wght := int(asNum(asObj(style["axes"])["wght"]))
		size := asNum(style["fontSize"])
		if size == 0 {
			size = 16
		}
		advOf := func(r rune) (float64, bool) {
			if adv, ok := face.GlyphAdvance(r); ok {
				return float64(adv>>6)/scale + ls, true
			}
			if alt := faceCovering(r, fam, wght, size*scale, rc.font); alt != nil {
				adv, _ := alt.GlyphAdvance(r)
				_ = alt.Close()
				return float64(adv>>6)/scale + ls, true
			}
			return 0, false
		}
		w := 0.0
		for _, r := range text {
			if aw, ok := advOf(r); ok {
				w += aw
				continue
			}
			for _, br := range UnshapeFallback(r) {
				if aw, ok := advOf(br); ok {
					w += aw
				}
			}
		}
		return w
	}
	runFace := func(style map[string]any) (font.Face, float64) {
		size := asNum(style["fontSize"])
		if size == 0 {
			size = 16
		}
		// Registered real fonts win (glyph-true export); otherwise the embedded
		// fallback keeps text legible and positioned.
		fnt := lookupFont(asStr(style["fontFamily"]), int(asNum(asObj(style["axes"])["wght"])))
		if fnt == nil {
			fnt = rc.font
		}
		face, err := opentype.NewFace(fnt, &opentype.FaceOptions{Size: size * scale, DPI: 72, Hinting: font.HintingFull})
		if err != nil {
			return nil, size
		}
		return face, size
	}

	box := asObj(node["box"])
	boxW := asNum(box["width"])
	if boxW == 0 {
		boxW = asNum(asObj(node["size"])["width"])
	}
	boxH := asNum(box["height"])
	if boxH == 0 {
		boxH = asNum(asObj(node["size"])["height"])
	}
	pad := asObj(box["padding"])
	padL, padR := asNum(pad["l"]), asNum(pad["r"])
	padT, padB := asNum(pad["t"]), asNum(pad["b"])
	contentW := boxW - padL - padR
	if contentW < 0 {
		contentW = 0
	}
	// Wrap to the content width (matches @hc/text: wrap unless the box auto-sizes
	// its width). With no known width, fall back to no wrap (one line per
	// paragraph) rather than breaking every word.
	wrap := asStr(box["mode"]) != "autoWidth" && contentW > 0

	// A drawn segment and a laid-out visual line.
	type seg struct {
		text  string
		style map[string]any
	}
	type vline struct {
		segs   []seg
		width  float64
		height float64
		align  string
		dir    string
	}
	var lines []vline

	// Layout pass: build visual lines per paragraph, wrapping between words.
	for _, para := range asArr(node["content"]) {
		po := asObj(para)
		pstyle := asObj(po["style"])
		align := asStr(pstyle["align"])
		// Base direction (F38 FR-10), resolved exactly as @hc/text does so the
		// export matches the canvas.
		var paraText strings.Builder
		for _, run := range asArr(po["runs"]) {
			paraText.WriteString(runText(asObj(run), asObj(asObj(run)["style"])))
		}
		dir := ResolveBaseDirection(paraText.String(), asStr(pstyle["direction"]))
		// A right-to-left paragraph reads from the right, so an author who never
		// chose an alignment gets one that follows the text.
		if dir == "rtl" && align == "" {
			align = "right"
		}
		cur := vline{align: align, dir: dir}
		firstSize := 0.0
		flush := func() {
			if cur.height == 0 {
				if firstSize > 0 {
					cur.height = firstSize * 1.2
				} else {
					cur.height = 16 * 1.2
				}
			}
			lines = append(lines, cur)
			// Carry the paragraph's base direction onto continuation lines:
			// dropping it made every wrapped RTL line resolve bidi with an
			// LTR base, putting trailing punctuation on the wrong side.
			cur = vline{align: align, dir: dir}
		}
		for _, run := range asArr(po["runs"]) {
			ro := asObj(run)
			style := asObj(ro["style"])
			face, size := runFace(style)
			if firstSize == 0 {
				firstSize = size
			}
			lh := runLineHeight(style, size)
			if face == nil {
				cur.height = math.Max(cur.height, lh)
				continue
			}
			ls := asNum(style["letterSpacing"])
			for _, chunk := range wrapChunks(runText(ro, style)) {
				w := measure(face, style, chunk.text, ls)
				if wrap && cur.width > 0 && cur.width+w > contentW && !chunk.ws {
					flush()
				}
				cur.segs = append(cur.segs, seg{text: chunk.text, style: style})
				cur.width += w
				cur.height = math.Max(cur.height, lh)
			}
			_ = face.Close()
		}
		flush() // always emit at least one (possibly empty) line per paragraph
	}

	total := 0.0
	for _, ln := range lines {
		total += ln.height
	}
	y := padT
	switch asStr(box["verticalAlign"]) {
	case "middle":
		y = padT + (boxH-padT-padB-total)/2
	case "bottom":
		y = boxH - padB - total
	}

	// Draw pass: baseline sits near the line's bottom (ascent approximation).
	for _, ln := range lines {
		// Display order. Unlike the browser, this renderer draws rune by rune and
		// gets no bidi from the text stack, so OrderVisual also reverses the
		// characters inside right-to-left runs.
		texts := make([]string, len(ln.segs))
		joined := strings.Builder{}
		for i, sg := range ln.segs {
			texts[i] = sg.text
			joined.WriteString(sg.text)
		}
		if ln.dir == "rtl" || HasRtl(joined.String()) {
			ordered := make([]seg, 0, len(ln.segs))
			for _, p := range OrderVisual(texts, ln.dir) {
				ordered = append(ordered, seg{text: p.Text, style: ln.segs[p.Item].style})
			}
			ln.segs = ordered
		}
		y += ln.height
		x := padL
		switch ln.align {
		case "center":
			x = padL + (contentW-ln.width)/2
		case "right":
			x = padL + (contentW - ln.width)
		}
		for _, sg := range ln.segs {
			face, _ := runFace(sg.style)
			if face == nil {
				continue
			}
			col := pdfPaint(asObj(sg.style["fill"]))
			if !col.ok {
				col = pdfColor{ok: true}
			}
			src := image.NewUniform(rasterColor(col, rc.alpha))
			ls := asNum(sg.style["letterSpacing"])
			fam := asStr(sg.style["fontFamily"])
			wght := int(asNum(asObj(sg.style["axes"])["wght"]))
			size := asNum(sg.style["fontSize"])
			if size == 0 {
				size = 16
			}
			// The run's own face may not cover a rune: the embedded fallback
			// has no Hebrew, Arabic, Indic or CJK glyphs. Skipping silently is
			// what made non-Latin text export blank, so fall back across the
			// registered fonts; drawRune reports whether anything drew.
			drawRune := func(r rune) bool {
				glyphFace := face
				if _, ok := face.GlyphAdvance(r); !ok {
					if alt := faceCovering(r, fam, wght, size*scale, rc.font); alt != nil {
						glyphFace = alt
					} else {
						return false
					}
				}
				dx, dy := m.apply(x, y)
				d := &font.Drawer{Dst: rc.dst, Src: src, Face: glyphFace, Dot: fixed.P(int(math.Round(dx)), int(math.Round(dy)))}
				d.DrawString(string(r))
				adv, _ := glyphFace.GlyphAdvance(r)
				x += float64(adv>>6)/scale + ls
				if glyphFace != face {
					_ = glyphFace.Close()
				}
				return true
			}
			for _, r := range sg.text {
				if drawRune(r) {
					continue
				}
				// Nothing covers this rune. A shaped presentation form falls
				// back to its base letter(s) - many Arabic fonts shape via
				// OpenType and cover the base block but not Forms-B in their
				// cmap - so shaping never renders WORSE than the unshaped
				// export did. Anything still missing is reported once.
				drew := false
				for _, br := range UnshapeFallback(r) {
					if drawRune(br) {
						drew = true
					}
				}
				if !drew {
					noteMissingGlyph(r)
				}
			}
			_ = face.Close()
		}
	}
}

func (rc *rctx) rasterNode(m mat, node map[string]any) {
	if asBool(node["hidden"]) {
		return
	}
	// Blend modes and drop shadows need the node drawn in isolation before it
	// meets the page, so they get a transparent layer and a composite step. The
	// browser gets this from Canvas2D for free; without it a multiply layer
	// exports as normal and a shadow exports as nothing. Nodes with neither draw
	// straight into the page buffer, so the common path is unchanged.
	mode, shadows, effects := blendModeOf(node), shadowsOf(node), effectsOf(node)
	if mode != "" || len(shadows) > 0 || hasLayerEffect(effects) {
		rc.rasterLayered(m, node, mode, shadows, effects)
		return
	}
	rc.rasterNodeDirect(m, node)
}

// rasterLayered draws the node into its own transparent layer, paints any drop
// shadows beneath it, then composites the layer with its blend mode.
func (rc *rctx) rasterLayered(m mat, node map[string]any, mode string, shadows []shadowSpec, effects []effectSpec) {
	page := rc.dst
	layer := rc.takeLayer()
	defer rc.releaseLayer(layer)
	// The node's OWN opacity is applied inside the layer, because
	// rasterNodeDirect applies it while drawing the subtree (which also keeps
	// group opacity behaving exactly as it did before isolation existed).
	// Only the INHERITED alpha is applied on the way back in; multiplying by the
	// node's opacity again here would darken it twice.
	prevAlpha := rc.alpha
	rc.dst, rc.alpha = layer, 1
	rc.rasterNodeDirect(m, node)
	rc.dst, rc.alpha = page, prevAlpha
	// Colour and spatial effects transform the node's own pixels, in the order
	// they are declared (CSS filters compose in sequence, so the order is part
	// of the result). Adjustments fold into one matrix per run so a stack of
	// sliders is a single pass.
	cm := m.compose(nodeMat(node))
	xf := offsetXformOf(cm)
	scale := xf.scale
	pending := identityMatrix()
	flush := func() {
		applyColorMatrix(layer, pending)
		pending = identityMatrix()
	}
	for _, e := range effects {
		switch e.kind {
		case "adjustment":
			ops, _ := e.raw["ops"].([]any)
			for _, o := range ops {
				oo := asObj(o)
				if oo == nil {
					continue
				}
				mtx, blurPx, known := adjustmentMatrix(asStr(oo["name"]), asNum(oo["value"]))
				if !known {
					continue
				}
				pending = pending.mul(mtx)
				if blurPx > 0 {
					flush()
					blurLayer(layer, blurPx*scale)
				}
			}
		case "blur":
			if r := asNum(e.raw["radius"]); r > 0 {
				flush()
				blurLayer(layer, r*scale)
			}
		case "duotone":
			flush()
			applyDuotoneLayer(layer, e.raw)
		}
	}
	flush()
	// The outline strokes the node's box OVER its own content (the browser
	// strokes it after painting the node), so it belongs in the layer and
	// participates in the node's blend mode and opacity.
	drawOutlineNow := func() {
		if !hasOutline(effects) {
			return
		}
		into, prevA := rc.dst, rc.alpha
		// Inside the layer the node's own opacity is the only alpha in force;
		// the inherited part is applied to the finished layer below. Tinting
		// with rc.alpha here would apply the inherited alpha a second time.
		rc.dst, rc.alpha = layer, nodeOpacity(node)
		rc.outlineBox(cm, node, effects)
		rc.dst, rc.alpha = into, prevA
	}
	// Shadows and glows belong to the node's own image, not to the page: the
	// browser puts them in the CSS filter, which runs BEFORE the composite
	// operation, so a shadow under a screen-blended node is screened too.
	// Painting them straight onto the page would exempt them from the blend and
	// would also let the node blend against its own shadow.
	if len(shadows) > 0 || hasGlow(effects) {
		// The outline is stroked after the shadow is cast, because the browser
		// strokes it once the filter is cleared: an outline does not thicken
		// the silhouette its own node's shadow comes from.
		under := rc.takeLayer()
		defer rc.releaseLayer(under)
		for _, e := range effects {
			if e.kind == "glow" {
				drawGlow(under, layer, e.raw, xf, 1)
			}
		}
		if len(shadows) > 0 {
			// The silhouette already carries the node's opacity, so the shadow
			// fades with the node for free.
			drawShadows(under, layer, shadows, xf, 1)
		}
		compositeLayer(under, layer, "normal") // the node over its own shadow
		layer = under
	}
	drawOutlineNow()
	if prevAlpha < 1 {
		scaleLayerAlpha(layer, prevAlpha)
	}
	if mode == "" {
		mode = "normal"
	}
	compositeLayer(page, layer, mode)
}

// nodeOpacity is a node's own opacity, clamped, defaulting to fully opaque.
func nodeOpacity(node map[string]any) float64 {
	o, ok := node["opacity"].(float64)
	if !ok || o >= 1 {
		return 1
	}
	if o < 0 {
		return 0
	}
	return o
}

func (rc *rctx) rasterNodeDirect(m mat, node map[string]any) {
	// Node opacity multiplies down the subtree (groups included, via recursion).
	prev := rc.alpha
	if o := nodeOpacity(node); o < 1 {
		rc.alpha = prev * o
	}
	defer func() { rc.alpha = prev }()
	cm := m.compose(nodeMat(node))
	switch asStr(node["type"]) {
	case "shape":
		rc.rasterShape(cm, node)
	case "path":
		rc.rasterPath(cm, node)
	case "line":
		rc.rasterLine(cm, node)
	case "text":
		rc.rasterText(cm, node)
	case "image":
		rc.rasterImage(cm, node)
	case "ink":
		rc.rasterInk(cm, node)
	case "sticky":
		rc.rasterSticky(cm, node)
	case "connector":
		rc.rasterConnector(node)
	case "boolean":
		rc.rasterBoolean(cm, node)
	case "qr":
		rc.rasterQR(cm, node)
	case "table":
		rc.rasterTable(cm, node)
	case "chart":
		rc.rasterChart(cm, node)
	case "stamp":
		rc.rasterStamp(cm, node)
	case "sticker", "icon", "embed", "video":
		// Not fully rasterized server-side; draw the same neutral skeleton the
		// browser shows for these (sticker/icon/embed) or for a video whose
		// poster frame isn't decoded, so nothing renders as an invisible hole.
		rc.placeholderBox(cm, node)
	case "group", "frame", "grid":
		// A frame paints its own background fill behind its children (a group/grid
		// has none), matching the browser which draws the frame fill then content.
		if asStr(node["type"]) == "frame" {
			if fill := firstFill(node); fill != nil {
				if w, h := sizeOf(node); w > 0 && h > 0 {
					rc.fillPolyPaint(transformPts(cm, [][2]float64{{0, 0}, {w, 0}, {w, h}, {0, h}}), fill, avgScale(cm))
				}
			}
		}
		for _, ch := range childrenOf(node) {
			rc.rasterNode(cm, asObj(ch))
		}
	}
}

// rasterInk fills the ink stroke as a single variable-offset ribbon (one fill, so
// a semi-transparent marker/highlighter does not double-darken at joins), mirror-
// ing the engine's drawInk.
func (rc *rctx) rasterInk(m mat, node map[string]any) {
	pts := transformPts(m, inkPoints(node))
	if len(pts) == 0 {
		return
	}
	col, width, opacity, mode := inkBrush(node)
	c := rasterColor(col, opacity)
	if c.A == 0 {
		return
	}
	hw := math.Max(0.5, width*avgScale(m)/2)
	if len(pts) == 1 {
		rc.fillDot(pts[0][0], pts[0][1], hw, c)
		return
	}
	n := len(pts)
	left := make([][2]float64, n)
	right := make([][2]float64, n)
	for i := 0; i < n; i++ {
		prev := pts[max(0, i-1)]
		next := pts[min(n-1, i+1)]
		length := math.Hypot(next[0]-prev[0], next[1]-prev[1])
		if length == 0 {
			length = 1
		}
		nx := -(next[1] - prev[1]) / length
		ny := (next[0] - prev[0]) / length
		left[i] = [2]float64{pts[i][0] + nx*hw, pts[i][1] + ny*hw}
		right[i] = [2]float64{pts[i][0] - nx*hw, pts[i][1] - ny*hw}
	}
	poly := make([][2]float64, 0, n*2)
	poly = append(poly, left...)
	for i := n - 1; i >= 0; i-- {
		poly = append(poly, right[i])
	}
	rc.fillPath(poly, c)
	// Round end caps for pen/marker (the engine does the same); highlighter keeps
	// flat chisel ends. Skipped for translucent ink to avoid double-darkening tips.
	if mode != "highlighter" && opacity >= 1 {
		rc.fillDot(pts[0][0], pts[0][1], hw, c)
		rc.fillDot(pts[n-1][0], pts[n-1][1], hw, c)
	}
}

func (rc *rctx) rasterSticky(m mat, node map[string]any) {
	w, h := sizeOf(node)
	rc.fillPath(transformPts(m, [][2]float64{{0, 0}, {w, 0}, {w, h}, {0, h}}), rasterColor(pdfPaint(asObj(node["fill"])), rc.alpha))
	text := asStr(node["text"])
	if text == "" {
		return
	}
	fontPx := 20.0
	if fs := asNum(node["fontScale"]); fs > 0 {
		fontPx = 20 * fs
	}
	pad := 12.0
	tc := colorComponents(asObj(node["textColor"]))
	if !tc.ok {
		tc = pdfColor{ok: true}
	}
	face, err := opentype.NewFace(rc.font, &opentype.FaceOptions{Size: fontPx * avgScale(m), DPI: 72, Hinting: font.HintingFull})
	if err != nil {
		return
	}
	defer face.Close()
	lineH := fontPx * 1.25
	lines := wrapStickyLines(text, w-pad*2, fontPx)
	// Vertically center the text block in the card, matching the editor.
	y := math.Max(pad, (h-float64(len(lines))*lineH)/2) + fontPx
	for _, ln := range lines {
		if y > h {
			break
		}
		dx, dy := m.apply(pad, y)
		d := &font.Drawer{Dst: rc.dst, Src: image.NewUniform(rasterColor(tc, rc.alpha)), Face: face, Dot: fixed.P(int(math.Round(dx)), int(math.Round(dy)))}
		d.DrawString(ln)
		y += lineH
	}
}

// rasterConnector draws the connector in PAGE space via the output-scale matrix
// (rc.base) - NOT the node's accumulated transform - because connectorPoints
// already returns absolute page coordinates (matching the engine, which cancels
// the connector's world transform). This keeps the line on its endpoints even if
// the connector is grouped/transformed.
func (rc *rctx) rasterConnector(node map[string]any) {
	pts := transformPts(rc.base, connectorPoints(node, rc.boxes))
	if len(pts) < 2 {
		return
	}
	col := rasterColor(connectorStrokeColor(node), rc.alpha)
	if col.A == 0 {
		return
	}
	dw := connectorStrokeWidth(node) * avgScale(rc.base)
	hw := math.Max(0.5, dw/2)
	for i := 0; i < len(pts)-1; i++ {
		x0, y0, x1, y1 := pts[i][0], pts[i][1], pts[i+1][0], pts[i+1][1]
		dx, dy := x1-x0, y1-y0
		length := math.Hypot(dx, dy)
		if length == 0 {
			continue
		}
		nx, ny := -dy/length*hw, dx/length*hw
		rc.fillPath([][2]float64{{x0 + nx, y0 + ny}, {x1 + nx, y1 + ny}, {x1 - nx, y1 - ny}, {x0 - nx, y0 - ny}}, col)
		rc.fillDot(x1, y1, hw, col) // round the joins (opaque, no double-darken)
	}
	if capIs(node, "endCap", "arrow") {
		rc.fillPath(arrowHead(pts[len(pts)-2], pts[len(pts)-1], dw), col)
	}
	if capIs(node, "startCap", "arrow") {
		rc.fillPath(arrowHead(pts[1], pts[0], dw), col)
	}
	if txt, pos := connectorLabel(node); txt != "" {
		at := pointAlong(pts, pos)
		fontPx := 12.0
		face, err := opentype.NewFace(rc.font, &opentype.FaceOptions{Size: fontPx * avgScale(rc.base), DPI: 72, Hinting: font.HintingFull})
		if err == nil {
			defer face.Close()
			tw := float64(len(txt)) * fontPx * avgScale(rc.base) * 0.55
			rc.fillPath([][2]float64{{at[0] - tw/2 - 5, at[1] - 9}, {at[0] + tw/2 + 5, at[1] - 9}, {at[0] + tw/2 + 5, at[1] + 9}, {at[0] - tw/2 - 5, at[1] + 9}}, color.RGBA{R: 255, G: 255, B: 255, A: 235})
			d := &font.Drawer{Dst: rc.dst, Src: image.NewUniform(color.RGBA{R: 51, G: 65, B: 85, A: 255}), Face: face, Dot: fixed.P(int(math.Round(at[0]-tw/2)), int(math.Round(at[1]+4)))}
			d.DrawString(txt)
		}
	}
}

// ToRaster rasterizes one page of a design at the given scale (1 = page pixels)
// over an opaque white background, as a page/design export expects.
func ToRaster(file Design, pageIndex int, scale float64) (*image.RGBA, error) {
	return toRaster(file, pageIndex, scale, false)
}

// toRaster is the shared rasterizer. When transparent is true it skips the white
// fill AND the page background, so only the page's own nodes (with their alpha)
// are drawn onto transparency. That mode mirrors the browser element renderer's
// `skipBackground: true` + transparent clear, and is what the video element
// stager uses so a partial or faded element composites correctly as an overlay
// (an opaque-white element PNG would occlude everything beneath it).
func toRaster(file Design, pageIndex int, scale float64, transparent bool) (*image.RGBA, error) {
	pages := asArr(file["pages"])
	if pageIndex < 0 || pageIndex >= len(pages) {
		return nil, ErrPageRange
	}
	if scale <= 0 {
		scale = 1
	}
	page := asObj(pages[pageIndex])
	w, h := asNum(page["width"]), asNum(page["height"])
	pw := int(math.Round(w * scale))
	ph := int(math.Round(h * scale))
	if pw < 1 {
		pw = 1
	}
	if ph < 1 {
		ph = 1
	}
	// Prefer the embedded Arial-metric fallback (Liberation Sans) so unregistered
	// / "system" text matches the browser's width metrics; fall back to the Go
	// font only if it somehow fails to parse.
	fnt := fallbackFont
	if fnt == nil {
		var err error
		fnt, err = opentype.Parse(goregular.TTF)
		if err != nil {
			return nil, err
		}
	}
	dst := image.NewRGBA(image.Rect(0, 0, pw, ph))
	rc := &rctx{dst: dst, w: pw, h: ph, font: fnt, boxes: pageBoxMap(page), alpha: 1}
	base := matScale(scale)
	rc.base = base

	// Background: opaque white default, then the page fill over it (solid or
	// gradient). Pattern/image backgrounds are not rasterized (left white).
	// Skipped entirely in transparent mode (element overlays keep their alpha).
	if !transparent {
		fullPage := [][2]float64{{0, 0}, {float64(pw), 0}, {float64(pw), float64(ph)}, {0, float64(ph)}}
		rc.fillPath(fullPage, color.RGBA{R: 255, G: 255, B: 255, A: 255})
		if bg := asObj(page["background"]); bg != nil {
			if k := asStr(bg["type"]); k != "pattern" && k != "image" {
				rc.fillPolyPaint(fullPage, bg, scale)
			}
		}
	}

	for _, n := range asArr(page["children"]) {
		rc.rasterNode(base, asObj(n))
	}
	return dst, nil
}

// ToElementPNG rasterizes a page's nodes onto a TRANSPARENT background and
// encodes PNG bytes. Used to stage a footage-free video element (Clip.element)
// for compositing as an overlay, so partial/faded/animated elements keep their
// alpha instead of arriving on an opaque white card.
func ToElementPNG(file Design, pageIndex int, scale float64) ([]byte, error) {
	img, err := toRaster(file, pageIndex, scale, true)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// ToPNG renders a page to PNG bytes.
func ToPNG(file Design, pageIndex int, scale float64) ([]byte, error) {
	img, err := ToRaster(file, pageIndex, scale)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// ToJPEG renders a page to JPEG bytes (over a flattened opaque background).
func ToJPEG(file Design, pageIndex int, scale float64, quality int) ([]byte, error) {
	img, err := ToRaster(file, pageIndex, scale)
	if err != nil {
		return nil, err
	}
	if quality <= 0 || quality > 100 {
		quality = 90
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: quality}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
