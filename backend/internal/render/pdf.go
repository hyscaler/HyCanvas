// PDF export: a minimal, dependency-free PDF writer that translates a page's
// scene graph to PDF vector operators. PDF user space is bottom-left/y-up, so
// the content stream first flips to the design's top-left/y-down space; each
// node's transform is applied inside a q/Q (save/restore) pair, mirroring the
// SVG <g> nesting. Text uses embedded design fonts where licensed and
// covering, else the Helvetica base-14 set; a run NEITHER can encode
// (Arabic, Hebrew, CJK without an embedded font) rasterizes through the
// effect-layer machinery instead of emitting mojibake, tagged as a Figure
// whose /Alt carries the words in UTF-16, and the outline effect strokes the
// node box over the vector body like the raster path.
//
// Fidelity notes (documented degradations vs the editable SVG): linear and
// radial gradient fills paint as real axial/radial shadings (clipped to the
// path, objectBoundingBox geometry like the SVG exporter); conic gradients
// and gradient TEXT/stroke fills still degrade to the first stop, and a fill
// color's own alpha channel is dropped (colors emit r,g,b only; shadings
// carry no per-stop alpha either). Node opacity and blend modes ARE applied,
// as /ExtGState entries (/ca /CA and /BM) referenced per node. Shadows,
// glows, and layer blurs are reproduced as embedded raster layers (PDF has
// no blur primitive), rendered by the same compositing code as the PNG
// export. Vector geometry, colors, transforms, and text position are
// faithful.
package render

import (
	"bytes"
	"fmt"
	"math"
	"strconv"
	"strings"
	"unicode/utf16"
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
	// Embedded images, deduplicated by asset id: a logo placed on every slide
	// is encoded once per page and drawn many times.
	src      ImageSource
	images   []*pdfImage
	imageByA map[string]*pdfImage
	// Fonts the design embeds (doc 28 FR-22). `fonts` is every font available
	// document-wide; `used` records the ones this page actually drew with, so a
	// page's resource dictionary lists only what it needs.
	fonts []*embeddedFont
	used  map[*embeddedFont]bool
	// Graphics states (F38 parity): node opacity and blend modes need an
	// ExtGState in PDF; these are deduplicated per page and written inline in
	// the page's resource dictionary.
	gstates  []pdfGState
	gstateBy map[string]int
	// Transparency groups (pdfgroup.go): each is a Form XObject written as its
	// own object and referenced from the page's /XObject dictionary.
	forms []pdfForm
	// Gradient shadings (F38 export parity), serialized dictionaries written
	// inline into the page's /Shading resources as /Sh0, /Sh1, ...
	shadings []string
	// Raster effect layers (pdffx.go) need the design (fonts/assets ride into
	// the synthetic single-node render), the page box, and the ancestor chain
	// of the node being emitted (for nested transforms and clips).
	file  Design
	pageW float64
	pageH float64
	chain []map[string]any
	// alpha is the cumulative opacity of the ancestor chain. A child's own
	// gs REPLACES the graphics-state alpha rather than compounding it, so a
	// child inside a half-opaque group must bake the product into its /ca.
	// Per-child multiplication (not a PDF transparency group) is DELIBERATE:
	// the engine (render2d.ts) and the raster path both multiply opacity down
	// the subtree with no isolated group layer, so overlapping siblings in a
	// translucent group double-darken identically on every path. A
	// transparency group here would make the PDF the one renderer that
	// composites differently.
	alpha float64
}

// pdfGState is one /ExtGState entry: constant alpha for fills and strokes,
// plus the blend mode.
type pdfGState struct {
	ca float64
	bm string // PDF blend-mode name, "" for Normal
}

// pdfBlendName maps the file format's CSS-style blend names to PDF's
// CamelCase /BM names. Unknown modes fall back to Normal rather than
// producing an invalid PDF.
func pdfBlendName(m string) string {
	switch m {
	case "multiply":
		return "Multiply"
	case "screen":
		return "Screen"
	case "overlay":
		return "Overlay"
	case "darken":
		return "Darken"
	case "lighten":
		return "Lighten"
	case "color-dodge":
		return "ColorDodge"
	case "color-burn":
		return "ColorBurn"
	case "hard-light":
		return "HardLight"
	case "soft-light":
		return "SoftLight"
	case "difference":
		return "Difference"
	case "exclusion":
		return "Exclusion"
	case "hue":
		return "Hue"
	case "saturation":
		return "Saturation"
	case "color":
		return "Color"
	case "luminosity":
		return "Luminosity"
	}
	return ""
}

// gstateFor returns the /GSn resource name for the given alpha and blend
// mode, registering it on first use.
func (c *pdfCtx) gstateFor(ca float64, bm string) string {
	key := pn(ca) + "|" + bm
	if c.gstateBy == nil {
		c.gstateBy = map[string]int{}
	}
	if i, ok := c.gstateBy[key]; ok {
		return fmt.Sprintf("GS%d", i)
	}
	i := len(c.gstates)
	c.gstates = append(c.gstates, pdfGState{ca: ca, bm: bm})
	c.gstateBy[key] = i
	return fmt.Sprintf("GS%d", i)
}

// imageBody draws an image node, embedding its asset the first time it is seen.
// The unit square an XObject paints into is y-up, and page content is already
// flipped to the design's y-down space, so the matrix counter-flips to put the
// image's top row at the node's top edge.
func (c *pdfCtx) imageBody(node map[string]any) {
	w, h := sizeOf(node)
	id, data, ok := assetBytes(node, c.src)
	if !ok {
		return // no pixels available; the node still keeps its structure tag
	}
	im, seen := c.imageByA[id]
	if !seen {
		var built bool
		im, built = encodeImage(fmt.Sprintf("Im%d", len(c.images)), data)
		if !built {
			return // undecodable bytes degrade to a missing image, not a failed export
		}
		if c.imageByA == nil {
			c.imageByA = map[string]*pdfImage{}
		}
		c.imageByA[id] = im
		c.images = append(c.images, im)
	}
	c.op(pn(w) + " 0 0 " + pn(-h) + " 0 " + pn(h) + " cm")
	c.op("/" + im.name + " Do")
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
	c.paintAndStrokeRule(node, false)
}

func (c *pdfCtx) paintAndStrokeRule(node map[string]any, evenOdd bool) {
	c.paintAndStrokeRepath(node, evenOdd, nil)
}

// paintAndStrokeRepath paints the current path; evenOdd selects the even-odd
// fill operators (f*/B*) for compound paths whose contours cut holes.
//
// `repath` re-emits the path construction operators. It exists for gradient
// fills, which paint by CLIPPING to the path and running a shading (`sh`):
// the clip consumes the current path, so both the clip itself (q may not
// interleave path construction) and a following stroke need the path rebuilt.
// With a nil repath a gradient degrades to its first stop, as before.
func (c *pdfCtx) paintAndStrokeRepath(node map[string]any, evenOdd bool, repath func()) {
	var fills []any = asArr(node["fills"])
	var fill map[string]any
	if len(fills) > 0 {
		fill = asObj(fills[0])
	}
	stroke := asObj(node["stroke"])
	var sc pdfColor
	if stroke != nil {
		sc = pdfPaint(asObj(stroke["fill"]))
	}

	// Real gradients (F38 export parity): axial/radial shadings clipped to the
	// path, in the same objectBoundingBox space the SVG exporter uses (the
	// unit-square cm below stretches the shading over the node box, which is
	// what makes a radial gradient elliptical on a non-square shape). Conic
	// gradients have no PDF shading type short of a mesh and keep degrading
	// to their first stop; per-stop alpha is dropped (PDF shadings carry no
	// alpha), matching the fill-alpha note in the header.
	if g := parseGradient(fill); g.ok && !g.conic && repath != nil {
		w, h := sizeOf(node)
		if w > 0 && h > 0 {
			name := c.shadingFor(g)
			clip := "W n"
			if evenOdd {
				clip = "W* n"
			}
			c.op("n") // drop the already-built path; the clip rebuilds it inside q/Q
			c.op("q")
			repath()
			c.op(clip)
			c.op(pn(w) + " 0 0 " + pn(h) + " 0 0 cm")
			c.op("/" + name + " sh")
			c.op("Q")
			if sc.ok {
				repath()
				c.op(pn(sc.r) + " " + pn(sc.g) + " " + pn(sc.b) + " RG")
				c.op(pn(asNum(stroke["width"])) + " w")
				c.op("S")
			}
			return
		}
	}

	fc := pdfPaint(fill)
	if fc.ok {
		c.op(pn(fc.r) + " " + pn(fc.g) + " " + pn(fc.b) + " rg")
	}
	if sc.ok {
		c.op(pn(sc.r) + " " + pn(sc.g) + " " + pn(sc.b) + " RG")
		c.op(pn(asNum(stroke["width"])) + " w")
	}
	fillOp, bothOp := "f", "B"
	if evenOdd {
		fillOp, bothOp = "f*", "B*"
	}
	switch {
	case fc.ok && sc.ok:
		c.op(bothOp)
	case fc.ok:
		c.op(fillOp)
	case sc.ok:
		c.op("S")
	default:
		c.op("n")
	}
}

// shadingFor registers a /Shading resource for the gradient, in a UNIT
// gradient space (the caller scales it over the node box with a cm), and
// returns its resource name.
func (c *pdfCtx) shadingFor(g gradSpec) string {
	fn := gradientFunction(g.stops)
	var dict string
	if g.radial {
		dict = "<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [" +
			pn(g.cx) + " " + pn(g.cy) + " 0 " + pn(g.cx) + " " + pn(g.cy) + " " + pn(g.radius) +
			"] /Function " + fn + " /Extend [true true] >>"
	} else {
		rad := g.angle * math.Pi / 180
		dx, dy := math.Cos(rad)*0.5, math.Sin(rad)*0.5
		dict = "<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [" +
			pn(0.5-dx) + " " + pn(0.5-dy) + " " + pn(0.5+dx) + " " + pn(0.5+dy) +
			"] /Function " + fn + " /Extend [true true] >>"
	}
	name := fmt.Sprintf("Sh%d", len(c.shadings))
	c.shadings = append(c.shadings, dict)
	return name
}

// gradientFunction builds the stop ramp as a Type 3 stitching of Type 2
// (linear) segments over [0,1]. Duplicated first/last stops pin the ends so
// a ramp that starts late holds its first color. Coincident stop positions
// (a hard CSS stop) contribute NO segment: dropping the zero-width span
// keeps /Bounds strictly increasing (the spec requires Domain0 < Bounds <
// Domain1, and a sub-precision nudge would collapse back to equality when
// pn() rounds to 3 decimals) while the color still jumps at the shared
// boundary, which is exactly hard-stop semantics.
func gradientFunction(stops []gradStop) string {
	ss := make([]gradStop, 0, len(stops)+2)
	if stops[0].pos > 0 {
		ss = append(ss, gradStop{pos: 0, col: stops[0].col, a: stops[0].a})
	}
	ss = append(ss, stops...)
	if last := ss[len(ss)-1]; last.pos < 1 {
		ss = append(ss, gradStop{pos: 1, col: last.col, a: last.a})
	}
	seg := func(a, b gradStop) string {
		return "<< /FunctionType 2 /Domain [0 1] /C0 [" +
			pn(a.col.r) + " " + pn(a.col.g) + " " + pn(a.col.b) + "] /C1 [" +
			pn(b.col.r) + " " + pn(b.col.g) + " " + pn(b.col.b) + "] /N 1 >>"
	}
	// pn() rounds to 3 decimals, so positions that would SERIALIZE equal are
	// coincident for the PDF's purposes, whatever their float delta.
	const quantum = 0.0005
	var fns, bounds []string
	prev := ss[0]
	for _, s := range ss[1:] {
		if s.pos <= prev.pos+quantum {
			prev = s // hard stop: the next kept segment starts from this color
			continue
		}
		if len(fns) > 0 {
			bounds = append(bounds, pn(prev.pos))
		}
		fns = append(fns, seg(prev, s))
		prev = s
	}
	if len(fns) == 0 {
		// Every stop coincident: a constant ramp.
		return seg(ss[0], ss[len(ss)-1])
	}
	if len(fns) == 1 {
		return fns[0]
	}
	encode := make([]string, len(fns))
	for i := range encode {
		encode[i] = "0 1"
	}
	return "<< /FunctionType 3 /Domain [0 1] /Functions [" + strings.Join(fns, " ") +
		"] /Bounds [" + strings.Join(bounds, " ") + "] /Encode [" + strings.Join(encode, " ") + "] >>"
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
	var build func()
	switch asStr(node["shape"]) {
	case "rect":
		build = func() { c.op("0 0 " + pn(w) + " " + pn(h) + " re") }
	case "ellipse":
		build = func() { c.emitEllipse(w, h) }
	case "polygon":
		sides := int(asNum(node["sides"]))
		if sides == 0 {
			sides = 3
		}
		build = func() { c.emitPolyPoints(polygonPoints(w, h, sides)) }
	case "triangle":
		build = func() { c.emitPolyPoints(polygonPoints(w, h, 3)) }
	case "star":
		pts := int(asNum(node["sides"]))
		if pts == 0 {
			pts = 5
		}
		ir := asNum(node["innerRadius"])
		if ir == 0 {
			ir = 0.5
		}
		build = func() { c.emitPolyPoints(starPoints(w, h, pts, ir)) }
	default:
		return
	}
	build()
	c.paintAndStrokeRepath(node, false, build)
}

// pathContourOps emits one subpath's construction operators.
func (c *pdfCtx) pathContourOps(segs []any, closed bool) {
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
}

func (c *pdfCtx) pathBody(node map[string]any) {
	segs := asArr(node["segments"])
	if len(segs) == 0 {
		return
	}
	// Extra contours of a compound path (schema v15) join the same path; the
	// even-odd operators make interior contours cut holes.
	compound := false
	build := func() {
		c.pathContourOps(segs, asBool(node["closed"]))
		for _, ct := range asArr(node["contours"]) {
			co := asObj(ct)
			if cs := asArr(co["segments"]); len(cs) >= 2 {
				c.pathContourOps(cs, asBool(co["closed"]))
				compound = true
			}
		}
	}
	build()
	c.paintAndStrokeRepath(node, compound, build)
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

// pdfTextString serializes a human-readable string for a PDF dictionary
// value (/Alt and friends): ASCII stays a literal; anything else becomes a
// UTF-16BE hex string with a BOM, the PDF-native way to carry Unicode. A raw
// UTF-8 literal would be read back as Latin-1 mojibake, which for /Alt means
// a screen reader announcing garbage.
func pdfTextString(s string) string {
	ascii := true
	for _, r := range s {
		if r < 0x20 || r > 0x7E {
			ascii = false
			break
		}
	}
	if ascii {
		return "(" + pdfEscapeText(s) + ")"
	}
	var b strings.Builder
	b.WriteString("<FEFF")
	for _, u := range utf16.Encode([]rune(s)) {
		fmt.Fprintf(&b, "%04X", u)
	}
	b.WriteString(">")
	return b.String()
}

// pdfTextEncodable reports whether the PDF text operators can actually SHOW
// this node's runs: an embedded design font that covers the run, or (for the
// base-14 fallback) text whose runes fit the WinAnsi single-byte encoding.
// Anything else would come out as mojibake, each UTF-8 byte drawn as its own
// Latin-1 glyph.
func (c *pdfCtx) pdfTextEncodable(node map[string]any) bool {
	for _, para := range asArr(node["content"]) {
		for _, run := range asArr(asObj(para)["runs"]) {
			ro := asObj(run)
			text := asStr(ro["text"])
			if emb := findEmbedded(c.fonts, asStr(asObj(ro["style"])["fontFamily"])); emb != nil && emb.covers(text) {
				continue
			}
			for _, r := range text {
				if r > 0xFF {
					return false
				}
			}
		}
	}
	return true
}

// textContentOf joins a text node's runs into the plain string a screen
// reader should hear when the glyphs themselves had to be rasterized.
func textContentOf(node map[string]any) string {
	var b strings.Builder
	for _, para := range asArr(node["content"]) {
		if b.Len() > 0 {
			b.WriteString(" ")
		}
		for _, run := range asArr(asObj(para)["runs"]) {
			b.WriteString(asStr(asObj(run)["text"]))
		}
	}
	return b.String()
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
			ls := asNum(style["letterSpacing"])
			family := asStr(style["fontFamily"])

			// The design's own font wins when it is embeddable and has a glyph for
			// every character in the run (doc 28 FR-22). A run that the font cannot
			// fully cover falls back whole, so a line never renders half in the real
			// typeface and half in Helvetica. Everything else keeps the base-14
			// mapping, which is what this encoder has always done.
			emb := findEmbedded(c.fonts, family)
			if emb != nil && !emb.covers(text) {
				emb = nil
			}
			if emb != nil {
				c.used[emb] = true
			}

			var (
				fontKey string
				show    string
				advance float64
			)
			if emb != nil {
				// Identity-H addresses glyphs by id, so the string is raw glyph ids.
				fontKey = emb.key
				show = "<" + emb.hexGlyphs(text) + ">"
				advance = emb.textWidth(text, size, ls)
			} else {
				bold := asNum(style["weight"]) >= 600
				font := selectFont(family, asStr(style["fontStyle"]), bold, asBool(style["italic"]))
				fontKey = font.key
				show = "(" + pdfEscapeText(text) + ")"
				advance = textAdvance(font, text, size, ls)
			}

			c.op("BT")
			c.op(pn(fc.r) + " " + pn(fc.g) + " " + pn(fc.b) + " rg")
			c.op("/" + fontKey + " " + pn(size) + " Tf")
			if ls != 0 {
				c.op(pn(ls) + " Tc")
			}
			// Tm: counter-flip the y axis (1 0 0 -1) and place the baseline at (x,y).
			c.op("1 0 0 -1 " + pn(x) + " " + pn(y) + " Tm")
			c.op(show + " Tj")
			c.op("ET")
			x += advance
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
	// A text node the PDF text operators cannot encode (no covering embedded
	// font and runes beyond WinAnsi: Arabic, Hebrew, CJK, ...) RASTERIZES
	// through the effect-layer machinery instead of emitting mojibake, and
	// its tag becomes a Figure carrying the plain text as /Alt, so a screen
	// reader still hears the words the pixels show.
	rasterText := kind == "text" && !c.pdfTextEncodable(node)
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
		case rasterText:
			c.beginTag("Figure", textContentOf(node))
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
	// Node opacity and blend mode ride on an ExtGState (PDF has no inline
	// alpha operator). Shadows/glow/blur are NOT emitted on this path; the
	// PDF keeps the unfiltered artwork for those (see the header note).
	// Opacity MULTIPLIES down the ancestor chain (parity with the raster
	// path): a child's gs replaces the inherited alpha, so the effective
	// value is baked into each node's /ca.
	// c.alpha is initialized to 1 at ctx construction, so a genuine inherited
	// alpha of 0 (an ancestor at opacity 0) stays 0 and its subtree stays
	// invisible, exactly like the raster path.
	parentAlpha := c.alpha
	ca := parentAlpha
	if op, ok := node["opacity"].(float64); ok && op >= 0 && op < 1 {
		ca = parentAlpha * op
	}
	if ca < 1 || pdfBlendName(blendModeOf(node)) != "" {
		c.op("/" + c.gstateFor(ca, pdfBlendName(blendModeOf(node))) + " gs")
	}
	c.alpha = ca
	defer func() { c.alpha = parentAlpha }()

	// Raster effect layers (pdffx.go): a shadow/glow underlay drawn beneath
	// the vector body, and for content-altering effects (blur/adjust/duotone)
	// a processed raster that REPLACES the body - unless the subtree draws
	// text, which stays vector so tagged-PDF text extraction keeps working.
	// Drawn before the node's own cm (the layers are rendered in page space).
	fx := pdfFxOf(node)
	if rasterText {
		fx.replace, fx.composed, fx.underlay = true, true, false
	}
	if fx.underlay || fx.replace {
		hasText := containsText(node) && !rasterText
		if !pdfDrawableType(kind) {
			// The PDF body path cannot draw this type at all (chart, table,
			// qr, ...): an underlay with no body would show a floating
			// shadow, so the whole node rasterizes, silhouette effects
			// included.
			fx.replace, fx.composed, fx.underlay = true, true, false
		}
		if pdfBlendName(blendModeOf(node)) != "" && !hasText {
			// A blend mode must apply ONCE to the finished layer (node over
			// its own shadow), like the raster path's isolated layer;
			// blending the underlay and body as two separate draws would
			// blend the node against its own shadow.
			fx.replace, fx.composed, fx.underlay = true, true, false
		}
		if fx.replace && !fx.composed && hasText {
			fx.replace = false
		}
		if fx.composed && hasText {
			// Text extraction wins over pixel parity: keep the vector body
			// and accept the two-draw blend divergence for this rare combo.
			fx.replace, fx.composed = false, false
			fx.underlay = len(shadowsOf(node)) > 0 || hasGlowFx(node)
		}
		under, bodyIm, ub, bb := c.fxLayers(node, fx)
		if under != nil {
			c.drawFxImage(under, ub)
		}
		if fx.replace && bodyIm != nil {
			if !marked && !inArtifact {
				// A rasterized container is real content: tag it as a Figure
				// so the structure tree still covers it (its descendants'
				// tags are gone with the vector children).
				c.beginTag("Figure", nodeAltText(node))
				marked = true
			}
			c.drawFxImage(bodyIm, bb)
			c.op("Q")
			return
		}
	}
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
	case "image":
		c.imageBody(node)
	case "ink":
		c.inkBody(node)
	case "sticky":
		c.stickyBody(node)
	case "connector":
		c.connectorBody(node)
	case "group", "frame", "grid":
		// Track the ancestor chain so a nested child's raster effect layers
		// (pdffx.go) can reproduce its transforms/clips and undo the CTM.
		c.chain = append(c.chain, node)
		emitKids := func() {
			for _, ch := range childrenOf(node) {
				c.emitNode(asObj(ch), inArtifact)
			}
		}
		if groupNeedsIsolation(node) {
			// The group's alpha was already written onto this node's own gs
			// above, which is the multiply-down model: it would reach each
			// child and darken every overlap. Re-emit it as the group's
			// composite alpha instead and neutralize it for the contents.
			c.op("/" + c.gstateFor(1, "") + " gs")
			c.emitTransparencyGroup(node, ca, pdfBlendName(blendModeOf(node)), emitKids)
		} else {
			emitKids()
		}
		c.chain = c.chain[:len(c.chain)-1]
	case "mask":
		// A real PDF clip (`W n`), so the mask stays vector in the export
		// rather than being dropped as it was before. The clip is scoped by
		// q/Q so it cannot leak onto whatever is emitted next.
		//
		// An unusable shape emits the child UNCLIPPED. An empty clip path in
		// PDF clips everything away, so failing the other way would turn a
		// document that exports today into one that exports blank.
		if child := asObj(node["child"]); child != nil {
			shape := asObj(node["maskShape"])
			clipped := false
			if shape != nil {
				c.op("q")
				if pdfMaskPath(c, shape) {
					if asStr(shape["fillRule"]) == "evenodd" {
						c.op("W* n")
					} else {
						c.op("W n")
					}
					clipped = true
				} else {
					c.op("Q")
				}
			}
			c.chain = append(c.chain, node)
			c.emitNode(child, inArtifact)
			c.chain = c.chain[:len(c.chain)-1]
			if clipped {
				c.op("Q")
			}
		}
	}
	// Outline effect: stroke the node's box OVER its own content, mirroring
	// the raster path's outlineBox (drawn after everything else so it does
	// not thicken any shadow silhouette; text is exempt there too). Emitted
	// in the node's local space, so the box follows the transform.
	if kind != "text" {
		if w, h := sizeOf(node); w > 0 && h > 0 {
			for _, e := range effectsOf(node) {
				if e.kind != "outline" {
					continue
				}
				width := asNum(e.raw["width"])
				ocol, ca := shadowColor(asObj(e.raw["color"]))
				if width <= 0 || ca <= 0 {
					continue
				}
				c.op(pn(ocol.r) + " " + pn(ocol.g) + " " + pn(ocol.b) + " RG")
				c.op(pn(width) + " w")
				c.op("0 0 " + pn(w) + " " + pn(h) + " re")
				c.op("S")
			}
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
	content  []byte
	w, h     float64
	tags     []pdfTag
	name     string
	images   []*pdfImage
	fonts    []*embeddedFont // the embedded fonts this page drew with
	gstates  []pdfGState     // opacity/blend graphics states this page used
	shadings []string        // gradient shading dicts this page used
	forms    []pdfForm       // transparency groups this page emitted
}

// ToPDF renders one page of a design to a single-page PDF document. An optional
// ImageSource supplies asset bytes; without one, image nodes draw nothing, which
// is what this encoder did before it could embed images at all.
// pdfLang is the document's natural language as a BCP 47 tag for /Lang.
// The open format has no first-class language field yet (it arrives with the
// localization work), so it is read from `meta.language` where an author or an
// importer has set one, and falls back to en-US. Validated rather than
// interpolated blindly: /Lang is written into the PDF catalog, so an arbitrary
// string there would let document content escape into PDF syntax.
func pdfLang(file Design) string {
	// v18 files carry a first-class `language`; older files (and importers)
	// wrote `meta.language`. Read both so mixed versions keep exporting right.
	tag, _ := file["language"].(string)
	if !validLangTag(tag) {
		meta, _ := file["meta"].(map[string]any)
		tag, _ = meta["language"].(string)
	}
	if !validLangTag(tag) {
		return "en-US"
	}
	return tag
}

// validLangTag accepts the conservative BCP 47 shape this needs: letter-only
// subtags of 1 to 8 characters, separated by hyphens, at most 3 subtags.
func validLangTag(tag string) bool {
	if tag == "" || len(tag) > 35 {
		return false
	}
	parts := strings.Split(tag, "-")
	if len(parts) > 3 {
		return false
	}
	for _, p := range parts {
		if len(p) < 1 || len(p) > 8 {
			return false
		}
		for _, r := range p {
			if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') {
				return false
			}
		}
	}
	return true
}

func ToPDF(file Design, pageIndex int, src ...ImageSource) ([]byte, error) {
	// PDF is vector output, so the resolution class is nominal (1): the graph
	// re-evaluates, but there is no raster scale to match.
	pages := asArr(file["pages"])
	if pageIndex < 0 || pageIndex >= len(pages) {
		return nil, ErrPageRange
	}
	fonts := parseDesignFonts(file)
	return assemblePDF([]pdfPage{renderPDFPage(file, asObj(pages[pageIndex]), firstSource(src), fonts)}, fonts, pdfLang(file)), nil
}

func firstSource(src []ImageSource) ImageSource {
	if len(src) == 0 {
		return nil
	}
	return src[0]
}

// ToDeckPDF renders every page of a design into one tagged PDF, so a whole deck
// exports as a single accessible document (doc 28 FR-22). Hidden slides are
// skipped, matching present mode: a slide the author hid is not part of the
// deck being delivered.
func ToDeckPDF(file Design, src ...ImageSource) ([]byte, error) {
	fonts := parseDesignFonts(file)
	var out []pdfPage
	for _, p := range asArr(file["pages"]) {
		page := asObj(p)
		if asBool(page["hidden"]) {
			continue
		}
		out = append(out, renderPDFPage(file, page, firstSource(src), fonts))
	}
	if len(out) == 0 {
		return nil, ErrPageRange
	}
	return assemblePDF(out, fonts, pdfLang(file)), nil
}

// renderPDFPage draws one page and collects the structure tags it produced.
func renderPDFPage(file Design, page map[string]any, src ImageSource, fonts []*embeddedFont) pdfPage {
	w, h := asNum(page["width"]), asNum(page["height"])

	c := &pdfCtx{boxes: pageBoxMap(page), src: src, fonts: fonts, used: map[*embeddedFont]bool{}, file: file, pageW: w, pageH: h, alpha: 1}
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

	// Keep the page's font list in the document's order, so the resource
	// dictionary is deterministic rather than map-iteration order.
	var pageFonts []*embeddedFont
	for _, f := range fonts {
		if c.used[f] {
			pageFonts = append(pageFonts, f)
		}
	}
	return pdfPage{content: c.buf.Bytes(), w: w, h: h, tags: ordered, name: asStr(page["name"]), images: c.images, fonts: pageFonts, gstates: c.gstates, shadings: c.shadings, forms: c.forms}
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
func assemblePDF(pages []pdfPage, embedded []*embeddedFont, lang string) []byte {
	// Font objects come first so their numbers do not depend on the page count.
	var fontDict strings.Builder
	fontObjs := make([]string, len(pdfFontTable))
	for i, f := range pdfFontTable {
		fmt.Fprintf(&fontDict, "/%s %d 0 R ", f.key, 3+i)
		fontObjs[i] = fmt.Sprintf("<< /Type /Font /Subtype /Type1 /BaseFont /%s /Encoding /WinAnsiEncoding >>", f.baseFont)
	}
	// Each embedded font contributes five objects (Type0, CIDFontType2 descendant,
	// descriptor, the font file, and the ToUnicode CMap). They are emitted after
	// the base-14 set and shared by every page that draws with them. This runs
	// after all pages have rendered, so each font's used-glyph set, and therefore
	// its width array and CMap, is complete.
	next := 3 + len(pdfFontTable)
	var embObjs []string
	embResource := make(map[*embeddedFont]string, len(embedded))
	for _, e := range embedded {
		if len(e.used) == 0 {
			continue // parsed but never drawn with: embedding it would bloat the file
		}
		bodies, res := e.fontObjects(next)
		embResource[e] = res
		embObjs = append(embObjs, bodies...)
		next += len(bodies)
	}
	pageObjNo := make([]int, len(pages))
	imageObjNo := make([][]int, len(pages))
	formObjNo := make([][]int, len(pages))
	for i, p := range pages {
		pageObjNo[i] = next
		next += 2 // page, contents
		imageObjNo[i] = make([]int, len(p.images))
		for j, im := range p.images {
			imageObjNo[i][j] = next
			next++
			if im.alpha != nil {
				next++ // its soft mask
			}
		}
		// Transparency groups follow this page's images, so the bodies appended
		// after them below land on exactly these numbers.
		formObjNo[i] = make([]int, len(p.forms))
		for k := range p.forms {
			formObjNo[i][k] = next
			next++
		}
	}
	pageObj := func(i int) int { return pageObjNo[i] }
	structRoot := next
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
		imageObjs                                 [][]string
		nums                                      []string
		leafNo                                    = firstLeaf
		kidRefs                                   strings.Builder
	)
	for i, p := range pages {
		var xobjDict strings.Builder
		var bodies []string
		for j, im := range p.images {
			b, res := im.xobjects(imageObjNo[i][j])
			bodies = append(bodies, b...)
			xobjDict.WriteString(res)
		}
		for k := range p.forms {
			xobjDict.WriteString(fmt.Sprintf("/%s %d 0 R ", formResourceRef(k), formObjNo[i][k]))
		}
		imageObjs = append(imageObjs, bodies)
		xobjects := ""
		if xobjDict.Len() > 0 {
			xobjects = fmt.Sprintf(" /XObject << %s>>", xobjDict.String())
		}
		// Graphics states are tiny dictionaries, written inline in the
		// resource dictionary rather than as separate objects.
		gstates := ""
		if len(p.gstates) > 0 {
			var gd strings.Builder
			for gi, g := range p.gstates {
				gd.WriteString(fmt.Sprintf("/GS%d << /Type /ExtGState /ca %s /CA %s", gi, pn(g.ca), pn(g.ca)))
				if g.bm != "" {
					gd.WriteString(" /BM /" + g.bm)
				}
				gd.WriteString(" >> ")
			}
			gstates = fmt.Sprintf(" /ExtGState << %s>>", gd.String())
		}
		// Gradient shadings, inline like the graphics states.
		shadings := ""
		if len(p.shadings) > 0 {
			var sd strings.Builder
			for si, s := range p.shadings {
				sd.WriteString(fmt.Sprintf("/Sh%d %s ", si, s))
			}
			shadings = fmt.Sprintf(" /Shading << %s>>", sd.String())
		}

		// The page's font dictionary is the base-14 set plus whatever design
		// fonts this page actually drew with.
		pageFontDict := fontDict.String()
		for _, e := range p.fonts {
			pageFontDict += embResource[e]
		}
		// One resource dictionary, shared verbatim by the page and by every
		// transparency group on it. A form's content is emitted during the same
		// pass that registers the fonts, images, and graphics states it uses,
		// so the assembled dictionary already covers all of them. Sharing it
		// also means a nested group finds the outer form listed, which is what
		// lets groups nest.
		resources := fmt.Sprintf("<< /Font << %s>>%s%s%s >>", pageFontDict, xobjects, gstates, shadings)
		for k, f := range p.forms {
			_ = k
			imageObjs[i] = append(imageObjs[i], f.object(resources))
		}
		pageObjs = append(pageObjs, fmt.Sprintf(
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %s %s] /Resources %s /Contents %d 0 R /StructParents %d /Tabs /S >>",
			pn(p.w), pn(p.h), resources, pageObj(i)+1, i))
		contentObjs = append(contentObjs, fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(p.content)+1, p.content))

		// One structure element per tag, in reading order, each pointing at its
		// marked content by id. /Alt is what a screen reader announces.
		var kids strings.Builder
		pageNums := make([]string, len(p.tags))
		for _, t := range p.tags {
			alt := ""
			if t.alt != "" {
				alt = " /Alt " + pdfTextString(t.alt)
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
		// /Lang states the document's natural language, which PDF/UA requires. It was
		// hardcoded to en-US, so every exported PDF claimed to be American English
		// whatever it actually contained, and a screen reader pronounced it that way.
		fmt.Sprintf("<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> /StructTreeRoot %d 0 R /Lang (%s) /ViewerPreferences << /DisplayDocTitle true >> >>", structRoot, lang),
		fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", strings.TrimSpace(pageRefs.String()), len(pages)),
	}
	objs = append(objs, fontObjs...)
	objs = append(objs, embObjs...)
	for i := range pages {
		objs = append(objs, pageObjs[i], contentObjs[i])
		objs = append(objs, imageObjs[i]...)
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
