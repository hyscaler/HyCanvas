// Raster export (PNG/JPG): pure-Go rasterization of the scene graph via
// golang.org/x/image/vector (anti-aliased, non-zero winding fills). The design
// space is top-left/y-down, matching image space, so no flip is needed; a base
// scale matrix yields the requested output resolution and each node's transform
// composes onto it.
//
// Fidelity notes (v1, documented vs the browser @hc/engine): linear & radial
// gradient fills are rasterized (objectBoundingBox, per-pixel); shape strokes are
// not stroked (line nodes are drawn as thick quads); text uses the embedded Go font
// (goregular), positioned by translation+scale (rotation not applied to glyphs)
// - so text is legible and placed but not glyph-identical to the editor. Vector
// fills, colors, and transforms are faithful.
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
// (linear/radial) or a solid color; an unusable fill draws nothing.
func (rc *rctx) fillPolyPaint(pts [][2]float64, fill map[string]any) {
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
	switch asStr(node["shape"]) {
	case "rect":
		rc.fillPolyPaint(transformPts(m, [][2]float64{{0, 0}, {w, 0}, {w, h}, {0, h}}), fill)
	case "ellipse":
		rc.rasterEllipse(m, w, h, fill)
	case "polygon":
		sides := int(asNum(node["sides"]))
		if sides == 0 {
			sides = 3
		}
		rc.fillPolyPaint(transformPts(m, polygonPoints(w, h, sides)), fill)
	case "triangle":
		rc.fillPolyPaint(transformPts(m, polygonPoints(w, h, 3)), fill)
	case "star":
		pts := int(asNum(node["sides"]))
		if pts == 0 {
			pts = 5
		}
		ir := asNum(node["innerRadius"])
		if ir == 0 {
			ir = 0.5
		}
		rc.fillPolyPaint(transformPts(m, starPoints(w, h, pts, ir)), fill)
	}
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
	// Gradient-fill the ellipse like the polygon shapes (its bounding box drives
	// the gradient extent); otherwise a flat color.
	if g := parseGradient(fill); g.ok {
		pts := [][2]float64{start}
		for _, c := range cubics {
			pts = append(pts, c[0], c[1], c[2])
		}
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
	col := rasterColor(fillColorOf(node), rc.alpha)
	if col.A == 0 {
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
	if len(contours) == 1 {
		r := vector.NewRasterizer(rc.w, rc.h)
		tracePathContour(r, m, segs, closed)
		r.Draw(rc.dst, rc.dst.Bounds(), image.NewUniform(col), image.Point{})
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
	draw.DrawMask(rc.dst, rc.dst.Bounds(), image.NewUniform(col), image.Point{}, acc, image.Point{}, draw.Over)
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

func (rc *rctx) rasterText(m mat, node map[string]any) {
	scale := avgScale(m)
	// Letter spacing means per-glyph drawing, so measuring shares the walk.
	measure := func(face font.Face, text string, ls float64) float64 {
		w := 0.0
		for _, r := range text {
			adv, ok := face.GlyphAdvance(r)
			if !ok {
				continue
			}
			w += float64(adv>>6)/scale + ls
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

	// Measure pass: per paragraph, the line's height and total advance.
	paras := asArr(node["content"])
	lineHeights := make([]float64, len(paras))
	lineWidths := make([]float64, len(paras))
	for i, para := range paras {
		po := asObj(para)
		for _, run := range asArr(po["runs"]) {
			ro := asObj(run)
			style := asObj(ro["style"])
			face, size := runFace(style)
			lineHeights[i] = math.Max(lineHeights[i], runLineHeight(style, size))
			if face == nil {
				continue
			}
			lineWidths[i] += measure(face, runText(ro, style), asNum(style["letterSpacing"]))
			_ = face.Close()
		}
		if lineHeights[i] == 0 {
			lineHeights[i] = 16 * 1.2
		}
	}
	total := 0.0
	for _, h := range lineHeights {
		total += h
	}
	y := 0.0
	switch asStr(box["verticalAlign"]) {
	case "middle":
		y = (boxH - total) / 2
	case "bottom":
		y = boxH - total
	}

	// Draw pass: baseline sits near the line's bottom (ascent approximation).
	for i, para := range paras {
		po := asObj(para)
		y += lineHeights[i]
		x := 0.0
		switch asStr(asObj(po["style"])["align"]) {
		case "center":
			x = (boxW - lineWidths[i]) / 2
		case "right":
			x = boxW - lineWidths[i]
		}
		for _, run := range asArr(po["runs"]) {
			ro := asObj(run)
			style := asObj(ro["style"])
			face, _ := runFace(style)
			if face == nil {
				continue
			}
			col := pdfPaint(asObj(style["fill"]))
			if !col.ok {
				col = pdfColor{ok: true}
			}
			src := image.NewUniform(rasterColor(col, rc.alpha))
			ls := asNum(style["letterSpacing"])
			for _, r := range runText(ro, style) {
				dx, dy := m.apply(x, y)
				d := &font.Drawer{Dst: rc.dst, Src: src, Face: face, Dot: fixed.P(int(math.Round(dx)), int(math.Round(dy)))}
				d.DrawString(string(r))
				adv, _ := face.GlyphAdvance(r)
				x += float64(adv>>6)/scale + ls
			}
			_ = face.Close()
		}
	}
}

func (rc *rctx) rasterNode(m mat, node map[string]any) {
	if asBool(node["hidden"]) {
		return
	}
	// Node opacity multiplies down the subtree (groups included, via recursion).
	prev := rc.alpha
	if o, ok := node["opacity"].(float64); ok && o < 1 {
		if o < 0 {
			o = 0
		}
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
	case "ink":
		rc.rasterInk(cm, node)
	case "sticky":
		rc.rasterSticky(cm, node)
	case "connector":
		rc.rasterConnector(node)
	case "group", "frame", "grid":
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

// ToRaster rasterizes one page of a design at the given scale (1 = page pixels).
func ToRaster(file Design, pageIndex int, scale float64) (*image.RGBA, error) {
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
	fnt, err := opentype.Parse(goregular.TTF)
	if err != nil {
		return nil, err
	}
	dst := image.NewRGBA(image.Rect(0, 0, pw, ph))
	rc := &rctx{dst: dst, w: pw, h: ph, font: fnt, boxes: pageBoxMap(page), alpha: 1}
	base := matScale(scale)
	rc.base = base

	// Background: opaque white default, then the page fill over it (solid or
	// gradient). Pattern/image backgrounds are not rasterized (left white).
	fullPage := [][2]float64{{0, 0}, {float64(pw), 0}, {float64(pw), float64(ph)}, {0, float64(ph)}}
	rc.fillPath(fullPage, color.RGBA{R: 255, G: 255, B: 255, A: 255})
	if bg := asObj(page["background"]); bg != nil {
		if k := asStr(bg["type"]); k != "pattern" && k != "image" {
			rc.fillPolyPaint(fullPage, bg)
		}
	}

	for _, n := range asArr(page["children"]) {
		rc.rasterNode(base, asObj(n))
	}
	return dst, nil
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
