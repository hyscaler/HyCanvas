// PDF export: a minimal, dependency-free PDF writer that translates a page's
// scene graph to PDF vector operators. PDF user space is bottom-left/y-up, so
// the content stream first flips to the design's top-left/y-down space; each
// node's transform is applied inside a q/Q (save/restore) pair, mirroring the
// SVG <g> nesting. Text uses the Helvetica base-14 font (no embedding).
//
// Fidelity notes (v1, documented degradations vs the editable SVG): gradient
// fills render as their first stop color, and per-element opacity/alpha is not
// applied (PDF constant alpha needs an ExtGState; deferred). Vector geometry,
// colors, transforms, and text position are faithful.
package render

import (
	"bytes"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// pdfColor is an r,g,b in 0..1, or ok=false for "none".
type pdfColor struct {
	r, g, b float64
	ok      bool
}

func pdfPaint(fill map[string]any) pdfColor {
	if fill == nil {
		return pdfColor{}
	}
	switch asStr(fill["type"]) {
	case "solid":
		return colorComponents(asObj(fill["color"]))
	case "gradient":
		// Degrade to the first stop color.
		stops := asArr(fill["stops"])
		if len(stops) > 0 {
			return colorComponents(asObj(asObj(stops[0])["color"]))
		}
	}
	return pdfColor{}
}

func colorComponents(color map[string]any) pdfColor {
	srgb := asObj(color["srgb"])
	if srgb == nil {
		return pdfColor{}
	}
	return pdfColor{r: asNum(srgb["r"]), g: asNum(srgb["g"]), b: asNum(srgb["b"]), ok: true}
}

func pn(n float64) string {
	if math.IsNaN(n) || math.IsInf(n, 0) {
		return "0"
	}
	return strconv.FormatFloat(math.Round(n*1000)/1000, 'f', -1, 64)
}

// pdfCtx accumulates the page content stream.
type pdfCtx struct {
	buf   bytes.Buffer
	boxes map[string]rbox // page node world-boxes, for connector endpoint routing
	// Accessibility tagging (doc 28 FR-22). Tags are collected as content is
	// drawn, so `tags` is in z-order; the structure tree reorders them.
	tags []pdfTag
}

func (c *pdfCtx) op(s string) { c.buf.WriteString(s); c.buf.WriteByte('\n') }

// beginTag opens a marked-content sequence for a node that belongs in the
// structure tree, returning the tag it created. beginArtifact opens one for
// presentational content, which stays out of the tree entirely.
func (c *pdfCtx) beginTag(role, alt string) pdfTag {
	t := pdfTag{mcid: len(c.tags), role: role, alt: alt}
	c.tags = append(c.tags, t)
	c.op("/" + role + " <</MCID " + strconv.Itoa(t.mcid) + ">> BDC")
	return t
}

func (c *pdfCtx) beginArtifact() { c.op("/Artifact BMC") }

func (c *pdfCtx) endMarked() { c.op("EMC") }

// paintAndStroke emits the fill+stroke for the current path using the node's
// fills[0] and stroke, choosing the right paint operator (f/S/B/n).
func (c *pdfCtx) paintAndStroke(node map[string]any) {
	var fills []any = asArr(node["fills"])
	var fill map[string]any
	if len(fills) > 0 {
		fill = asObj(fills[0])
	}
	fc := pdfPaint(fill)
	stroke := asObj(node["stroke"])
	var sc pdfColor
	if stroke != nil {
		sc = pdfPaint(asObj(stroke["fill"]))
	}
	if fc.ok {
		c.op(pn(fc.r) + " " + pn(fc.g) + " " + pn(fc.b) + " rg")
	}
	if sc.ok {
		c.op(pn(sc.r) + " " + pn(sc.g) + " " + pn(sc.b) + " RG")
		c.op(pn(asNum(stroke["width"])) + " w")
	}
	switch {
	case fc.ok && sc.ok:
		c.op("B")
	case fc.ok:
		c.op("f")
	case sc.ok:
		c.op("S")
	default:
		c.op("n")
	}
}

// emitEllipse approximates an ellipse with four cubic bezier arcs.
func (c *pdfCtx) emitEllipse(w, h float64) {
	rx, ry := w/2, h/2
	cx, cy := w/2, h/2
	const k = 0.5522847498
	ox, oy := rx*k, ry*k
	c.op(pn(cx-rx) + " " + pn(cy) + " m")
	c.op(pn(cx-rx) + " " + pn(cy+oy) + " " + pn(cx-ox) + " " + pn(cy+ry) + " " + pn(cx) + " " + pn(cy+ry) + " c")
	c.op(pn(cx+ox) + " " + pn(cy+ry) + " " + pn(cx+rx) + " " + pn(cy+oy) + " " + pn(cx+rx) + " " + pn(cy) + " c")
	c.op(pn(cx+rx) + " " + pn(cy-oy) + " " + pn(cx+ox) + " " + pn(cy-ry) + " " + pn(cx) + " " + pn(cy-ry) + " c")
	c.op(pn(cx-ox) + " " + pn(cy-ry) + " " + pn(cx-rx) + " " + pn(cy-oy) + " " + pn(cx-rx) + " " + pn(cy) + " c")
	c.op("h")
}

func (c *pdfCtx) emitPolyPoints(pts [][2]float64) {
	for i, p := range pts {
		if i == 0 {
			c.op(pn(p[0]) + " " + pn(p[1]) + " m")
		} else {
			c.op(pn(p[0]) + " " + pn(p[1]) + " l")
		}
	}
	c.op("h")
}

func polygonPoints(w, h float64, sides int) [][2]float64 {
	if sides < 3 {
		sides = 3
	}
	cx, cy := w/2, h/2
	out := make([][2]float64, sides)
	for i := 0; i < sides; i++ {
		a := -math.Pi/2 + float64(i)*2*math.Pi/float64(sides)
		out[i] = [2]float64{cx + math.Cos(a)*(w/2), cy + math.Sin(a)*(h/2)}
	}
	return out
}

func starPoints(w, h float64, points int, innerRatio float64) [][2]float64 {
	if points < 3 {
		points = 3
	}
	inner := math.Max(0.05, math.Min(1, innerRatio))
	cx, cy := w/2, h/2
	out := make([][2]float64, points*2)
	for i := 0; i < points*2; i++ {
		a := -math.Pi/2 + float64(i)*math.Pi/float64(points)
		r := 1.0
		if i%2 != 0 {
			r = inner
		}
		out[i] = [2]float64{cx + math.Cos(a)*(w/2)*r, cy + math.Sin(a)*(h/2)*r}
	}
	return out
}

func (c *pdfCtx) shapeBody(node map[string]any) {
	w, h := sizeOf(node)
	switch asStr(node["shape"]) {
	case "rect":
		c.op("0 0 " + pn(w) + " " + pn(h) + " re")
		c.paintAndStroke(node)
	case "ellipse":
		c.emitEllipse(w, h)
		c.paintAndStroke(node)
	case "polygon":
		sides := int(asNum(node["sides"]))
		if sides == 0 {
			sides = 3
		}
		c.emitPolyPoints(polygonPoints(w, h, sides))
		c.paintAndStroke(node)
	case "triangle":
		c.emitPolyPoints(polygonPoints(w, h, 3))
		c.paintAndStroke(node)
	case "star":
		pts := int(asNum(node["sides"]))
		if pts == 0 {
			pts = 5
		}
		ir := asNum(node["innerRadius"])
		if ir == 0 {
			ir = 0.5
		}
		c.emitPolyPoints(starPoints(w, h, pts, ir))
		c.paintAndStroke(node)
	}
}

func (c *pdfCtx) pathBody(node map[string]any) {
	segs := asArr(node["segments"])
	if len(segs) == 0 {
		return
	}
	closed := asBool(node["closed"])
	first := asObj(segs[0])
	c.op(pn(asNum(first["x"])) + " " + pn(asNum(first["y"])) + " m")
	count := len(segs) - 1
	if closed {
		count = len(segs)
	}
	for i := 0; i < count; i++ {
		from := asObj(segs[i])
		to := asObj(segs[(i+1)%len(segs)])
		cOut := asObj(from["cOut"])
		cIn := asObj(to["cIn"])
		if cOut != nil || cIn != nil {
			c1x, c1y := asNum(from["x"]), asNum(from["y"])
			if cOut != nil {
				c1x, c1y = asNum(cOut["x"]), asNum(cOut["y"])
			}
			c2x, c2y := asNum(to["x"]), asNum(to["y"])
			if cIn != nil {
				c2x, c2y = asNum(cIn["x"]), asNum(cIn["y"])
			}
			c.op(pn(c1x) + " " + pn(c1y) + " " + pn(c2x) + " " + pn(c2y) + " " + pn(asNum(to["x"])) + " " + pn(asNum(to["y"])) + " c")
		} else {
			c.op(pn(asNum(to["x"])) + " " + pn(asNum(to["y"])) + " l")
		}
	}
	if closed {
		c.op("h")
	}
	c.paintAndStroke(node)
}

func (c *pdfCtx) lineBody(node map[string]any) {
	pts := asArr(node["points"])
	if len(pts) == 0 {
		return
	}
	for i, p := range pts {
		po := asObj(p)
		if i == 0 {
			c.op(pn(asNum(po["x"])) + " " + pn(asNum(po["y"])) + " m")
		} else {
			c.op(pn(asNum(po["x"])) + " " + pn(asNum(po["y"])) + " l")
		}
	}
	stroke := asObj(node["stroke"])
	if stroke != nil {
		sc := pdfPaint(asObj(stroke["fill"]))
		if sc.ok {
			c.op(pn(sc.r) + " " + pn(sc.g) + " " + pn(sc.b) + " RG")
			c.op(pn(asNum(stroke["width"])) + " w")
		}
	}
	c.op("S")
}

func pdfEscapeText(s string) string {
	r := strings.NewReplacer("\\", "\\\\", "(", "\\(", ")", "\\)", "\r", "", "\n", " ")
	return r.Replace(s)
}

// textBody emits text runs. PDF text space is y-up; because the page content is
// already flipped to y-down, we counter-flip within the text block so glyphs are
// upright (Tm with negative d).
func (c *pdfCtx) textBody(node map[string]any) {
	y := 0.0
	for _, para := range asArr(node["content"]) {
		po := asObj(para)
		lineHeight := 0.0
		runs := asArr(po["runs"])
		for _, run := range runs {
			ro := asObj(run)
			style := asObj(ro["style"])
			size := asNum(style["fontSize"])
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
			fc := pdfPaint(asObj(style["fill"]))
			if !fc.ok {
				fc = pdfColor{r: 0, g: 0, b: 0, ok: true}
			}
			text := asStr(ro["text"])
			// Pick a base-14 font from the run's family/style/weight, then use its
			// real glyph metrics for an accurate advance (FR: faithful text PDF).
			bold := asNum(style["weight"]) >= 600
			font := selectFont(asStr(style["fontFamily"]), asStr(style["fontStyle"]), bold, asBool(style["italic"]))
			ls := asNum(style["letterSpacing"])
			c.op("BT")
			c.op(pn(fc.r) + " " + pn(fc.g) + " " + pn(fc.b) + " rg")
			c.op("/" + font.key + " " + pn(size) + " Tf")
			if ls != 0 {
				c.op(pn(ls) + " Tc")
			}
			// Tm: counter-flip the y axis (1 0 0 -1) and place the baseline at (x,y).
			c.op("1 0 0 -1 " + pn(x) + " " + pn(y) + " Tm")
			c.op("(" + pdfEscapeText(text) + ") Tj")
			c.op("ET")
			x += textAdvance(font, text, size, ls)
		}
	}
}

// emitNode draws a node, wrapping it in the marked content that makes it
// reachable (or deliberately unreachable) from the structure tree.
//
// `inArtifact` is set once an ancestor was marked decorative. Marked-content
// sequences do not nest across that boundary: everything under a decorative
// group is already artifact, so a child must not open a tag of its own.
//
// Containers (group, frame, grid) are transparent. They carry no words, so
// tagging them would add a level a screen reader must step through for nothing;
// their children are tagged individually instead.
func (c *pdfCtx) emitNode(node map[string]any, inArtifact bool) {
	if asBool(node["hidden"]) {
		return
	}
	kind := asStr(node["type"])
	container := kind == "group" || kind == "frame" || kind == "grid"
	marked := false
	if !inArtifact {
		switch {
		case isDecorative(node):
			c.beginArtifact()
			marked, inArtifact = true, true
		case container:
			// transparent: no tag of its own
		case tagRole(node) == "":
			c.beginArtifact()
			marked = true
		default:
			c.beginTag(tagRole(node), nodeAltText(node))
			marked = true
		}
	}
	defer func() {
		if marked {
			c.endMarked()
		}
	}()
	c.op("q")
	// Apply the node transform matrix (same a b c d e f as the SVG matrix). A
	// connector is drawn from connectorPoints in absolute PAGE space, so it must
	// NOT be re-transformed by its own matrix (mirrors the engine); use identity.
	a, b, cc, d, e, f := transformMatrix(node)
	if asStr(node["type"]) == "connector" {
		a, b, cc, d, e, f = 1, 0, 0, 1, 0, 0
	}
	c.op(pn(a) + " " + pn(b) + " " + pn(cc) + " " + pn(d) + " " + pn(e) + " " + pn(f) + " cm")
	switch asStr(node["type"]) {
	case "shape":
		c.shapeBody(node)
	case "path":
		c.pathBody(node)
	case "line":
		c.lineBody(node)
	case "text":
		c.textBody(node)
	case "ink":
		c.inkBody(node)
	case "sticky":
		c.stickyBody(node)
	case "connector":
		c.connectorBody(node)
	case "group", "frame", "grid":
		for _, ch := range childrenOf(node) {
			c.emitNode(asObj(ch), inArtifact)
		}
	}
	c.op("Q")
}

// --- F30 board nodes (PDF has no alpha, so ink opacity is approximated opaque) ---

func (c *pdfCtx) inkBody(node map[string]any) {
	pts := inkPoints(node)
	if len(pts) == 0 {
		return
	}
	col, width, _, _ := inkBrush(node)
	if !col.ok {
		return
	}
	if len(pts) == 1 {
		c.op(pn(col.r) + " " + pn(col.g) + " " + pn(col.b) + " rg")
		c.op(pn(pts[0][0]-width/2) + " " + pn(pts[0][1]-width/2) + " " + pn(width) + " " + pn(width) + " re")
		c.op("f")
		return
	}
	c.op(pn(col.r) + " " + pn(col.g) + " " + pn(col.b) + " RG")
	c.op(pn(width) + " w")
	c.op("1 J")
	c.op("1 j")
	c.op(pn(pts[0][0]) + " " + pn(pts[0][1]) + " m")
	for i := 1; i < len(pts); i++ {
		c.op(pn(pts[i][0]) + " " + pn(pts[i][1]) + " l")
	}
	c.op("S")
}

func (c *pdfCtx) stickyBody(node map[string]any) {
	w, h := sizeOf(node)
	if fc := pdfPaint(asObj(node["fill"])); fc.ok {
		c.op(pn(fc.r) + " " + pn(fc.g) + " " + pn(fc.b) + " rg")
		c.op("0 0 " + pn(w) + " " + pn(h) + " re")
		c.op("f")
	}
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
	fnt := selectFont(asStr(node["fontFamily"]), "", false, false)
	lineH := fontPx * 1.25
	lines := wrapStickyLines(text, w-pad*2, fontPx)
	y := math.Max(pad, (h-float64(len(lines))*lineH)/2) + fontPx
	for _, ln := range lines {
		if y > h {
			break
		}
		c.op("BT")
		c.op(pn(tc.r) + " " + pn(tc.g) + " " + pn(tc.b) + " rg")
		c.op("/" + fnt.key + " " + pn(fontPx) + " Tf")
		c.op("1 0 0 -1 " + pn(pad) + " " + pn(y) + " Tm")
		c.op("(" + pdfEscapeText(ln) + ") Tj")
		c.op("ET")
		y += lineH
	}
}

func (c *pdfCtx) fillTriangle(tri [][2]float64, col pdfColor) {
	if len(tri) != 3 {
		return
	}
	c.op(pn(col.r) + " " + pn(col.g) + " " + pn(col.b) + " rg")
	c.op(pn(tri[0][0]) + " " + pn(tri[0][1]) + " m")
	c.op(pn(tri[1][0]) + " " + pn(tri[1][1]) + " l")
	c.op(pn(tri[2][0]) + " " + pn(tri[2][1]) + " l")
	c.op("h")
	c.op("f")
}

func (c *pdfCtx) connectorBody(node map[string]any) {
	pts := connectorPoints(node, c.boxes)
	if len(pts) < 2 {
		return
	}
	col := connectorStrokeColor(node)
	width := connectorStrokeWidth(node)
	c.op(pn(col.r) + " " + pn(col.g) + " " + pn(col.b) + " RG")
	c.op(pn(width) + " w")
	c.op("1 J")
	c.op("1 j")
	c.op(pn(pts[0][0]) + " " + pn(pts[0][1]) + " m")
	for i := 1; i < len(pts); i++ {
		c.op(pn(pts[i][0]) + " " + pn(pts[i][1]) + " l")
	}
	c.op("S")
	if capIs(node, "endCap", "arrow") {
		c.fillTriangle(arrowHead(pts[len(pts)-2], pts[len(pts)-1], width), col)
	}
	if capIs(node, "startCap", "arrow") {
		c.fillTriangle(arrowHead(pts[1], pts[0], width), col)
	}
	if txt, pos := connectorLabel(node); txt != "" {
		at := pointAlong(pts, pos)
		fontPx := 12.0
		fnt := selectFont("", "", false, false)
		tw := textAdvance(fnt, txt, fontPx, 0)
		c.op("1 1 1 rg")
		c.op(pn(at[0]-tw/2-5) + " " + pn(at[1]-9) + " " + pn(tw+10) + " 18 re")
		c.op("f")
		c.op("BT")
		c.op("0.2 0.255 0.333 rg")
		c.op("/" + fnt.key + " " + pn(fontPx) + " Tf")
		c.op("1 0 0 -1 " + pn(at[0]-tw/2) + " " + pn(at[1]+4) + " Tm")
		c.op("(" + pdfEscapeText(txt) + ") Tj")
		c.op("ET")
	}
}

// transformMatrix returns the 2D affine components (mirrors matrixAttr).
func transformMatrix(node map[string]any) (a, b, cc, d, e, f float64) {
	t := asObj(node["transform"])
	if t == nil {
		return 1, 0, 0, 1, 0, 0
	}
	sx, sy := asNum(t["scaleX"]), asNum(t["scaleY"])
	if t["scaleX"] == nil {
		sx = 1
	}
	if t["scaleY"] == nil {
		sy = 1
	}
	rot := asNum(t["rotation"]) * math.Pi / 180
	cos, sin := math.Cos(rot), math.Sin(rot)
	tanX, tanY := 0.0, 0.0
	if v, ok := t["skewX"].(float64); ok {
		tanX = math.Tan(v * math.Pi / 180)
	}
	if v, ok := t["skewY"].(float64); ok {
		tanY = math.Tan(v * math.Pi / 180)
	}
	ksa, ksb, ksc, ksd := sx, tanY*sx, tanX*sy, sy
	return cos*ksa - sin*ksb, sin*ksa + cos*ksb, cos*ksc - sin*ksd, sin*ksc + cos*ksd, asNum(t["x"]), asNum(t["y"])
}

// pdfPage is one rendered page: its content stream, its box, its structure
// tags in reading order, and the name that titles it.
type pdfPage struct {
	content []byte
	w, h    float64
	tags    []pdfTag
	name    string
}

// ToPDF renders one page of a design to a single-page PDF document.
func ToPDF(file Design, pageIndex int) ([]byte, error) {
	pages := asArr(file["pages"])
	if pageIndex < 0 || pageIndex >= len(pages) {
		return nil, ErrPageRange
	}
	return assemblePDF([]pdfPage{renderPDFPage(asObj(pages[pageIndex]))}), nil
}

// ToDeckPDF renders every page of a design into one tagged PDF, so a whole deck
// exports as a single accessible document (doc 28 FR-22). Hidden slides are
// skipped, matching present mode: a slide the author hid is not part of the
// deck being delivered.
func ToDeckPDF(file Design) ([]byte, error) {
	var out []pdfPage
	for _, p := range asArr(file["pages"]) {
		page := asObj(p)
		if asBool(page["hidden"]) {
			continue
		}
		out = append(out, renderPDFPage(page))
	}
	if len(out) == 0 {
		return nil, ErrPageRange
	}
	return assemblePDF(out), nil
}

// renderPDFPage draws one page and collects the structure tags it produced.
func renderPDFPage(page map[string]any) pdfPage {
	w, h := asNum(page["width"]), asNum(page["height"])

	c := &pdfCtx{boxes: pageBoxMap(page)}
	// Flip to design space (top-left origin, y-down).
	c.op("1 0 0 -1 0 " + pn(h) + " cm")
	// Background. Purely presentational, so it is an artifact: a screen reader
	// should never announce the slide's backdrop.
	if bg := asObj(page["background"]); bg != nil {
		if k := asStr(bg["type"]); k != "pattern" && k != "image" {
			if fc := pdfPaint(bg); fc.ok {
				c.beginArtifact()
				c.op(pn(fc.r) + " " + pn(fc.g) + " " + pn(fc.b) + " rg")
				c.op("0 0 " + pn(w) + " " + pn(h) + " re")
				c.op("f")
				c.endMarked()
			}
		}
	}
	// Draw in z-order, remembering which tags each top-level node produced, so
	// the structure tree can be assembled in reading order without disturbing
	// how the page looks. A node may produce several tags (a group), or none
	// (it was decorative, and became an artifact).
	spans := make(map[string][2]int, len(asArr(page["children"])))
	for _, n := range asArr(page["children"]) {
		node := asObj(n)
		start := len(c.tags)
		c.emitNode(node, false)
		spans[asStr(node["id"])] = [2]int{start, len(c.tags)}
	}
	var ordered []pdfTag
	for _, n := range resolveReadingOrder(page) {
		if s, ok := spans[asStr(asObj(n)["id"])]; ok {
			ordered = append(ordered, c.tags[s[0]:s[1]]...)
		}
	}

	return pdfPage{content: c.buf.Bytes(), w: w, h: h, tags: ordered, name: asStr(page["name"])}
}

// assemblePDF writes a valid PDF over one or more pages, registering the base-14
// font set used by text runs, with a correct xref table and an accessibility
// structure tree (doc 28 FR-22).
//
// Each page's `tags` arrive in reading order; a tag's `mcid` points back at the
// marked content in that page's stream, which is in z-order. A page's name
// titles its Sect element, which is what gives a slide a navigable name in a
// screen reader.
//
// Object layout: 1 Catalog, 2 Pages, then the fonts, then a Page and a Contents
// object per page, then the structure tree (root, Document, a Sect per page,
// one element per tag), and finally the number tree mapping marked content back
// to its element. Marked-content ids restart at zero on every page, so a page's
// /StructParents key is its index into that tree.
func assemblePDF(pages []pdfPage) []byte {
	// Font objects come first so their numbers do not depend on the page count.
	var fontDict strings.Builder
	fontObjs := make([]string, len(pdfFontTable))
	for i, f := range pdfFontTable {
		fmt.Fprintf(&fontDict, "/%s %d 0 R ", f.key, 3+i)
		fontObjs[i] = fmt.Sprintf("<< /Type /Font /Subtype /Type1 /BaseFont /%s /Encoding /WinAnsiEncoding >>", f.baseFont)
	}
	firstPage := 3 + len(pdfFontTable)
	pageObj := func(i int) int { return firstPage + 2*i } // page, then its contents
	structRoot := firstPage + 2*len(pages)
	docElem := structRoot + 1
	sectElem := func(i int) int { return docElem + 1 + i }
	firstLeaf := sectElem(len(pages))

	total := 0
	for _, p := range pages {
		total += len(p.tags)
	}
	parentTree := firstLeaf + total

	var (
		pageObjs, contentObjs, sectObjs, leafObjs []string
		nums                                      []string
		leafNo                                    = firstLeaf
		kidRefs                                   strings.Builder
	)
	for i, p := range pages {
		pageObjs = append(pageObjs, fmt.Sprintf(
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %s %s] /Resources << /Font << %s>> >> /Contents %d 0 R /StructParents %d /Tabs /S >>",
			pn(p.w), pn(p.h), fontDict.String(), pageObj(i)+1, i))
		contentObjs = append(contentObjs, fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(p.content)+1, p.content))

		// One structure element per tag, in reading order, each pointing at its
		// marked content by id. /Alt is what a screen reader announces.
		var kids strings.Builder
		pageNums := make([]string, len(p.tags))
		for _, t := range p.tags {
			alt := ""
			if t.alt != "" {
				alt = fmt.Sprintf(" /Alt (%s)", pdfEscapeText(t.alt))
			}
			leafObjs = append(leafObjs, fmt.Sprintf("<< /Type /StructElem /S /%s /P %d 0 R /Pg %d 0 R /K %d%s >>",
				t.role, sectElem(i), pageObj(i), t.mcid, alt))
			fmt.Fprintf(&kids, "%d 0 R ", leafNo)
			// The number tree is indexed by mcid (z-order), not reading order.
			pageNums[t.mcid] = fmt.Sprintf("%d 0 R", leafNo)
			leafNo++
		}
		nums = append(nums, fmt.Sprintf("%d [%s]", i, strings.Join(pageNums, " ")))

		title := p.name
		if title == "" {
			title = fmt.Sprintf("Slide %d", i+1)
		}
		sectObjs = append(sectObjs, fmt.Sprintf("<< /Type /StructElem /S /%s /P %d 0 R /Pg %d 0 R /T (%s) /K [%s] >>",
			tagSection, docElem, pageObj(i), pdfEscapeText(title), strings.TrimSpace(kids.String())))
		fmt.Fprintf(&kidRefs, "%d 0 R ", sectElem(i))
	}

	var pageRefs strings.Builder
	for i := range pages {
		fmt.Fprintf(&pageRefs, "%d 0 R ", pageObj(i))
	}

	objs := []string{
		// /Lang states the document's natural language, which PDF/UA requires.
		// The open format has no document-level language yet, so this is the
		// default rather than a claim about the deck's actual language.
		fmt.Sprintf("<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> /StructTreeRoot %d 0 R /Lang (en-US) /ViewerPreferences << /DisplayDocTitle true >> >>", structRoot),
		fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", strings.TrimSpace(pageRefs.String()), len(pages)),
	}
	objs = append(objs, fontObjs...)
	for i := range pages {
		objs = append(objs, pageObjs[i], contentObjs[i])
	}
	objs = append(objs,
		// Every role we emit is a standard structure type, so no /RoleMap.
		fmt.Sprintf("<< /Type /StructTreeRoot /K [%d 0 R] /ParentTree %d 0 R /ParentTreeNextKey %d >>", docElem, parentTree, len(pages)),
		fmt.Sprintf("<< /Type /StructElem /S /%s /P %d 0 R /K [%s] >>", tagDocument, structRoot, strings.TrimSpace(kidRefs.String())),
	)
	objs = append(objs, sectObjs...)
	objs = append(objs, leafObjs...)
	objs = append(objs, fmt.Sprintf("<< /Nums [%s] >>", strings.Join(nums, " ")))
	var out bytes.Buffer
	out.WriteString("%PDF-1.7\n")
	offsets := make([]int, len(objs)+1)
	for i, body := range objs {
		offsets[i+1] = out.Len()
		out.WriteString(fmt.Sprintf("%d 0 obj\n%s\nendobj\n", i+1, body))
	}
	xrefPos := out.Len()
	out.WriteString(fmt.Sprintf("xref\n0 %d\n", len(objs)+1))
	out.WriteString("0000000000 65535 f \n")
	for i := 1; i <= len(objs); i++ {
		out.WriteString(fmt.Sprintf("%010d 00000 n \n", offsets[i]))
	}
	out.WriteString(fmt.Sprintf("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objs)+1, xrefPos))
	return out.Bytes()
}
