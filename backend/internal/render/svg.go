// Package render ports the HyCanvas scene-graph export engine to Go (the
// rendering reimplementation that replaces @hc/engine + @hc/export on the
// server). The DesignFile is handled as opaque JSON (the open file format); the
// exporters walk pages/nodes and emit each output format. SVG (this file) is the
// editable, highest-fidelity vector output; PDF builds on the same path
// geometry; PNG/JPG rasterize; video renders frames + ffmpeg.
package render

import (
	"math"
	"sort"
	"strconv"
	"strings"
)

// Design is the open file format, handled opaquely (a decoded DesignFile JSON).
type Design = map[string]any

// --- small typed accessors over the JSON node maps -----------------------

func asObj(v any) map[string]any { m, _ := v.(map[string]any); return m }
func asArr(v any) []any          { a, _ := v.([]any); return a }
func asStr(v any) string         { s, _ := v.(string); return s }
func asNum(v any) float64        { f, _ := v.(float64); return f }
func asBool(v any) bool          { b, _ := v.(bool); return b }

func num(n float64) string {
	if math.IsNaN(n) || math.IsInf(n, 0) {
		return "0"
	}
	return strconv.FormatFloat(math.Round(n*1000)/1000, 'f', -1, 64)
}

func esc(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")
	return r.Replace(s)
}

func rgbOf(color map[string]any) string {
	srgb := asObj(color["srgb"])
	r := math.Round(asNum(srgb["r"]) * 255)
	g := math.Round(asNum(srgb["g"]) * 255)
	b := math.Round(asNum(srgb["b"]) * 255)
	return "rgb(" + num(r) + "," + num(g) + "," + num(b) + ")"
}

func alphaOf(color map[string]any) float64 {
	srgb := asObj(color["srgb"])
	if a, ok := srgb["a"].(float64); ok {
		return a
	}
	return 1
}

type svgCtx struct {
	defs   []string
	gradID int
	boxes  map[string]rbox // page node world-boxes, for connector endpoint routing
}

type paint struct {
	ref     string
	opacity float64
}

func (c *svgCtx) paintOf(fill map[string]any) paint {
	if fill == nil {
		return paint{ref: "none", opacity: 1}
	}
	switch asStr(fill["type"]) {
	case "solid":
		col := asObj(fill["color"])
		return paint{ref: rgbOf(col), opacity: alphaOf(col)}
	case "gradient":
		c.gradID++
		id := "grad-" + strconv.Itoa(c.gradID)
		var stops strings.Builder
		for _, s := range asArr(fill["stops"]) {
			so := asObj(s)
			col := asObj(so["color"])
			stops.WriteString(`<stop offset="` + num(asNum(so["position"])) + `" stop-color="` + rgbOf(col) + `" stop-opacity="` + num(alphaOf(col)) + `"/>`)
		}
		if asStr(fill["gradient"]) == "radial" {
			cx, cy, r := 0.5, 0.5, 0.5
			if center := asObj(fill["center"]); center != nil {
				cx, cy = asNum(center["x"]), asNum(center["y"])
			}
			if rad, ok := fill["radius"].(float64); ok {
				r = rad
			}
			c.defs = append(c.defs, `<radialGradient id="`+id+`" cx="`+num(cx)+`" cy="`+num(cy)+`" r="`+num(r)+`">`+stops.String()+`</radialGradient>`)
		} else {
			rad := asNum(fill["angle"]) * math.Pi / 180
			dx, dy := math.Cos(rad)*0.5, math.Sin(rad)*0.5
			c.defs = append(c.defs, `<linearGradient id="`+id+`" x1="`+num(0.5-dx)+`" y1="`+num(0.5-dy)+`" x2="`+num(0.5+dx)+`" y2="`+num(0.5+dy)+`">`+stops.String()+`</linearGradient>`)
		}
		return paint{ref: "url(#" + id + ")", opacity: 1}
	}
	return paint{ref: "none", opacity: 1}
}

func (c *svgCtx) fillAttrs(fills []any) string {
	var first map[string]any
	if len(fills) > 0 {
		first = asObj(fills[0])
	}
	p := c.paintOf(first)
	out := ` fill="` + p.ref + `"`
	if p.opacity < 1 {
		out += ` fill-opacity="` + num(p.opacity) + `"`
	}
	return out
}

func (c *svgCtx) strokeAttrs(stroke map[string]any) string {
	if stroke == nil {
		return ""
	}
	p := c.paintOf(asObj(stroke["fill"]))
	out := ` stroke="` + p.ref + `" stroke-width="` + num(asNum(stroke["width"])) + `"`
	if p.opacity < 1 {
		out += ` stroke-opacity="` + num(p.opacity) + `"`
	}
	if cap := asStr(stroke["cap"]); cap != "" {
		out += ` stroke-linecap="` + esc(cap) + `"`
	}
	if join := asStr(stroke["join"]); join != "" {
		out += ` stroke-linejoin="` + esc(join) + `"`
	}
	if dash := asArr(stroke["dash"]); len(dash) > 0 {
		parts := make([]string, len(dash))
		for i, d := range dash {
			parts[i] = num(asNum(d))
		}
		out += ` stroke-dasharray="` + strings.Join(parts, ",") + `"`
	}
	return out
}

// matrixAttr ports fromTransform (R*K*S then translate) to an SVG matrix(...).
func matrixAttr(node map[string]any) string {
	t := asObj(node["transform"])
	if t == nil {
		return "matrix(1,0,0,1,0,0)"
	}
	sx, sy := asNum(t["scaleX"]), asNum(t["scaleY"])
	if sx == 0 && t["scaleX"] == nil {
		sx = 1
	}
	if sy == 0 && t["scaleY"] == nil {
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
	a := cos*ksa - sin*ksb
	b := sin*ksa + cos*ksb
	cc := cos*ksc - sin*ksd
	d := sin*ksc + cos*ksd
	return "matrix(" + num(a) + "," + num(b) + "," + num(cc) + "," + num(d) + "," + num(asNum(t["x"])) + "," + num(asNum(t["y"])) + ")"
}

func sizeOf(node map[string]any) (float64, float64) {
	sz := asObj(node["size"])
	return asNum(sz["width"]), asNum(sz["height"])
}

// regularPolygonD / starPath ports (parametric paths centered in the box).
func regularPolygonD(w, h float64, sides int) string {
	n := sides
	if n < 3 {
		n = 3
	}
	cx, cy := w/2, h/2
	var d strings.Builder
	for i := 0; i < n; i++ {
		a := -math.Pi/2 + float64(i)*2*math.Pi/float64(n)
		x, y := cx+math.Cos(a)*(w/2), cy+math.Sin(a)*(h/2)
		if i == 0 {
			d.WriteString("M " + num(x) + " " + num(y))
		} else {
			d.WriteString(" L " + num(x) + " " + num(y))
		}
	}
	d.WriteString(" Z")
	return d.String()
}

func starD(w, h float64, points int, innerRatio float64) string {
	n := points
	if n < 3 {
		n = 3
	}
	inner := math.Max(0.05, math.Min(1, innerRatio))
	cx, cy := w/2, h/2
	var d strings.Builder
	for i := 0; i < n*2; i++ {
		a := -math.Pi/2 + float64(i)*math.Pi/float64(n)
		r := 1.0
		if i%2 != 0 {
			r = inner
		}
		x, y := cx+math.Cos(a)*(w/2)*r, cy+math.Sin(a)*(h/2)*r
		if i == 0 {
			d.WriteString("M " + num(x) + " " + num(y))
		} else {
			d.WriteString(" L " + num(x) + " " + num(y))
		}
	}
	d.WriteString(" Z")
	return d.String()
}

func (c *svgCtx) shapeBody(node map[string]any) string {
	w, h := sizeOf(node)
	pnt := c.fillAttrs(asArr(node["fills"])) + c.strokeAttrs(asObj(node["stroke"]))
	switch asStr(node["shape"]) {
	case "rect":
		rx := ""
		if cr := asObj(node["cornerRadius"]); cr != nil {
			if r := math.Max(0, asNum(cr["topLeft"])); r > 0 {
				rx = ` rx="` + num(r) + `"`
			}
		}
		return `<rect x="0" y="0" width="` + num(w) + `" height="` + num(h) + `"` + rx + pnt + `/>`
	case "ellipse":
		return `<ellipse cx="` + num(w/2) + `" cy="` + num(h/2) + `" rx="` + num(w/2) + `" ry="` + num(h/2) + `"` + pnt + `/>`
	case "custom":
		if pd := asStr(node["pathData"]); pd != "" {
			return `<path d="` + esc(pd) + `"` + pnt + `/>`
		}
	case "polygon":
		sides := int(asNum(node["sides"]))
		if sides == 0 {
			sides = 3
		}
		return `<path d="` + regularPolygonD(w, h, sides) + `"` + pnt + `/>`
	case "triangle":
		return `<path d="` + regularPolygonD(w, h, 3) + `"` + pnt + `/>`
	case "star":
		pts := int(asNum(node["sides"]))
		if pts == 0 {
			pts = 5
		}
		ir := asNum(node["innerRadius"])
		if ir == 0 {
			ir = 0.5
		}
		return `<path d="` + starD(w, h, pts, ir) + `"` + pnt + `/>`
	}
	return ""
}

// contourD appends one subpath's path-data commands to d.
func contourD(d *strings.Builder, segs []any, closed bool) {
	first := asObj(segs[0])
	if d.Len() > 0 {
		d.WriteString(" ")
	}
	d.WriteString("M " + num(asNum(first["x"])) + " " + num(asNum(first["y"])))
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
			d.WriteString(" C " + num(c1x) + " " + num(c1y) + " " + num(c2x) + " " + num(c2y) + " " + num(asNum(to["x"])) + " " + num(asNum(to["y"])))
		} else {
			d.WriteString(" L " + num(asNum(to["x"])) + " " + num(asNum(to["y"])))
		}
	}
	if closed {
		d.WriteString(" Z")
	}
}

func (c *svgCtx) pathBody(node map[string]any) string {
	segs := asArr(node["segments"])
	if len(segs) == 0 {
		return ""
	}
	var d strings.Builder
	contourD(&d, segs, asBool(node["closed"]))
	// Extra contours of a compound path (schema v15) join the same path data;
	// fill-rule="evenodd" makes interior contours cut holes.
	compound := false
	for _, ct := range asArr(node["contours"]) {
		co := asObj(ct)
		if cs := asArr(co["segments"]); len(cs) >= 2 {
			contourD(&d, cs, asBool(co["closed"]))
			compound = true
		}
	}
	rule := ""
	if compound {
		rule = ` fill-rule="evenodd"`
	}
	pnt := c.fillAttrs(asArr(node["fills"])) + c.strokeAttrs(asObj(node["stroke"]))
	return `<path d="` + d.String() + `"` + rule + pnt + `/>`
}

func (c *svgCtx) lineBody(node map[string]any) string {
	pts := asArr(node["points"])
	parts := make([]string, 0, len(pts))
	for _, p := range pts {
		po := asObj(p)
		parts = append(parts, num(asNum(po["x"]))+","+num(asNum(po["y"])))
	}
	return `<polyline points="` + strings.Join(parts, " ") + `" fill="none"` + c.strokeAttrs(asObj(node["stroke"])) + `/>`
}

func (c *svgCtx) textBody(node map[string]any) string {
	var out strings.Builder
	y := 0.0
	for _, para := range asArr(node["content"]) {
		po := asObj(para)
		lineHeight := 0.0
		var tspans strings.Builder
		for _, run := range asArr(po["runs"]) {
			ro := asObj(run)
			style := asObj(ro["style"])
			size := asNum(style["fontSize"])
			if size == 0 {
				size = 16
			}
			lineHeight = math.Max(lineHeight, size*1.2)
			family := "sans-serif"
			if f := asStr(style["fontFamily"]); f != "" {
				family = f
			}
			p := c.paintOf(asObj(style["fill"]))
			fo := ""
			if p.opacity < 1 {
				fo = ` fill-opacity="` + num(p.opacity) + `"`
			}
			tspans.WriteString(`<tspan font-family="` + esc(family) + `" font-size="` + num(size) + `" fill="` + p.ref + `"` + fo + `>` + esc(asStr(ro["text"])) + `</tspan>`)
		}
		if lineHeight == 0 {
			lineHeight = 16 * 1.2
		}
		y += lineHeight
		out.WriteString(`<text x="0" y="` + num(y) + `">` + tspans.String() + `</text>`)
	}
	return out.String()
}

func imageBody(file Design, node map[string]any) string {
	w, h := sizeOf(node)
	href := ""
	if src := asObj(node["source"]); src != nil {
		if assetID := asStr(src["assetId"]); assetID != "" {
			for _, a := range asArr(file["assets"]) {
				ao := asObj(a)
				if asStr(ao["id"]) == assetID {
					href = asStr(ao["url"])
					break
				}
			}
		}
	}
	return `<image x="0" y="0" width="` + num(w) + `" height="` + num(h) + `" preserveAspectRatio="none" href="` + esc(href) + `"/>`
}

// --- F30 board nodes --------------------------------------------------------

func (c *svgCtx) inkBody(node map[string]any) string {
	pts := inkPoints(node)
	if len(pts) == 0 {
		return ""
	}
	col, width, opacity, mode := inkBrush(node)
	style := ""
	if mode == "highlighter" {
		style = ` style="mix-blend-mode:multiply"`
	}
	if len(pts) == 1 {
		return `<circle cx="` + num(pts[0][0]) + `" cy="` + num(pts[0][1]) + `" r="` + num(width/2) + `" fill="` + pdfRGBString(col) + `" fill-opacity="` + num(opacity) + `"` + style + `/>`
	}
	parts := make([]string, len(pts))
	for i, p := range pts {
		parts[i] = num(p[0]) + "," + num(p[1])
	}
	return `<polyline points="` + strings.Join(parts, " ") + `" fill="none" stroke="` + pdfRGBString(col) + `" stroke-width="` + num(width) + `" stroke-opacity="` + num(opacity) + `" stroke-linecap="round" stroke-linejoin="round"` + style + `/>`
}

func (c *svgCtx) stickyBody(node map[string]any) string {
	w, h := sizeOf(node)
	var b strings.Builder
	fillP := c.paintOf(asObj(node["fill"]))
	fo := ""
	if fillP.opacity < 1 {
		fo = ` fill-opacity="` + num(fillP.opacity) + `"`
	}
	b.WriteString(`<rect x="0" y="0" width="` + num(w) + `" height="` + num(h) + `" rx="2" fill="` + fillP.ref + `"` + fo + `/>`)
	text := asStr(node["text"])
	if text != "" {
		fontPx := 20.0
		if fs := asNum(node["fontScale"]); fs > 0 {
			fontPx = 20 * fs
		}
		pad := 12.0
		fill := "rgb(0,0,0)"
		if tc := colorComponents(asObj(node["textColor"])); tc.ok {
			fill = pdfRGBString(tc)
		}
		family := "sans-serif"
		if f := asStr(node["fontFamily"]); f != "" {
			family = f
		}
		anchor, tx := "start", pad
		switch asStr(node["align"]) {
		case "center":
			anchor, tx = "middle", w/2
		case "right":
			anchor, tx = "end", w-pad
		}
		lineH := fontPx * 1.25
		lines := wrapStickyLines(text, w-pad*2, fontPx)
		y := math.Max(pad, (h-float64(len(lines))*lineH)/2) + fontPx
		for _, ln := range lines {
			if y > h {
				break
			}
			b.WriteString(`<text x="` + num(tx) + `" y="` + num(y) + `" font-family="` + esc(family) + `" font-size="` + num(fontPx) + `" fill="` + fill + `" text-anchor="` + anchor + `">` + esc(ln) + `</text>`)
			y += lineH
		}
	}
	return b.String()
}

func svgArrow(from, to [2]float64, width float64, col pdfColor) string {
	tri := arrowHead(from, to, width)
	if tri == nil {
		return ""
	}
	pts := num(tri[0][0]) + "," + num(tri[0][1]) + " " + num(tri[1][0]) + "," + num(tri[1][1]) + " " + num(tri[2][0]) + "," + num(tri[2][1])
	return `<polygon points="` + pts + `" fill="` + pdfRGBString(col) + `"/>`
}

func (c *svgCtx) connectorBody(node map[string]any) string {
	pts := connectorPoints(node, c.boxes)
	if len(pts) < 2 {
		return ""
	}
	col := connectorStrokeColor(node)
	width := connectorStrokeWidth(node)
	parts := make([]string, len(pts))
	for i, p := range pts {
		parts[i] = num(p[0]) + "," + num(p[1])
	}
	var b strings.Builder
	b.WriteString(`<polyline points="` + strings.Join(parts, " ") + `" fill="none" stroke="` + pdfRGBString(col) + `" stroke-width="` + num(width) + `" stroke-linecap="round" stroke-linejoin="round"/>`)
	if capIs(node, "endCap", "arrow") {
		b.WriteString(svgArrow(pts[len(pts)-2], pts[len(pts)-1], width, col))
	}
	if capIs(node, "startCap", "arrow") {
		b.WriteString(svgArrow(pts[1], pts[0], width, col))
	}
	if txt, pos := connectorLabel(node); txt != "" {
		at := pointAlong(pts, pos)
		tw := float64(len(txt)) * 12 * 0.55
		b.WriteString(`<rect x="` + num(at[0]-tw/2-5) + `" y="` + num(at[1]-9) + `" width="` + num(tw+10) + `" height="18" rx="4" fill="rgb(255,255,255)" fill-opacity="0.92"/>`)
		b.WriteString(`<text x="` + num(at[0]) + `" y="` + num(at[1]+4) + `" font-family="sans-serif" font-size="12" fill="rgb(51,65,85)" text-anchor="middle">` + esc(txt) + `</text>`)
	}
	return b.String()
}

func childrenOf(node map[string]any) []any { return asArr(node["children"]) }

func (c *svgCtx) emitNode(file Design, node map[string]any) string {
	if asBool(node["hidden"]) {
		return ""
	}
	// A connector's body is drawn from connectorPoints in absolute PAGE space, so
	// it must NOT be re-transformed by the node's own matrix (mirrors the engine,
	// which cancels the connector world transform). Use identity for connectors.
	tfm := matrixAttr(node)
	if asStr(node["type"]) == "connector" {
		tfm = "matrix(1,0,0,1,0,0)"
	}
	open := `<g data-oc-id="` + esc(asStr(node["id"])) + `" transform="` + tfm + `"`
	if op, ok := node["opacity"].(float64); ok && op < 1 {
		open += ` opacity="` + num(op) + `"`
	}
	open += ">"

	var body string
	switch asStr(node["type"]) {
	case "shape":
		body = c.shapeBody(node)
	case "path":
		body = c.pathBody(node)
	case "line":
		body = c.lineBody(node)
	case "text":
		body = c.textBody(node)
	case "image":
		body = imageBody(file, node)
	case "ink":
		body = c.inkBody(node)
	case "sticky":
		body = c.stickyBody(node)
	case "connector":
		body = c.connectorBody(node)
	case "group", "frame", "grid":
		var sb strings.Builder
		for _, ch := range childrenOf(node) {
			sb.WriteString(c.emitNode(file, asObj(ch)))
		}
		body = sb.String()
	default:
		body = "<!-- unsupported node type for svg: " + esc(asStr(node["type"])) + " -->"
	}
	return open + body + "</g>"
}

// ToSVG serializes one page of a design to an editable SVG document.
func ToSVG(file Design, pageIndex int) (string, error) {
	pages := asArr(file["pages"])
	if pageIndex < 0 || pageIndex >= len(pages) {
		return "", ErrPageRange
	}
	page := asObj(pages[pageIndex])
	w, h := asNum(page["width"]), asNum(page["height"])
	c := &svgCtx{boxes: pageBoxMap(page)}

	bg := ""
	if bgFill := asObj(page["background"]); bgFill != nil {
		if k := asStr(bgFill["type"]); k != "pattern" && k != "image" {
			bg = `<rect x="0" y="0" width="` + num(w) + `" height="` + num(h) + `"` + c.fillAttrs([]any{bgFill}) + `/>`
		}
	}
	var content strings.Builder
	for _, n := range asArr(page["children"]) {
		content.WriteString(c.emitNode(file, asObj(n)))
	}
	defs := ""
	if len(c.defs) > 0 {
		defs = "<defs>" + strings.Join(c.defs, "") + "</defs>"
	}
	return `<svg xmlns="http://www.w3.org/2000/svg" width="` + num(w) + `" height="` + num(h) + `" viewBox="0 0 ` + num(w) + ` ` + num(h) + `">` +
		defs + bg + content.String() + `</svg>`, nil
}

// pageCount + sorted node ids are small helpers reused by other exporters.
func pageCount(file Design) int { return len(asArr(file["pages"])) }

func sortedKeys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
