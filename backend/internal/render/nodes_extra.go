// Rasterizers for node types beyond the core shape/text/image set, so the PNG/
// JPEG/PDF export and the video element-clip path match the browser engine
// (packages/engine/src/render2d.ts) instead of dropping these nodes. Boolean,
// QR, table, and chart draw from data the editor already computed (result path,
// module matrix, cell/series arrays); the chart renderer is a full port of
// drawChart (chrome + every kind). Stamp glyphs render as colored vector icons
// for the fixed whiteboard set. Only sticker/icon/embed/video nodes (and a chart
// with no data) fall back to the neutral placeholder box, the same skeleton the
// browser draws when content is absent.
package render

import (
	"bytes"
	"image"
	"image/color"
	"math"
	"strconv"

	xdraw "golang.org/x/image/draw"
	"golang.org/x/image/font"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/math/fixed"
	"golang.org/x/image/vector"
)

// --- shared helpers ---------------------------------------------------------

// face builds an opentype face for family/weight at the given DEVICE pixel size
// (caller scales the design size by the matrix scale). Registered fonts win;
// otherwise the embedded fallback keeps text legible.
func (rc *rctx) face(family string, weight int, sizePx float64) font.Face {
	fnt := lookupFont(family, weight)
	if fnt == nil {
		fnt = rc.font
	}
	if fnt == nil || sizePx <= 0 {
		return nil
	}
	face, err := opentype.NewFace(fnt, &opentype.FaceOptions{Size: sizePx, DPI: 72, Hinting: font.HintingFull})
	if err != nil {
		return nil
	}
	return face
}

// measureFace returns the advance width (device px) of s in face.
func measureFace(face font.Face, s string) float64 {
	if face == nil {
		return 0
	}
	w := 0.0
	for _, r := range s {
		if adv, ok := face.GlyphAdvance(r); ok {
			w += float64(adv >> 6)
		}
	}
	return w
}

// drawStringDevice draws s with its left baseline at device (dx, dy).
func (rc *rctx) drawStringDevice(face font.Face, col color.RGBA, dx, dy float64, s string) {
	if face == nil || col.A == 0 || s == "" {
		return
	}
	d := &font.Drawer{Dst: rc.dst, Src: image.NewUniform(col), Face: face, Dot: fixed.P(int(math.Round(dx)), int(math.Round(dy)))}
	d.DrawString(s)
}

// strokeSegDevice draws a straight stroke segment (device space) of half-width hw.
func (rc *rctx) strokeSegDevice(x0, y0, x1, y1, hw float64, col color.RGBA) {
	if col.A == 0 || hw <= 0 {
		return
	}
	dx, dy := x1-x0, y1-y0
	length := math.Hypot(dx, dy)
	if length == 0 {
		return
	}
	nx, ny := -dy/length*hw, dx/length*hw
	rc.fillPath([][2]float64{{x0 + nx, y0 + ny}, {x1 + nx, y1 + ny}, {x1 - nx, y1 - ny}, {x0 - nx, y0 - ny}}, col)
}

// placeholderBox draws the neutral skeleton (filled + 1px stroked rect) that the
// browser renders when a node's data is missing (render2d placeholderBox).
func (rc *rctx) placeholderBox(m mat, node map[string]any) {
	w, h := sizeOf(node)
	if w <= 0 || h <= 0 {
		return
	}
	rect := transformPts(m, [][2]float64{{0, 0}, {w, 0}, {w, h}, {0, h}})
	rc.fillPath(rect, rasterColor(pdfColor{r: 0.957, g: 0.957, b: 0.961, ok: true}, rc.alpha))
	stroke := rasterColor(pdfColor{r: 0.831, g: 0.831, b: 0.847, ok: true}, rc.alpha)
	for i := 0; i < len(rect); i++ {
		p0, p1 := rect[i], rect[(i+1)%len(rect)]
		rc.strokeSegDevice(p0[0], p0[1], p1[0], p1[1], 0.5, stroke)
	}
}

// colorFrom reads a schema Color object into an opaque-aware RGBA (alpha applied).
func (rc *rctx) colorFrom(obj map[string]any, fallback pdfColor) color.RGBA {
	c := colorComponents(obj)
	if !c.ok {
		c = fallback
	}
	a := rc.alpha
	if srgb := asObj(obj["srgb"]); srgb != nil {
		if av, present := srgb["a"]; present {
			a *= clamp01(asNum(av))
		}
	}
	return rasterColor(c, a)
}

// --- boolean ----------------------------------------------------------------

// rasterBoolean traces the editor-baked result path (flattened polyline
// subpaths), filling with nonzero winding so holes render, then strokes it. The
// boolean op itself is already resolved into node["result"] by the editor.
func (rc *rctx) rasterBoolean(m mat, node map[string]any) {
	res := asObj(node["result"])
	subs := asArr(res["subpaths"])
	var polys [][][2]float64
	var flat [][2]float64
	for _, sp := range subs {
		anchors := asArr(asObj(sp)["anchors"])
		if len(anchors) == 0 {
			continue
		}
		poly := make([][2]float64, 0, len(anchors))
		for _, a := range anchors {
			ao := asObj(a)
			x, y := m.apply(asNum(ao["x"]), asNum(ao["y"]))
			poly = append(poly, [2]float64{x, y})
			flat = append(flat, [2]float64{x, y})
		}
		polys = append(polys, poly)
	}
	if len(flat) == 0 {
		rc.placeholderBox(m, node)
		return
	}
	if fill := firstFill(node); fill != nil {
		var src image.Image
		if g := parseGradient(fill); g.ok {
			src = rc.paint(g.source(bboxOf(flat), rc.dst.Bounds()))
		} else if col := rasterColor(pdfPaint(fill), rc.alpha); col.A != 0 {
			src = image.NewUniform(col)
		}
		if src != nil {
			r := vector.NewRasterizer(rc.w, rc.h)
			for _, poly := range polys {
				r.MoveTo(float32(poly[0][0]), float32(poly[0][1]))
				for _, p := range poly[1:] {
					r.LineTo(float32(p[0]), float32(p[1]))
				}
				r.ClosePath()
			}
			r.Draw(rc.dst, rc.dst.Bounds(), src, image.Point{})
		}
	}
	if st := asObj(node["stroke"]); st != nil {
		width := asNum(st["width"])
		if width <= 0 {
			width = 1
		}
		hw := width * avgScale(m) / 2
		col := rasterColor(pdfPaint(asObj(st["fill"])), rc.alpha)
		for _, poly := range polys {
			for i := 0; i < len(poly); i++ {
				p0, p1 := poly[i], poly[(i+1)%len(poly)]
				rc.strokeSegDevice(p0[0], p0[1], p1[0], p1[1], hw, col)
			}
		}
	}
}

// --- qr ---------------------------------------------------------------------

// rasterQR paints the editor-computed module matrix as dark squares over the
// background, with a 4-module quiet zone (mirrors render2d drawQr).
func (rc *rctx) rasterQR(m mat, node map[string]any) {
	rows := asArr(node["modules"])
	n := len(rows)
	if n == 0 {
		rc.placeholderBox(m, node)
		return
	}
	w, h := sizeOf(node)
	if w <= 0 || h <= 0 {
		return
	}
	total := float64(n + 8)
	cell := math.Min(w, h) / total
	boxSize := cell * total
	ox := (w-boxSize)/2 + 4*cell
	oy := (h-boxSize)/2 + 4*cell
	// Background over the whole node box.
	rc.fillPolyPaint(transformPts(m, [][2]float64{{0, 0}, {w, 0}, {w, h}, {0, h}}),
		map[string]any{"type": "solid", "color": qrColor(node["background"], 1, 1, 1)}, avgScale(m))
	fg := rc.colorFrom(asObj(node["foreground"]), pdfColor{ok: true})
	for r := 0; r < n; r++ {
		cols := asArr(rows[r])
		for c := 0; c < len(cols); c++ {
			if !asBool(cols[c]) {
				continue
			}
			x0 := ox + float64(c)*cell
			y0 := oy + float64(r)*cell
			rc.fillPath(transformPts(m, [][2]float64{{x0, y0}, {x0 + cell + 0.5, y0}, {x0 + cell + 0.5, y0 + cell + 0.5}, {x0, y0 + cell + 0.5}}), fg)
		}
	}
	// Center logo (bytes inlined by the export handler as node["logoSrc"]); the
	// EC level was bumped to "H" when the logo was set, so covered modules recover.
	if logo := decodeDataURLImage(asStr(node["logoSrc"])); logo != nil {
		// Default 0.22 when unset; any set value is clamped to a scannable range
		// (matches the browser drawQr, so preview and export agree).
		scale := 0.22
		if _, ok := node["logoScale"]; ok {
			scale = math.Max(0.08, math.Min(0.4, asNum(node["logoScale"])))
		}
		box := math.Min(w, h) * scale
		pad := box * 0.16
		cx, cy := w/2, h/2
		bg := rc.colorFrom(asObj(node["background"]), pdfColor{r: 1, g: 1, b: 1, ok: true})
		rc.fillPath(transformPts(m, [][2]float64{{cx - box/2 - pad, cy - box/2 - pad}, {cx + box/2 + pad, cy - box/2 - pad}, {cx + box/2 + pad, cy + box/2 + pad}, {cx - box/2 - pad, cy + box/2 + pad}}), bg)
		pts := transformPts(m, [][2]float64{{cx - box/2, cy - box/2}, {cx + box/2, cy - box/2}, {cx + box/2, cy + box/2}, {cx - box/2, cy + box/2}})
		bb := bboxOf(pts)
		dst := image.Rect(int(math.Round(bb[0])), int(math.Round(bb[1])), int(math.Round(bb[2])), int(math.Round(bb[3])))
		if dst.Dx() > 0 && dst.Dy() > 0 {
			canvas := image.NewRGBA(image.Rect(0, 0, rc.w, rc.h))
			xdraw.CatmullRom.Scale(canvas, dst, logo, logo.Bounds(), xdraw.Over, nil)
			rc.fillPathSrc(pts, rc.paint(canvas))
		}
	}
}

// qrColor returns the color object or a default srgb triple when absent.
func qrColor(v any, r, g, b float64) map[string]any {
	if obj := asObj(v); obj != nil && asObj(obj["srgb"]) != nil {
		return obj
	}
	return map[string]any{"srgb": map[string]any{"r": r, "g": g, "b": b, "a": 1.0}}
}

// --- stamp ------------------------------------------------------------------

// rasterStamp draws the stamp glyph. Emoji have no server-side font, so the
// fixed whiteboard stamp set (WhiteboardSurface STAMP_GLYPHS) is drawn as
// recognizable colored vector icons; an unrecognized glyph falls back to the
// embedded font (covers letters/symbols) or a neutral badge.
func (rc *rctx) rasterStamp(m mat, node map[string]any) {
	glyph := asStr(node["glyph"])
	if glyph == "" {
		glyph = "\U0001F44D"
	}
	w, h := sizeOf(node)
	if w <= 0 || h <= 0 {
		return
	}
	if rc.drawStampGlyph(m, glyph, w, h) {
		return
	}
	scale := avgScale(m)
	fs := math.Max(4, math.Min(w, h)*0.82)
	if face := rc.face("system", 400, fs*scale); face != nil {
		defer face.Close()
		tw := measureFace(face, glyph) / scale
		dx, dy := m.apply(w/2-tw/2, h/2+fs*0.35)
		rc.drawStringDevice(face, rc.solid(0x0f, 0x17, 0x2a), dx, dy, glyph)
		return
	}
	rc.fillCircleLocal(m, w/2, h/2, math.Min(w, h)*0.42, rc.solid(0xe2, 0xe8, 0xf0))
}

// fillCircleLocal fills a circle at local (cx,cy) radius r.
func (rc *rctx) fillCircleLocal(m mat, cx, cy, r float64, col color.RGBA) {
	dx, dy := m.apply(cx, cy)
	rc.fillArcSegment(dx, dy, 0, r*avgScale(m), 0, 2*math.Pi, image.NewUniform(col))
}

// fillPolyLocal fills a local-space polygon.
func (rc *rctx) fillPolyLocal(m mat, pts [][2]float64, col color.RGBA) {
	rc.fillPath(transformPts(m, pts), col)
}

// stampStroke strokes a local-space segment of the given local width.
func (rc *rctx) stampStroke(m mat, x0, y0, x1, y1, width float64, col color.RGBA) {
	a0x, a0y := m.apply(x0, y0)
	a1x, a1y := m.apply(x1, y1)
	rc.strokeSegDevice(a0x, a0y, a1x, a1y, width*avgScale(m)/2, col)
}

// drawStampGlyph draws one of the fixed whiteboard stamp glyphs as a colored
// vector icon. Returns false for an unrecognized glyph.
func (rc *rctx) drawStampGlyph(m mat, glyph string, w, h float64) bool {
	cx, cy := w/2, h/2
	r := math.Min(w, h) * 0.42
	switch glyph {
	case "\U0001F534": // red circle
		rc.fillCircleLocal(m, cx, cy, r, rc.solid(0xe0, 0x1e, 0x1e))
	case "\U0001F7E2": // green circle
		rc.fillCircleLocal(m, cx, cy, r, rc.solid(0x2e, 0xa4, 0x3a))
	case "\U0001F7E1": // yellow circle
		rc.fillCircleLocal(m, cx, cy, r, rc.solid(0xf5, 0xc5, 0x18))
	case "⭐": // star
		rc.fillPolyLocal(m, starPoints(w, h, 5, 0.45), rc.solid(0xf5, 0xc5, 0x18))
	case "\U0001F3AF": // target
		rc.fillCircleLocal(m, cx, cy, r, rc.solid(0xe0, 0x1e, 0x1e))
		rc.fillCircleLocal(m, cx, cy, r*0.72, rc.solid(0xff, 0xff, 0xff))
		rc.fillCircleLocal(m, cx, cy, r*0.46, rc.solid(0xe0, 0x1e, 0x1e))
		rc.fillCircleLocal(m, cx, cy, r*0.2, rc.solid(0xff, 0xff, 0xff))
	case "✅": // check mark button (green + white check)
		rc.fillCircleLocal(m, cx, cy, r, rc.solid(0x2e, 0xa4, 0x3a))
		white := rc.solid(0xff, 0xff, 0xff)
		rc.stampStroke(m, cx-0.42*r, cy+0.02*r, cx-0.1*r, cy+0.34*r, 0.16*r, white)
		rc.stampStroke(m, cx-0.1*r, cy+0.34*r, cx+0.44*r, cy-0.32*r, 0.16*r, white)
	case "❤️", "❤": // heart
		red := rc.solid(0xe0, 0x1e, 0x3c)
		rc.fillCircleLocal(m, cx-0.44*r, cy-0.28*r, 0.46*r, red)
		rc.fillCircleLocal(m, cx+0.44*r, cy-0.28*r, 0.46*r, red)
		rc.fillPolyLocal(m, [][2]float64{{cx - 0.86*r, cy - 0.06*r}, {cx + 0.86*r, cy - 0.06*r}, {cx, cy + 0.86*r}}, red)
	case "\U0001F525": // fire
		rc.fillPolyLocal(m, [][2]float64{{cx, cy - 0.9*r}, {cx + 0.5*r, cy - 0.1*r}, {cx + 0.55*r, cy + 0.5*r}, {cx, cy + 0.9*r}, {cx - 0.55*r, cy + 0.5*r}, {cx - 0.5*r, cy - 0.1*r}}, rc.solid(0xf5, 0x6b, 0x1e))
		rc.fillPolyLocal(m, [][2]float64{{cx, cy - 0.35*r}, {cx + 0.3*r, cy + 0.15*r}, {cx + 0.3*r, cy + 0.5*r}, {cx, cy + 0.75*r}, {cx - 0.3*r, cy + 0.5*r}, {cx - 0.3*r, cy + 0.15*r}}, rc.solid(0xfb, 0xc2, 0x2b))
	case "\U0001F4A1": // light bulb
		rc.fillCircleLocal(m, cx, cy-0.15*r, 0.72*r, rc.solid(0xff, 0xd5, 0x4a))
		rc.fillPolyLocal(m, [][2]float64{{cx - 0.34*r, cy + 0.5*r}, {cx + 0.34*r, cy + 0.5*r}, {cx + 0.26*r, cy + 0.92*r}, {cx - 0.26*r, cy + 0.92*r}}, rc.solid(0x9a, 0x9a, 0x9a))
	case "\U0001F44D": // thumbs up
		rc.stampThumb(m, cx, cy, r, false)
	case "\U0001F44E": // thumbs down
		rc.stampThumb(m, cx, cy, r, true)
	case "❓", "❔": // question mark
		rc.fillCircleLocal(m, cx, cy, r, rc.solid(0x3b, 0x82, 0xf6))
		if face := rc.face("system", 700, 1.2*r*avgScale(m)); face != nil {
			defer face.Close()
			tw := measureFace(face, "?") / avgScale(m)
			dx, dy := m.apply(cx-tw/2, cy+0.42*r)
			rc.drawStringDevice(face, rc.solid(0xff, 0xff, 0xff), dx, dy, "?")
		}
	default:
		return false
	}
	return true
}

// stampThumb draws a simplified thumbs-up (or down when flip) hand icon.
func (rc *rctx) stampThumb(m mat, cx, cy, r float64, flip bool) {
	hand := rc.solid(0xf7, 0xc8, 0x59)
	fy := func(y float64) float64 {
		if flip {
			return 2*cy - y
		}
		return y
	}
	// fist (fingers block)
	rc.fillPolyLocal(m, [][2]float64{{cx - 0.15*r, fy(cy - 0.1*r)}, {cx + 0.6*r, fy(cy - 0.1*r)}, {cx + 0.6*r, fy(cy + 0.65*r)}, {cx - 0.15*r, fy(cy + 0.65*r)}}, hand)
	// thumb (pointing up)
	rc.fillPolyLocal(m, [][2]float64{{cx - 0.12*r, fy(cy - 0.8*r)}, {cx + 0.2*r, fy(cy - 0.55*r)}, {cx + 0.2*r, fy(cy + 0.05*r)}, {cx - 0.12*r, fy(cy + 0.05*r)}}, hand)
	// cuff
	rc.fillPolyLocal(m, [][2]float64{{cx - 0.45*r, fy(cy + 0.4*r)}, {cx - 0.12*r, fy(cy + 0.4*r)}, {cx - 0.12*r, fy(cy + 0.65*r)}, {cx - 0.45*r, fy(cy + 0.65*r)}}, hand)
}

// --- table ------------------------------------------------------------------

// rasterTable lays out cells from the explicit colWidths/rowHeights arrays,
// paints header/cell fills and single-run cell text, and strokes the gridlines
// (mirrors render2d drawTable). Conditional formatting rules are not yet applied.
func (rc *rctx) rasterTable(m mat, node map[string]any) {
	colW := asArr(node["colWidths"])
	rowH := asArr(node["rowHeights"])
	if len(colW) == 0 || len(rowH) == 0 {
		rc.placeholderBox(m, node)
		return
	}
	xs := make([]float64, len(colW)+1)
	for i := range colW {
		xs[i+1] = xs[i] + asNum(colW[i])
	}
	ys := make([]float64, len(rowH)+1)
	for i := range rowH {
		ys[i+1] = ys[i] + asNum(rowH[i])
	}
	scale := avgScale(m)
	header := asObj(node["headerStyle"])
	headerOn := header != nil && asBool(header["enabled"])

	for _, cv := range asArr(node["cells"]) {
		cell := asObj(cv)
		col := int(asNum(cell["col"]))
		row := int(asNum(cell["row"]))
		if col < 0 || row < 0 || col >= len(colW) || row >= len(rowH) {
			continue
		}
		colSpan := int(asNum(cell["colSpan"]))
		rowSpan := int(asNum(cell["rowSpan"]))
		if colSpan < 1 {
			colSpan = 1
		}
		if rowSpan < 1 {
			rowSpan = 1
		}
		c1 := col + colSpan
		r1 := row + rowSpan
		if c1 > len(colW) {
			c1 = len(colW)
		}
		if r1 > len(rowH) {
			r1 = len(rowH)
		}
		cx, cy := xs[col], ys[row]
		cw, ch := xs[c1]-cx, ys[r1]-cy
		isHeader := headerOn && row == 0

		// Fill precedence: cell.fill, then header.fill for the header row.
		var fill map[string]any
		if f := asObj(cell["fill"]); f != nil {
			fill = f
		} else if isHeader {
			fill = asObj(header["fill"])
		}
		if fill != nil {
			rc.fillPolyPaint(transformPts(m, [][2]float64{{cx, cy}, {cx + cw, cy}, {cx + cw, cy + ch}, {cx, cy + ch}}), fill, scale)
		}

		// Single-run cell text.
		run := asObj(firstOf(asArr(cell["content"])))
		text := asStr(run["text"])
		if text == "" {
			continue
		}
		// TextRun fields are flat on the run (schema TextRun: fontSize/weight/
		// color), and the browser always renders cell text in the system face.
		size := asNum(run["fontSize"])
		if size == 0 {
			size = 14
		}
		weight := int(asNum(run["weight"]))
		if weight == 0 {
			weight = 400
		}
		if isHeader && (!hasKey(header, "bold") || asBool(header["bold"])) && weight < 700 {
			weight = 700
		}
		face := rc.face("system", weight, size*scale)
		if face == nil {
			continue
		}
		// Color precedence (matches drawTable): header textColor (header cells) ->
		// cell textColor -> run color -> default ink.
		txtCol := rasterColor(pdfColor{r: 0.094, g: 0.094, b: 0.106, ok: true}, rc.alpha)
		if tc := asObj(cell["textColor"]); tc != nil {
			txtCol = rc.colorFrom(tc, pdfColor{ok: true})
		} else if rc2 := asObj(run["color"]); rc2 != nil {
			txtCol = rc.colorFrom(rc2, pdfColor{ok: true})
		}
		if isHeader {
			if tc := asObj(header["textColor"]); tc != nil {
				txtCol = rc.colorFrom(tc, pdfColor{ok: true})
			}
		}
		tw := measureFace(face, text) / scale
		tx := cx + 6
		switch asStr(cell["align"]) {
		case "center":
			tx = cx + (cw-tw)/2
		case "right":
			tx = cx + cw - tw - 6
		}
		ty := cy + size + 6
		dx, dy := m.apply(tx, ty)
		rc.drawStringDevice(face, txtCol, dx, dy, text)
		face.Close()
	}

	// Gridlines.
	bs := asObj(node["borderStyle"])
	if bs != nil && !asBool(bs["show"]) && hasKey(bs, "show") {
		return
	}
	borderCol := rasterColor(pdfColor{r: 0.831, g: 0.831, b: 0.847, ok: true}, rc.alpha)
	if bs != nil {
		if c := asObj(bs["color"]); c != nil {
			borderCol = rc.colorFrom(c, pdfColor{r: 0.831, g: 0.831, b: 0.847, ok: true})
		}
	} else if b := asObj(node["borders"]); b != nil {
		if pc := pdfPaint(asObj(b["fill"])); pc.ok {
			borderCol = rasterColor(pc, rc.alpha)
		}
	}
	bw := 1.0
	if bs != nil && asNum(bs["width"]) > 0 {
		bw = asNum(bs["width"])
	}
	hw := bw * scale / 2
	x0, x1 := xs[0], xs[len(xs)-1]
	y0, y1 := ys[0], ys[len(ys)-1]
	for _, x := range xs {
		a0x, a0y := m.apply(x, y0)
		a1x, a1y := m.apply(x, y1)
		rc.strokeSegDevice(a0x, a0y, a1x, a1y, hw, borderCol)
	}
	for _, y := range ys {
		a0x, a0y := m.apply(x0, y)
		a1x, a1y := m.apply(x1, y)
		rc.strokeSegDevice(a0x, a0y, a1x, a1y, hw, borderCol)
	}
}

// --- chart ------------------------------------------------------------------

// chartPalette mirrors SERIES_PALETTE_HEX (packages/color/src/series.ts).
var chartPalette = []pdfColor{
	hexColor(0x63, 0x66, 0xf1), // indigo
	hexColor(0x10, 0xb9, 0x81), // emerald
	hexColor(0xf5, 0x9e, 0x0b), // amber
	hexColor(0xef, 0x44, 0x44), // red
	hexColor(0x3b, 0x82, 0xf6), // blue
	hexColor(0xec, 0x48, 0x99), // pink
	hexColor(0x14, 0xb8, 0xa6), // teal
	hexColor(0x8b, 0x5c, 0xf6), // violet
}

func hexColor(r, g, b uint8) pdfColor {
	return pdfColor{r: float64(r) / 255, g: float64(g) / 255, b: float64(b) / 255, ok: true}
}

func (rc *rctx) solid(r, g, b uint8) color.RGBA { return rasterColor(hexColor(r, g, b), rc.alpha) }

// chartSeriesColor: an explicit series color, else the palette by index.
func chartSeriesColor(rc *rctx, s map[string]any, i int) color.RGBA {
	if c := asObj(s["color"]); c != nil {
		return rc.colorFrom(c, chartPalette[i%len(chartPalette)])
	}
	return rasterColor(chartPalette[i%len(chartPalette)], rc.alpha)
}

func chartTextScale(node map[string]any) float64 {
	base := asNum(asObj(node["style"])["fontSize"])
	if base <= 0 {
		return 1
	}
	return math.Min(4, math.Max(0.5, base/11))
}

func hasValueAxis(t string) bool {
	switch t {
	case "bar", "barStacked", "barGrouped", "line", "area", "scatter":
		return true
	}
	return false
}

// chartAxisShown reports axes[key] (default true unless explicitly false).
func chartAxisShown(style map[string]any, key string) bool {
	if ax := asObj(style["axes"]); ax != nil {
		if v, ok := ax[key].(bool); ok {
			return v
		}
	}
	return true
}

// chartInsets reserves space for title/legend/axis chrome (mirrors chartInsets).
func chartInsets(node map[string]any, w, h float64) (x0, y0, pw, ph float64) {
	style := asObj(node["style"])
	k := chartTextScale(node)
	top, bottom, left, right := 14.0, 14.0, 14.0, 14.0
	if style != nil {
		if asStr(style["title"]) != "" {
			top += 18 * k
		}
		if lg := asObj(style["legend"]); lg != nil && asBool(lg["show"]) {
			switch asStr(lg["position"]) {
			case "top":
				top += 18 * k
			case "bottom":
				bottom += 18 * k
			case "left":
				left += 80 * k
			default:
				right += 80 * k
			}
		}
		if ax := asObj(style["axes"]); ax != nil {
			if asStr(ax["yLabel"]) != "" {
				left += 14 * k
			}
			if asStr(ax["xLabel"]) != "" {
				bottom += 14 * k
			}
		}
	}
	if hasValueAxis(asStr(node["chartType"])) && chartAxisShown(style, "showY") {
		left += 22 * k
	}
	return left, top, math.Max(1, w-left-right), math.Max(1, h-top-bottom)
}

func chartCategoryCount(categories, series []any) int {
	n := len(categories)
	for _, sv := range series {
		if l := len(asArr(asObj(sv)["values"])); l > n {
			n = l
		}
	}
	return n
}

func chartSeriesMax(series []any) float64 {
	max := 0.0
	for _, sv := range series {
		for _, v := range asArr(asObj(sv)["values"]) {
			if x := asNum(v); x > max {
				max = x
			}
		}
	}
	return max
}

func chartStackedMax(series []any, n int) float64 {
	max := 0.0
	for i := 0; i < n; i++ {
		sum := 0.0
		for _, sv := range series {
			vals := asArr(asObj(sv)["values"])
			if i < len(vals) {
				sum += math.Max(0, asNum(vals[i]))
			}
		}
		if sum > max {
			max = sum
		}
	}
	return max
}

func chartStackedBase(series []any, catIndex, seriesIndex int) float64 {
	base := 0.0
	for j := 0; j < seriesIndex; j++ {
		vals := asArr(asObj(series[j])["values"])
		if catIndex < len(vals) {
			base += math.Max(0, asNum(vals[catIndex]))
		}
	}
	return base
}

func chartGroupedBar(plotWidth float64, catCount, seriesCount, catIndex, seriesIndex int) (x, width float64) {
	slot := plotWidth
	if catCount > 0 {
		slot = plotWidth / float64(catCount)
	}
	groupW := slot * 0.8
	pad := (slot - groupW) / 2
	barW := groupW
	if seriesCount > 0 {
		barW = groupW / float64(seriesCount)
	}
	return float64(catIndex)*slot + pad + float64(seriesIndex)*barW, barW
}

func radarPointL(cx, cy, radius float64, axisIndex, axisCount int, value, maxValue float64) (float64, float64) {
	angle := -math.Pi/2 + float64(axisIndex)/math.Max(1, float64(axisCount))*math.Pi*2
	den := maxValue
	if den == 0 {
		den = 1
	}
	r := math.Max(0, value) / den * radius
	return cx + math.Cos(angle)*r, cy + math.Sin(angle)*r
}

func numStr(v float64) string { return strconv.FormatFloat(v, 'g', -1, 64) }

// chartText draws a label at LOCAL (lx, ly baseline) with alignment.
func (rc *rctx) chartText(m mat, s string, lx, ly, sizePx float64, weight int, align string, col color.RGBA) {
	if s == "" {
		return
	}
	scale := avgScale(m)
	face := rc.face("system", weight, sizePx*scale)
	if face == nil {
		return
	}
	defer face.Close()
	if align == "center" || align == "right" {
		tw := measureFace(face, s) / scale
		if align == "center" {
			lx -= tw / 2
		} else {
			lx -= tw
		}
	}
	dx, dy := m.apply(lx, ly)
	rc.drawStringDevice(face, col, dx, dy, s)
}

func (rc *rctx) chartTextWidth(sizePx float64, weight int, s string, m mat) float64 {
	scale := avgScale(m)
	face := rc.face("system", weight, sizePx*scale)
	if face == nil {
		return float64(len(s)) * 6
	}
	defer face.Close()
	return measureFace(face, s) / scale
}

// chartStroke strokes a local-space line of the given px width.
func (rc *rctx) chartStroke(m mat, x0, y0, x1, y1, widthPx float64, col color.RGBA) {
	a0x, a0y := m.apply(x0, y0)
	a1x, a1y := m.apply(x1, y1)
	rc.strokeSegDevice(a0x, a0y, a1x, a1y, widthPx*avgScale(m)/2, col)
}

// fillPolyRect fills a local-space rectangle (x,y,w,h) with a flat color.
func (rc *rctx) fillPolyRect(m mat, x, y, w, h float64, col color.RGBA) {
	if w <= 0 || h == 0 || col.A == 0 {
		return
	}
	rc.fillPath(transformPts(m, [][2]float64{{x, y}, {x + w, y}, {x + w, y + h}, {x, y + h}}), col)
}

// fillArcSegment fills an annular wedge (pie when rInner==0) in device space.
func (rc *rctx) fillArcSegment(cx, cy, rInner, rOuter, a0, a1 float64, src image.Image) {
	if rOuter <= 0 || a1 <= a0 {
		return
	}
	steps := int(math.Max(2, (a1-a0)/(math.Pi/90)))
	r := vector.NewRasterizer(rc.w, rc.h)
	for i := 0; i <= steps; i++ {
		t := a0 + (a1-a0)*float64(i)/float64(steps)
		x, y := cx+math.Cos(t)*rOuter, cy+math.Sin(t)*rOuter
		if i == 0 {
			r.MoveTo(float32(x), float32(y))
		} else {
			r.LineTo(float32(x), float32(y))
		}
	}
	if rInner > 0 {
		for i := steps; i >= 0; i-- {
			t := a0 + (a1-a0)*float64(i)/float64(steps)
			r.LineTo(float32(cx+math.Cos(t)*rInner), float32(cy+math.Sin(t)*rInner))
		}
	} else {
		r.LineTo(float32(cx), float32(cy))
	}
	r.ClosePath()
	r.Draw(rc.dst, rc.dst.Bounds(), src, image.Point{})
}

// rasterChart renders every chart kind from the raw series data, matching the
// browser (render2d drawChart): title/legend/axis chrome, Y-axis ticks, bar/
// grouped/stacked, line/area, pie/donut, scatter, radar. gauge/funnel/progress
// fall through to the line path, exactly as the browser does.
func (rc *rctx) rasterChart(m mat, node map[string]any) {
	series := asArr(node["series"])
	w, h := sizeOf(node)
	if len(series) == 0 || w <= 0 || h <= 0 {
		rc.placeholderBox(m, node)
		return
	}
	typ := asStr(node["chartType"])
	style := asObj(node["style"])
	showValues := asBool(asObj(node["style"])["valueLabels"])
	k := chartTextScale(node)
	lbl := rc.solid(0x52, 0x52, 0x5b)
	rc.drawChartChrome(m, node, w, h)

	if typ == "pie" || typ == "donut" {
		x0, y0, pw, ph := chartInsets(node, w, h)
		vals := asArr(asObj(firstOf(series))["values"])
		total := 0.0
		for _, v := range vals {
			total += math.Max(0, asNum(v))
		}
		if total <= 0 {
			total = 1
		}
		scale := avgScale(m)
		cxL, cyL := x0+pw/2, y0+ph/2
		rL := math.Max(2, math.Min(pw, ph)/2)
		cxD, cyD := m.apply(cxL, cyL)
		a0 := -math.Pi / 2
		for i, v := range vals {
			a1 := a0 + math.Max(0, asNum(v))/total*2*math.Pi
			col := rasterColor(chartPalette[i%len(chartPalette)], rc.alpha)
			if typ == "donut" {
				rc.fillArcSegment(cxD, cyD, rL*0.57*scale, rL*0.99*scale, a0, a1, image.NewUniform(col))
			} else {
				rc.fillArcSegment(cxD, cyD, 0, rL*scale, a0, a1, image.NewUniform(col))
			}
			if showValues {
				mid := (a0 + a1) / 2
				rc.chartText(m, numStr(asNum(v)), cxL+math.Cos(mid)*rL*0.6, cyL+math.Sin(mid)*rL*0.6, 10*k, 500, "center", lbl)
			}
			a0 = a1
		}
		return
	}

	x0, y0, pw, ph := chartInsets(node, w, h)
	n := chartCategoryCount(asArr(node["categories"]), series)
	if n == 0 {
		rc.placeholderBox(m, node)
		return
	}

	if typ == "radar" {
		rc.drawRadar(m, node, x0+pw/2, y0+ph/2, math.Max(2, math.Min(pw, ph)/2), n)
		return
	}
	if typ == "scatter" {
		rc.drawScatter(m, node, x0, y0, pw, ph, n, showValues)
		return
	}

	stacked := typ == "barStacked"
	maxV := math.Max(1, chartSeriesMax(series))
	if stacked {
		maxV = math.Max(1, chartStackedMax(series, n))
	}
	if chartAxisShown(style, "showX") {
		rc.chartStroke(m, x0, y0+ph, x0+pw, y0+ph, 1, rc.solid(0xd4, 0xd4, 0xd8))
	}
	if chartAxisShown(style, "showY") {
		rc.drawYAxis(m, x0, y0, ph, maxV, k)
	}

	if typ == "bar" || typ == "barGrouped" || typ == "barStacked" {
		for i := 0; i < n; i++ {
			if stacked {
				slot := pw / float64(n)
				barW := slot * 0.6
				bx := x0 + float64(i)*slot + (slot-barW)/2
				for j := 0; j < len(series); j++ {
					sj := asObj(series[j])
					vals := asArr(sj["values"])
					v := 0.0
					if i < len(vals) {
						v = math.Max(0, asNum(vals[i]))
					}
					bh := v / maxV * ph
					by := y0 + ph - (chartStackedBase(series, i, j)+v)/maxV*ph
					rc.fillPolyRect(m, bx, by, barW, bh, chartSeriesColor(rc, sj, j))
					if showValues && v > 0 {
						rc.chartText(m, numStr(asNum(vals[i])), bx+barW/2, by+10*k, 10*k, 500, "center", lbl)
					}
				}
			} else {
				for j := 0; j < len(series); j++ {
					sj := asObj(series[j])
					vals := asArr(sj["values"])
					v := 0.0
					if i < len(vals) {
						v = asNum(vals[i])
					}
					bh := math.Max(0, v) / maxV * ph
					gx, gw := chartGroupedBar(pw, n, len(series), i, j)
					rc.fillPolyRect(m, x0+gx, y0+ph-bh, gw*0.9, bh, chartSeriesColor(rc, sj, j))
					if showValues {
						rc.chartText(m, numStr(v), x0+gx+gw*0.45, y0+ph-bh-3*k, 10*k, 500, "center", lbl)
					}
				}
			}
		}
		return
	}

	// line / area (gauge/funnel/progress fall through here too, as in the browser)
	step := 0.0
	if n > 1 {
		step = pw / float64(n-1)
	}
	for j := 0; j < len(series); j++ {
		sj := asObj(series[j])
		vals := asArr(sj["values"])
		col := chartSeriesColor(rc, sj, j)
		pts := make([][2]float64, 0, n)
		for i := 0; i < n; i++ {
			v := 0.0
			if i < len(vals) {
				v = asNum(vals[i])
			}
			dx, dy := m.apply(x0+float64(i)*step, y0+ph-math.Max(0, v)/maxV*ph)
			pts = append(pts, [2]float64{dx, dy})
		}
		if typ == "area" && len(pts) >= 2 {
			poly := append([][2]float64{}, pts...)
			ex, ey := m.apply(x0+float64(n-1)*step, y0+ph)
			sx, sy := m.apply(x0, y0+ph)
			poly = append(poly, [2]float64{ex, ey}, [2]float64{sx, sy})
			// col is alpha-premultiplied; scale ALL channels by 0.35 for a light
			// tint (scaling only A would leave RGB>A, an invalid premultiplied
			// color that renders oversaturated).
			ac := color.RGBA{
				R: uint8(float64(col.R) * 0.35),
				G: uint8(float64(col.G) * 0.35),
				B: uint8(float64(col.B) * 0.35),
				A: uint8(float64(col.A) * 0.35),
			}
			rc.fillPath(poly, ac)
		} else {
			hw := avgScale(m) // 2px stroke -> half-width 1*scale
			for i := 0; i+1 < len(pts); i++ {
				rc.strokeSegDevice(pts[i][0], pts[i][1], pts[i+1][0], pts[i+1][1], hw, col)
			}
		}
		if showValues {
			for i := 0; i < n; i++ {
				v := 0.0
				if i < len(vals) {
					v = asNum(vals[i])
				}
				rc.chartText(m, numStr(v), x0+float64(i)*step, y0+ph-math.Max(0, v)/maxV*ph-4*k, 10*k, 500, "center", lbl)
			}
		}
	}
}

func (rc *rctx) drawChartChrome(m mat, node map[string]any, w, h float64) {
	style := asObj(node["style"])
	if style == nil {
		return
	}
	k := chartTextScale(node)
	if t := asStr(style["title"]); t != "" {
		rc.chartText(m, t, w/2, 14*k, 13*k, 600, "center", rc.solid(0x18, 0x18, 0x1b))
	}
	if ax := asObj(style["axes"]); ax != nil {
		if xl := asStr(ax["xLabel"]); xl != "" {
			rc.chartText(m, xl, w/2, h-4, 11*k, 500, "center", rc.solid(0x52, 0x52, 0x5b))
		}
		if yl := asStr(ax["yLabel"]); yl != "" {
			rc.chartText(m, yl, 8, h/2, 11*k, 500, "center", rc.solid(0x52, 0x52, 0x5b))
		}
	}
	if lg := asObj(style["legend"]); lg != nil && asBool(lg["show"]) {
		rc.drawChartLegend(m, node, w, h, asStr(lg["position"]))
	}
}

func (rc *rctx) drawChartLegend(m mat, node map[string]any, w, h float64, position string) {
	series := asArr(node["series"])
	if len(series) == 0 {
		return
	}
	k := chartTextScale(node)
	sw, gap, rowH, itemGap := 10*k, 6*k, 16*k, 16*k
	labelCol := rc.solid(0x3f, 0x3f, 0x46)
	if position == "top" || position == "bottom" {
		y := 4 * k
		if position == "bottom" {
			y = h - rowH + 4*k
		}
		maxX := w - 8
		x := 8.0
		for j := 0; j < len(series); j++ {
			if x+sw+gap >= maxX {
				break
			}
			rc.fillPolyRect(m, x, y, sw, sw, chartSeriesColor(rc, asObj(series[j]), j))
			name := asStr(asObj(series[j])["name"])
			rc.chartText(m, name, x+sw+gap, y+sw, 11*k, 500, "left", labelCol)
			x = x + sw + gap + rc.chartTextWidth(11*k, 500, name, m) + itemGap
		}
	} else {
		band := 80 * k
		x := 6.0
		if position != "left" {
			x = w - band + 6
		}
		y := 10 * k
		for j := 0; j < len(series); j++ {
			if y+sw > h {
				break
			}
			rc.fillPolyRect(m, x, y, sw, sw, chartSeriesColor(rc, asObj(series[j]), j))
			rc.chartText(m, asStr(asObj(series[j])["name"]), x+sw+gap, y+sw, 11*k, 500, "left", labelCol)
			y += rowH
		}
	}
}

func (rc *rctx) drawYAxis(m mat, x0, y0, ph, maxV, k float64) {
	ticks := int(math.Max(2, math.Min(8, math.Round(ph/48))))
	axisCol := rc.solid(0xd4, 0xd4, 0xd8)
	rc.chartStroke(m, x0, y0, x0, y0+ph, 1, axisCol)
	for t := 0; t <= ticks; t++ {
		frac := float64(t) / float64(ticks)
		ty := y0 + ph - frac*ph
		rc.chartStroke(m, x0-3, ty, x0, ty, 1, axisCol)
		rc.chartText(m, numStr(math.Round(maxV*frac*100)/100), x0-5, ty+3*k, 9*k, 500, "right", rc.solid(0x52, 0x52, 0x5b))
	}
}

func (rc *rctx) drawScatter(m mat, node map[string]any, x0, y0, pw, ph float64, n int, showValues bool) {
	series := asArr(node["series"])
	maxV := math.Max(1, chartSeriesMax(series))
	k := chartTextScale(node)
	style := asObj(node["style"])
	if chartAxisShown(style, "showX") {
		rc.chartStroke(m, x0, y0+ph, x0+pw, y0+ph, 1, rc.solid(0xd4, 0xd4, 0xd8))
	}
	if chartAxisShown(style, "showY") {
		rc.drawYAxis(m, x0, y0, ph, maxV, k)
	}
	step := 0.0
	if n > 1 {
		step = pw / float64(n-1)
	}
	scale := avgScale(m)
	for j := 0; j < len(series); j++ {
		sj := asObj(series[j])
		vals := asArr(sj["values"])
		col := chartSeriesColor(rc, sj, j)
		for i := 0; i < len(vals); i++ {
			v := asNum(vals[i])
			px := x0 + float64(i)*step
			py := y0 + ph - math.Max(0, v)/maxV*ph
			dx, dy := m.apply(px, py)
			rc.fillArcSegment(dx, dy, 0, 4*scale, 0, 2*math.Pi, image.NewUniform(col))
			if showValues {
				rc.chartText(m, numStr(v), px, py-6*k, 10*k, 500, "center", rc.solid(0x52, 0x52, 0x5b))
			}
		}
	}
}

func (rc *rctx) drawRadar(m mat, node map[string]any, cxL, cyL, radiusL float64, n int) {
	series := asArr(node["series"])
	maxV := math.Max(1, chartSeriesMax(series))
	web := rc.solid(0xe4, 0xe4, 0xe7)
	for i := 0; i < n; i++ {
		px, py := radarPointL(cxL, cyL, radiusL, i, n, maxV, maxV)
		rc.chartStroke(m, cxL, cyL, px, py, 1, web)
	}
	hw := avgScale(m)
	for j := 0; j < len(series); j++ {
		sj := asObj(series[j])
		vals := asArr(sj["values"])
		col := chartSeriesColor(rc, sj, j)
		pts := make([][2]float64, 0, n)
		for i := 0; i < n; i++ {
			v := 0.0
			if i < len(vals) {
				v = asNum(vals[i])
			}
			px, py := radarPointL(cxL, cyL, radiusL, i, n, v, maxV)
			dx, dy := m.apply(px, py)
			pts = append(pts, [2]float64{dx, dy})
		}
		for i := 0; i < len(pts); i++ {
			p0, p1 := pts[i], pts[(i+1)%len(pts)]
			rc.strokeSegDevice(p0[0], p0[1], p1[0], p1[1], hw, col)
		}
	}
}

// firstOf returns the first element of a slice or nil.
func firstOf(a []any) any {
	if len(a) == 0 {
		return nil
	}
	return a[0]
}

// hasKey reports whether obj carries key.
func hasKey(obj map[string]any, key string) bool {
	if obj == nil {
		return false
	}
	_, ok := obj[key]
	return ok
}

// --- image / pattern fills --------------------------------------------------

// decodeDataURLImage decodes a "data:...;base64,..." image; nil when empty or
// undecodable.
func decodeDataURLImage(src string) image.Image {
	if src == "" {
		return nil
	}
	raw, ok := dataURLBytes(src)
	if !ok {
		return nil
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil
	}
	return img
}

// decodeFillImage decodes a fill's embedded image bytes (the export handler
// inlines them as a data URL on fill["src"]); nil when absent/undecodable.
func decodeFillImage(fill map[string]any) image.Image {
	return decodeDataURLImage(asStr(fill["src"]))
}

// imageFitRect returns the source sub-rect (normalized 0..1 of the cropped
// content) and the destination rect (px within a w x h box) for a fit mode,
// matching packages/engine/src/image.ts fitRect. cw/ch are the cropped content
// dims in source px; fx/fy are the focal point (cover only).
func imageFitRect(cw, ch, w, h float64, fit string, fx, fy, scale float64) (sx, sy, sw, sh, dx, dy, dw, dh float64) {
	switch fit {
	case "stretch":
		return 0, 0, 1, 1, 0, 0, w, h
	case "none":
		// Natural size is in local px; scale it to the box's device space.
		nw, nh := cw*scale, ch*scale
		return 0, 0, 1, 1, (w - nw) / 2, (h - nh) / 2, nw, nh
	case "contain":
		if cw <= 0 || ch <= 0 {
			return 0, 0, 1, 1, 0, 0, w, h
		}
		s := math.Min(w/cw, h/ch)
		fw, fh := cw*s, ch*s
		return 0, 0, 1, 1, (w - fw) / 2, (h - fh) / 2, fw, fh
	default: // cover
		if cw <= 0 || ch <= 0 {
			return 0, 0, 1, 1, 0, 0, w, h
		}
		s := math.Max(w/cw, h/ch)
		visW := math.Min(1, w/(cw*s))
		visH := math.Min(1, h/(ch*s))
		return fx * (1 - visW), fy * (1 - visH), visW, visH, 0, 0, w, h
	}
}

// fillPolyImage paints an image fill clipped to the polygon.
func (rc *rctx) fillPolyImage(pts [][2]float64, fill map[string]any, scale float64) {
	if src := rc.imageFillSrc(bboxOf(pts), fill, scale); src != nil {
		rc.fillPathSrc(pts, rc.paint(src))
	}
}

// imageFillSrc renders an image fill (schema ImageFill) into a full-canvas
// image placed within box bb, honoring fit (cover/contain/stretch/none),
// normalized crop, and the focal point, matching render2d drawShape's image
// branch. Returns nil when there's nothing to draw. The caller clips it to the
// shape (polygon or bezier path).
func (rc *rctx) imageFillSrc(bb [4]float64, fill map[string]any, scale float64) image.Image {
	img := decodeFillImage(fill)
	if img == nil {
		return nil
	}
	boxW, boxH := bb[2]-bb[0], bb[3]-bb[1]
	ib := img.Bounds()
	iw, ih := float64(ib.Dx()), float64(ib.Dy())
	if boxW <= 0 || boxH <= 0 || iw <= 0 || ih <= 0 {
		return nil
	}
	cropX, cropY, cropW, cropH := 0.0, 0.0, 1.0, 1.0
	if crop := asObj(fill["crop"]); crop != nil {
		cropX, cropY = asNum(crop["x"]), asNum(crop["y"])
		if cw := asNum(crop["width"]); cw > 0 {
			cropW = cw
		}
		if ch := asNum(crop["height"]); ch > 0 {
			cropH = ch
		}
	}
	fx, fy := 0.5, 0.5
	if fp := asObj(fill["focalPoint"]); fp != nil {
		fx, fy = asNum(fp["x"]), asNum(fp["y"])
	}
	sx, sy, sw, sh, dx, dy, dw, dh := imageFitRect(iw*cropW, ih*cropH, boxW, boxH, asStr(fill["fit"]), fx, fy, scale)
	srcX := (cropX + sx*cropW) * iw
	srcY := (cropY + sy*cropH) * ih
	srcRect := image.Rect(
		ib.Min.X+int(math.Round(srcX)), ib.Min.Y+int(math.Round(srcY)),
		ib.Min.X+int(math.Round(srcX+sw*cropW*iw)), ib.Min.Y+int(math.Round(srcY+sh*cropH*ih)),
	).Intersect(ib)
	destRect := image.Rect(
		int(math.Round(bb[0]+dx)), int(math.Round(bb[1]+dy)),
		int(math.Round(bb[0]+dx+dw)), int(math.Round(bb[1]+dy+dh)),
	)
	if srcRect.Dx() <= 0 || srcRect.Dy() <= 0 || destRect.Dx() <= 0 || destRect.Dy() <= 0 {
		return nil
	}
	canvas := image.NewRGBA(image.Rect(0, 0, rc.w, rc.h))
	xdraw.CatmullRom.Scale(canvas, destRect, img, srcRect, xdraw.Over, nil)
	return canvas
}

// patternSrc samples a tiled image in device space (scale + rotation about the
// shape's box origin), clipped to the shape by fillPathSrc.
type patternSrc struct {
	bounds           image.Rectangle
	img              image.Image
	ib               image.Rectangle
	originX, originY float64
	invScale         float64
	cos, sin         float64 // of -rotation (inverse)
	noRepeat         bool
}

func (p *patternSrc) ColorModel() color.Model { return color.NRGBAModel }
func (p *patternSrc) Bounds() image.Rectangle { return p.bounds }
func (p *patternSrc) At(x, y int) color.Color {
	dx := float64(x) - p.originX
	dy := float64(y) - p.originY
	ux := (dx*p.cos - dy*p.sin) * p.invScale
	uy := (dx*p.sin + dy*p.cos) * p.invScale
	iw, ih := p.ib.Dx(), p.ib.Dy()
	if iw <= 0 || ih <= 0 {
		return color.NRGBA{}
	}
	sx := int(math.Floor(ux))
	sy := int(math.Floor(uy))
	if p.noRepeat {
		if sx < 0 || sy < 0 || sx >= iw || sy >= ih {
			return color.NRGBA{}
		}
	} else {
		sx = ((sx % iw) + iw) % iw
		sy = ((sy % ih) + ih) % ih
	}
	return p.img.At(p.ib.Min.X+sx, p.ib.Min.Y+sy)
}

// fillPolyPattern paints a pattern fill clipped to the polygon.
func (rc *rctx) fillPolyPattern(pts [][2]float64, fill map[string]any, devScale float64) {
	if src := rc.patternFillSrc(bboxOf(pts), fill, devScale); src != nil {
		rc.fillPathSrc(pts, rc.paint(src))
	}
}

// patternFillSrc builds a device-space tiled pattern source for box bb (pattern
// scale + rotation about the box origin; mirror repeat falls back to tiling, as
// in render2d paintPattern). devScale is the node's transform scale, so tiles
// grow with the shape. Returns nil when the asset can't be decoded. The caller
// clips it to the shape.
func (rc *rctx) patternFillSrc(bb [4]float64, fill map[string]any, devScale float64) image.Image {
	img := decodeFillImage(fill)
	if img == nil {
		return nil
	}
	scale := asNum(fill["scale"])
	if scale <= 0 {
		scale = 1
	}
	if devScale <= 0 {
		devScale = 1
	}
	rot := asNum(fill["rotation"]) * math.Pi / 180
	return &patternSrc{
		bounds:   rc.dst.Bounds(),
		img:      img,
		ib:       img.Bounds(),
		originX:  bb[0],
		originY:  bb[1],
		invScale: 1 / (scale * devScale),
		cos:      math.Cos(-rot),
		sin:      math.Sin(-rot),
		noRepeat: asStr(fill["repeat"]) == "no-repeat",
	}
}
