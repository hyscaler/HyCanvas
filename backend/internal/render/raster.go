// Raster export (PNG/JPG): pure-Go rasterization of the scene graph via
// golang.org/x/image/vector (anti-aliased, non-zero winding fills). The design
// space is top-left/y-down, matching image space, so no flip is needed; a base
// scale matrix yields the requested output resolution and each node's transform
// composes onto it.
//
// Fidelity notes (v1, documented vs the browser @hc/engine): gradient fills
// rasterize as their first stop color (flat); shape strokes are not stroked
// (line nodes are drawn as thick quads); text uses the embedded Go font
// (goregular), positioned by translation+scale (rotation not applied to glyphs)
// - so text is legible and placed but not glyph-identical to the editor. Vector
// fills, colors, and transforms are faithful.
package render

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"math"

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
	return color.RGBA{R: clamp(c.r), G: clamp(c.g), B: clamp(c.b), A: clamp(alpha)}
}

// rctx carries the rasterization target.
type rctx struct {
	dst  *image.RGBA
	w, h int
	font *opentype.Font
}

// fillPath rasterizes a closed polygon (device-space points) with a flat color.
func (rc *rctx) fillPath(pts [][2]float64, col color.RGBA) {
	if col.A == 0 || len(pts) < 2 {
		return
	}
	r := vector.NewRasterizer(rc.w, rc.h)
	r.MoveTo(float32(pts[0][0]), float32(pts[0][1]))
	for _, p := range pts[1:] {
		r.LineTo(float32(p[0]), float32(p[1]))
	}
	r.ClosePath()
	r.Draw(rc.dst, rc.dst.Bounds(), image.NewUniform(col), image.Point{})
}

// fillCubic rasterizes a path of cubic segments (device-space) with a flat color.
// segs is a flat list: first a MoveTo point, then triples of (c1,c2,end).
func (rc *rctx) fillBeziers(start [2]float64, cubics [][3][2]float64, col color.RGBA) {
	if col.A == 0 {
		return
	}
	r := vector.NewRasterizer(rc.w, rc.h)
	r.MoveTo(float32(start[0]), float32(start[1]))
	for _, c := range cubics {
		r.CubeTo(float32(c[0][0]), float32(c[0][1]), float32(c[1][0]), float32(c[1][1]), float32(c[2][0]), float32(c[2][1]))
	}
	r.ClosePath()
	r.Draw(rc.dst, rc.dst.Bounds(), image.NewUniform(col), image.Point{})
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
	col := rasterColor(fillColorOf(node), 1)
	switch asStr(node["shape"]) {
	case "rect":
		rc.fillPath(transformPts(m, [][2]float64{{0, 0}, {w, 0}, {w, h}, {0, h}}), col)
	case "ellipse":
		rc.rasterEllipse(m, w, h, col)
	case "polygon":
		sides := int(asNum(node["sides"]))
		if sides == 0 {
			sides = 3
		}
		rc.fillPath(transformPts(m, polygonPoints(w, h, sides)), col)
	case "triangle":
		rc.fillPath(transformPts(m, polygonPoints(w, h, 3)), col)
	case "star":
		pts := int(asNum(node["sides"]))
		if pts == 0 {
			pts = 5
		}
		ir := asNum(node["innerRadius"])
		if ir == 0 {
			ir = 0.5
		}
		rc.fillPath(transformPts(m, starPoints(w, h, pts, ir)), col)
	}
}

func (rc *rctx) rasterEllipse(m mat, w, h float64, col color.RGBA) {
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
	rc.fillBeziers(start, cubics, col)
}

func (rc *rctx) rasterPath(m mat, node map[string]any) {
	segs := asArr(node["segments"])
	if len(segs) == 0 {
		return
	}
	col := rasterColor(fillColorOf(node), 1)
	if col.A == 0 {
		return
	}
	closed := asBool(node["closed"])
	first := asObj(segs[0])
	r := vector.NewRasterizer(rc.w, rc.h)
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
	r.Draw(rc.dst, rc.dst.Bounds(), image.NewUniform(col), image.Point{})
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
	col := rasterColor(pdfPaint(asObj(stroke["fill"])), 1)
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

func (rc *rctx) rasterText(m mat, node map[string]any) {
	y := 0.0
	for _, para := range asArr(node["content"]) {
		po := asObj(para)
		lineHeight := 0.0
		runs := asArr(po["runs"])
		for _, run := range runs {
			size := asNum(asObj(asObj(run)["style"])["fontSize"])
			if size == 0 {
				size = 16
			}
			lineHeight = math.Max(lineHeight, size*1.2)
		}
		if lineHeight == 0 {
			lineHeight = 16 * 1.2
		}
		y += lineHeight
		x := 0.0
		for _, run := range runs {
			ro := asObj(run)
			style := asObj(ro["style"])
			size := asNum(style["fontSize"])
			if size == 0 {
				size = 16
			}
			col := pdfPaint(asObj(style["fill"]))
			if !col.ok {
				col = pdfColor{ok: true}
			}
			scale := (math.Hypot(m.a, m.b) + math.Hypot(m.c, m.d)) / 2
			face, err := opentype.NewFace(rc.font, &opentype.FaceOptions{Size: size * scale, DPI: 72, Hinting: font.HintingFull})
			if err != nil {
				continue
			}
			dx, dy := m.apply(x, y)
			d := &font.Drawer{
				Dst:  rc.dst,
				Src:  image.NewUniform(rasterColor(col, 1)),
				Face: face,
				Dot:  fixed.P(int(math.Round(dx)), int(math.Round(dy))),
			}
			text := asStr(ro["text"])
			d.DrawString(text)
			adv := d.MeasureString(text)
			x += float64(adv>>6) / scale
			_ = face.Close()
		}
	}
}

func (rc *rctx) rasterNode(m mat, node map[string]any) {
	if asBool(node["hidden"]) {
		return
	}
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
	case "group", "frame", "grid":
		for _, ch := range childrenOf(node) {
			rc.rasterNode(cm, asObj(ch))
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
	rc := &rctx{dst: dst, w: pw, h: ph, font: fnt}
	base := matScale(scale)

	// Background: opaque white default if none, else the page fill (flat).
	bgCol := color.RGBA{R: 255, G: 255, B: 255, A: 255}
	if bg := asObj(page["background"]); bg != nil {
		if k := asStr(bg["type"]); k != "pattern" && k != "image" {
			if c := pdfPaint(bg); c.ok {
				bgCol = rasterColor(c, 1)
			}
		}
	}
	rc.fillPath([][2]float64{{0, 0}, {float64(pw), 0}, {float64(pw), float64(ph)}, {0, float64(ph)}}, bgCol)

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
