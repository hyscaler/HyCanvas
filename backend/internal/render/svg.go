// Package render ports the HyCanvas scene-graph export engine to Go (the
// rendering reimplementation that replaces @hc/engine + @hc/export on the
// server). The DesignFile is handled as opaque JSON (the open file format); the
// exporters walk pages/nodes and emit each output format. SVG (this file) is the
// editable, highest-fidelity vector output; PDF builds on the same path
// geometry; PNG/JPG rasterize; video renders frames + ffmpeg.
package render

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	"image/color"
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
	// alpha is the cumulative opacity of the ancestor chain. SVG `opacity`
	// on a group ISOLATES it (children composite first, then fade as one),
	// but the engine, the raster path, and the PDF all multiply opacity down
	// the subtree per node, so overlapping siblings in a translucent group
	// double-darken. To match them, containers never carry an opacity
	// attribute; the effective product lands on each leaf instead.
	alpha float64
}

type paint struct {
	ref     string
	opacity float64
}

// paintOf resolves a fill to an SVG paint (color or defs ref). w/h are the fill
// box dims in user units (shape size); when known (>0) an image fill uses a
// userSpaceOnUse pattern so cover/contain fit is exact for any aspect ratio.
func (c *svgCtx) paintOf(fill map[string]any, w, h float64) paint {
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
	case "image":
		href := asStr(fill["src"])
		if href == "" {
			return paint{ref: "none", opacity: 1}
		}
		c.gradID++
		id := "img-" + strconv.Itoa(c.gradID)
		// Fit -> SVG preserveAspectRatio: cover=slice, contain/none=meet, stretch=none.
		par := "xMidYMid slice"
		switch asStr(fill["fit"]) {
		case "contain", "none":
			par = "xMidYMid meet"
		case "stretch":
			par = "none"
		}
		if w > 0 && h > 0 {
			// userSpaceOnUse: the image is sized in real user units, so
			// preserveAspectRatio (cover/contain) is exact for any aspect ratio
			// (objectBoundingBox squashes fit on a non-square box).
			c.defs = append(c.defs, `<pattern id="`+id+`" patternUnits="userSpaceOnUse" width="`+num(w)+`" height="`+num(h)+`"><image href="`+esc(href)+`" x="0" y="0" width="`+num(w)+`" height="`+num(h)+`" preserveAspectRatio="`+par+`"/></pattern>`)
		} else {
			c.defs = append(c.defs, `<pattern id="`+id+`" patternUnits="objectBoundingBox" patternContentUnits="objectBoundingBox" width="1" height="1"><image href="`+esc(href)+`" x="0" y="0" width="1" height="1" preserveAspectRatio="`+par+`"/></pattern>`)
		}
		op := 1.0
		if o, ok := fill["opacity"].(float64); ok {
			op = o
		}
		return paint{ref: "url(#" + id + ")", opacity: op}
	case "pattern":
		href := asStr(fill["src"])
		if href == "" {
			return paint{ref: "none", opacity: 1}
		}
		iw, ih := dataURLDims(href)
		if iw <= 0 || ih <= 0 {
			iw, ih = 64, 64
		}
		scale := asNum(fill["scale"])
		if scale <= 0 {
			scale = 1
		}
		tw, th := float64(iw)*scale, float64(ih)*scale
		c.gradID++
		id := "pat-" + strconv.Itoa(c.gradID)
		ptf := ""
		if rot := asNum(fill["rotation"]); rot != 0 {
			ptf = ` patternTransform="rotate(` + num(rot) + `)"`
		}
		c.defs = append(c.defs, `<pattern id="`+id+`" patternUnits="userSpaceOnUse" width="`+num(tw)+`" height="`+num(th)+`"`+ptf+`><image href="`+esc(href)+`" x="0" y="0" width="`+num(tw)+`" height="`+num(th)+`" preserveAspectRatio="none"/></pattern>`)
		return paint{ref: "url(#" + id + ")", opacity: 1}
	}
	return paint{ref: "none", opacity: 1}
}

// dataURLDims decodes a "data:...;base64,..." image's pixel dimensions cheaply
// (header only), for sizing a tiled SVG pattern. Returns 0,0 when undecodable.
func dataURLDims(u string) (int, int) {
	i := strings.Index(u, ",")
	if i < 0 || !strings.HasPrefix(u, "data:") {
		return 0, 0
	}
	raw, err := base64.StdEncoding.DecodeString(u[i+1:])
	if err != nil {
		return 0, 0
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		return 0, 0
	}
	return cfg.Width, cfg.Height
}

// fillAttrs emits the SVG fill attribute for the first fill. w/h are the fill
// box dims (shape size) so an image fill's cover/contain fit is exact; pass 0,0
// when the box is unknown or the fill is solid/gradient.
func (c *svgCtx) fillAttrs(fills []any, w, h float64) string {
	var first map[string]any
	if len(fills) > 0 {
		first = asObj(fills[0])
	}
	p := c.paintOf(first, w, h)
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
	p := c.paintOf(asObj(stroke["fill"]), 0, 0)
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
	pnt := c.fillAttrs(asArr(node["fills"]), w, h) + c.strokeAttrs(asObj(node["stroke"]))
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
	pnt := c.fillAttrs(asArr(node["fills"]), 0, 0) + c.strokeAttrs(asObj(node["stroke"]))
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
	w, _ := sizeOf(node)
	var out strings.Builder
	y := 0.0
	for _, para := range asArr(node["content"]) {
		po := asObj(para)
		pstyle := asObj(po["style"])
		lineHeight := 0.0
		var tspans strings.Builder
		var paraText strings.Builder
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
			p := c.paintOf(asObj(style["fill"]), 0, 0)
			fo := ""
			if p.opacity < 1 {
				fo = ` fill-opacity="` + num(p.opacity) + `"`
			}
			paraText.WriteString(asStr(ro["text"]))
			tspans.WriteString(`<tspan font-family="` + esc(family) + `" font-size="` + num(size) + `" fill="` + p.ref + `"` + fo + `>` + esc(asStr(ro["text"])) + `</tspan>`)
		}
		if lineHeight == 0 {
			lineHeight = 16 * 1.2
		}
		y += lineHeight
		// Base direction and alignment, mirroring the raster layout: the SVG
		// carries LOGICAL text and the consumer runs its own bidi, so an RTL
		// paragraph must SAY it is RTL (an LTR-base renderer would put
		// trailing punctuation on the wrong side) and, when the author never
		// chose an alignment, reads from the right like the canvas shows it.
		dir := ResolveBaseDirection(paraText.String(), asStr(pstyle["direction"]))
		align := asStr(pstyle["align"])
		if dir == "rtl" && align == "" {
			align = "right"
		}
		// text-anchor is DIRECTION-RELATIVE in SVG: under direction="rtl",
		// "start" is the line's RIGHT edge, so a right-aligned RTL paragraph
		// anchors its start at x=w (anchor "end" there would hang the whole
		// line off the box's right side).
		x, anchor := 0.0, ""
		switch {
		case align == "center":
			x, anchor = w/2, ` text-anchor="middle"`
		case align == "right" && dir == "rtl":
			x, anchor = w, ` text-anchor="start"`
		case align == "right":
			x, anchor = w, ` text-anchor="end"`
		case dir == "rtl": // explicit left alignment of an RTL paragraph
			x, anchor = 0, ` text-anchor="end"`
		}
		dirAttr := ""
		if dir == "rtl" {
			dirAttr = ` direction="rtl" unicode-bidi="embed"`
		}
		out.WriteString(`<text x="` + num(x) + `" y="` + num(y) + `"` + anchor + dirAttr + `>` + tspans.String() + `</text>`)
	}
	return out.String()
}

func imageBody(file Design, node map[string]any) string {
	w, h := sizeOf(node)
	// Prefer an inlined data URL (set by the export handler's asset embedding);
	// otherwise fall back to a url carried in the file's asset manifest.
	href := asStr(node["src"])
	if href == "" {
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
	}
	return `<image x="0" y="0" width="` + num(w) + `" height="` + num(h) + `" preserveAspectRatio="none" href="` + esc(href) + `"/>`
}

// qrBody emits a QR node as its background, module rects (one path), and an
// optional center logo (bytes inlined by the export handler as node["logoSrc"]).
func (c *svgCtx) qrBody(node map[string]any) string {
	w, h := sizeOf(node)
	rows := asArr(node["modules"])
	n := len(rows)
	if n == 0 {
		return `<rect x="0" y="0" width="` + num(w) + `" height="` + num(h) + `" fill="rgb(244,244,245)" stroke="rgb(212,212,216)"/>`
	}
	quiet := 4.0
	total := float64(n) + quiet*2
	cell := math.Min(w, h) / total
	ox := (w-cell*total)/2 + quiet*cell
	oy := (h-cell*total)/2 + quiet*cell
	bg := "rgb(255,255,255)"
	if col := asObj(node["background"]); col != nil {
		bg = rgbOf(col)
	}
	fg := "rgb(0,0,0)"
	if col := asObj(node["foreground"]); col != nil {
		fg = rgbOf(col)
	}
	var b strings.Builder
	b.WriteString(`<rect x="0" y="0" width="` + num(w) + `" height="` + num(h) + `" fill="` + bg + `"/>`)
	var d strings.Builder
	for r := 0; r < n; r++ {
		cols := asArr(rows[r])
		for cc := 0; cc < len(cols); cc++ {
			if !asBool(cols[cc]) {
				continue
			}
			x := ox + float64(cc)*cell
			y := oy + float64(r)*cell
			d.WriteString("M" + num(x) + " " + num(y) + "h" + num(cell) + "v" + num(cell) + "h" + num(-cell) + "z")
		}
	}
	b.WriteString(`<path d="` + d.String() + `" fill="` + fg + `"/>`)
	if logo := asStr(node["logoSrc"]); logo != "" {
		// Match rasterQR / browser drawQr: default 0.22 when unset, else clamp.
		scale := 0.22
		if _, ok := node["logoScale"]; ok {
			scale = math.Max(0.08, math.Min(0.4, asNum(node["logoScale"])))
		}
		box := math.Min(w, h) * scale
		pad := box * 0.16
		lx := (w - box) / 2
		ly := (h - box) / 2
		b.WriteString(`<rect x="` + num(lx-pad) + `" y="` + num(ly-pad) + `" width="` + num(box+pad*2) + `" height="` + num(box+pad*2) + `" fill="` + bg + `"/>`)
		b.WriteString(`<image href="` + esc(logo) + `" x="` + num(lx) + `" y="` + num(ly) + `" width="` + num(box) + `" height="` + num(box) + `" preserveAspectRatio="none"/>`)
	}
	return b.String()
}

// stampBody emits a stamp node as its glyph in an emoji font stack, so a browser
// viewing the SVG renders the actual (color) emoji.
func (c *svgCtx) stampBody(node map[string]any) string {
	w, h := sizeOf(node)
	glyph := asStr(node["glyph"])
	if glyph == "" {
		glyph = "\U0001F44D"
	}
	fs := math.Max(4, math.Min(w, h)*0.82)
	return `<text x="` + num(w/2) + `" y="` + num(h/2) + `" font-size="` + num(fs) + `" text-anchor="middle" dominant-baseline="central" font-family="` + esc(`"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",system-ui,sans-serif`) + `">` + esc(glyph) + `</text>`
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
	fillP := c.paintOf(asObj(node["fill"]), 0, 0)
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
	kind := asStr(node["type"])
	container := kind == "group" || kind == "frame" || kind == "grid"
	// Opacity multiplies down the ancestor chain (see the svgCtx.alpha note):
	// a container's opacity is carried to its leaves rather than emitted on
	// the <g>, which would ISOLATE the group and stop overlapping children
	// from double-darkening the way every other render path does.
	parentAlpha := c.alpha
	eff := parentAlpha
	if op, ok := node["opacity"].(float64); ok && op >= 0 && op < 1 {
		eff = parentAlpha * op
	}
	open := `<g data-oc-id="` + esc(asStr(node["id"])) + `" transform="` + tfm + `"`
	if !container && eff < 1 {
		open += ` opacity="` + num(eff) + `"`
	}
	// Blend and opacity ride on this OUTER wrapper; the effect filter wraps
	// the body on an inner group so the outline (stroked after the filter,
	// like the raster path) is not part of the shadow-casting silhouette.
	open += c.blendAttr(node)
	open += ">"
	if container {
		c.alpha = eff
		defer func() { c.alpha = parentAlpha }()
	}

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
	case "qr":
		body = c.qrBody(node)
	case "stamp":
		body = c.stampBody(node)
	case "group", "frame", "grid":
		var sb strings.Builder
		for _, ch := range childrenOf(node) {
			sb.WriteString(c.emitNode(file, asObj(ch)))
		}
		body = sb.String()
	default:
		body = "<!-- unsupported node type for svg: " + esc(asStr(node["type"])) + " -->"
	}
	if filter := c.effectFilterAttr(node); filter != "" {
		body = "<g" + filter + ">" + body + "</g>"
	}
	return open + body + outlineRects(node) + "</g>"
}

// ToSVG serializes one page of a design to an editable SVG document.
func ToSVG(file Design, pageIndex int) (string, error) {
	pages := asArr(file["pages"])
	if pageIndex < 0 || pageIndex >= len(pages) {
		return "", ErrPageRange
	}
	page := asObj(pages[pageIndex])
	w, h := asNum(page["width"]), asNum(page["height"])
	c := &svgCtx{boxes: pageBoxMap(page), alpha: 1}

	bg := ""
	if bgFill := asObj(page["background"]); bgFill != nil {
		if k := asStr(bgFill["type"]); k != "pattern" && k != "image" {
			bg = `<rect x="0" y="0" width="` + num(w) + `" height="` + num(h) + `"` + c.fillAttrs([]any{bgFill}, 0, 0) + `/>`
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

// ---------------------------------------------------------------------------
// Effects (F38 parity work): the raster path composites blend modes, shadows,
// glows and blurs; this gives the SVG export the same visuals through native
// SVG features instead of silently dropping them.
// ---------------------------------------------------------------------------

// blendAttr returns the mix-blend-mode style attribute for a node's OUTER
// wrapper (the filter lives on an inner group so an outline can sit between
// the filtered artwork and the blend, exactly like the raster layer order).
func (c *svgCtx) blendAttr(node map[string]any) string {
	if m := blendModeOf(node); m != "" {
		return ` style="mix-blend-mode:` + esc(m) + `"`
	}
	return ""
}

// outlineRects strokes the node's local box over its own content, mirroring
// outlineBox on the raster path: drawn AFTER the filter so it does not
// thicken the silhouette the node's own shadow is cast from, and inside the
// outer group so it participates in the node's opacity and blend.
func outlineRects(node map[string]any) string {
	if asStr(node["type"]) == "text" {
		return ""
	}
	w, h := sizeOf(node)
	if w <= 0 || h <= 0 {
		return ""
	}
	out := ""
	for _, e := range effectsOf(node) {
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
		rgba := rasterColor(col, 1)
		out += fmt.Sprintf(`<rect x="0" y="0" width="%s" height="%s" fill="none" stroke="rgb(%d,%d,%d)" stroke-opacity="%s" stroke-width="%s"/>`,
			num(w), num(h), rgba.R, rgba.G, rgba.B, num(ca), num(width))
	}
	return out
}

// effectFilterAttr returns a filter reference for a node that carries
// adjustments, a duotone, a layer blur, shadows, or a glow; the filter itself
// is appended to defs. "" when the node has none of them.
//
// The primitive chain mirrors the raster path's layer pass: effects apply in
// DECLARED order (adjustment matrices compose until a blur forces a flush;
// duotone maps luminance onto the shadows/highlights ramp and mixes by
// intensity), and the shadow/glow silhouettes are taken from the PROCESSED
// artwork, so a blurred node casts a blurred shadow. Shadows and glows use
// the same blur-radius-is-2x-stdDeviation convention as CSS drop-shadow.
// color-interpolation-filters is pinned to sRGB because both the browser's
// CSS filters and the raster path work in sRGB, while SVG filters default to
// linearRGB.
func (c *svgCtx) effectFilterAttr(node map[string]any) string {
	effects := effectsOf(node)
	shadows := shadowsOf(node)
	var glow map[string]any
	hasChain := false
	maxBlur := 0.0
	for _, e := range effects {
		switch e.kind {
		case "glow":
			if glow == nil {
				glow = e.raw
			}
		case "blur":
			if r := asNum(e.raw["radius"]); r > 0 {
				hasChain = true
				if r > maxBlur {
					maxBlur = r
				}
			}
		case "adjustment":
			for _, o := range asArr(e.raw["ops"]) {
				oo := asObj(o)
				if oo == nil {
					continue
				}
				if _, blurPx, known := adjustmentMatrix(asStr(oo["name"]), asNum(oo["value"])); known {
					hasChain = true
					if blurPx > maxBlur {
						maxBlur = blurPx
					}
				}
			}
		case "duotone":
			hasChain = true
		}
	}
	if len(shadows) == 0 && glow == nil && !hasChain {
		return ""
	}
	blurRadius := maxBlur

	var f strings.Builder
	id := fmt.Sprintf("fx%d", len(c.defs))
	// Filter region in user-space units, not objectBoundingBox percentages: a
	// zero-area box (a horizontal line) collapses a percentage region and SVG
	// then disables the element entirely, and a fixed percentage clips any
	// shadow reaching past it. Cover the node's local bounds plus the
	// furthest effect extent (offset + 3 sigma of the blur).
	x0, y0 := 0.0, 0.0
	w, h := sizeOf(node)
	if asStr(node["type"]) == "connector" {
		// Connectors draw from connectorPoints in absolute page space under an
		// identity transform, so their bounds come from the points themselves.
		if pts := connectorPoints(node, c.boxes); len(pts) > 0 {
			minX, minY, maxX, maxY := pts[0][0], pts[0][1], pts[0][0], pts[0][1]
			for _, p := range pts[1:] {
				minX, minY = math.Min(minX, p[0]), math.Min(minY, p[1])
				maxX, maxY = math.Max(maxX, p[0]), math.Max(maxY, p[1])
			}
			x0, y0, w, h = minX, minY, maxX-minX, maxY-minY
		}
	}
	margin := 4.0
	for _, sh := range shadows {
		if m := math.Max(math.Abs(sh.dx), math.Abs(sh.dy)) + 1.5*sh.blur + 4; m > margin {
			margin = m
		}
	}
	if glow != nil {
		if m := 1.5*asNum(glow["radius"]) + 4; m > margin {
			margin = m
		}
	}
	// A layer blur's radius is its sigma, so 3 sigma of reach = 3x radius.
	if m := 3*blurRadius + 4; blurRadius > 0 && m > margin {
		margin = m
	}
	if w <= 0 && h <= 0 && len(childrenOf(node)) > 0 {
		// A sizeless container (a group carries no box of its own): its
		// children's extent is unknown here, so keep a generous relative
		// region rather than clipping to a point.
		f.WriteString(`<filter id="` + id + `" color-interpolation-filters="sRGB" x="-60%" y="-60%" width="220%" height="220%">`)
	} else {
		f.WriteString(fmt.Sprintf(`<filter id="%s" color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" x="%s" y="%s" width="%s" height="%s">`,
			id, num(x0-margin), num(y0-margin), num(w+2*margin), num(h+2*margin)))
	}

	// --- the processing chain, in declared effect order ---------------------
	// `cur` names the running result ("" = the unprocessed SourceGraphic).
	cur := ""
	in := func() string {
		if cur == "" {
			return "SourceGraphic"
		}
		return cur
	}
	step := 0
	emitMatrix := func(m colorMatrix) {
		if m == identityMatrix() {
			return
		}
		vals := make([]string, 0, 20)
		for _, v := range m {
			vals = append(vals, num(v))
		}
		res := fmt.Sprintf("p%d", step)
		step++
		f.WriteString(fmt.Sprintf(`<feColorMatrix in="%s" type="matrix" values="%s" result="%s"/>`, in(), strings.Join(vals, " "), res))
		cur = res
	}
	// A layer/adjustment blur's radius IS its standard deviation (CSS
	// blur(r) and the raster's blurLayer both treat it as sigma); only
	// drop-shadow/glow use the blur-is-2x-sigma convention, handled by
	// emitSilhouette below.
	emitBlur := func(r float64) {
		if r <= 0 {
			return
		}
		res := fmt.Sprintf("p%d", step)
		step++
		f.WriteString(fmt.Sprintf(`<feGaussianBlur in="%s" stdDeviation="%s" result="%s"/>`, in(), num(r), res))
		cur = res
	}
	for _, e := range effects {
		switch e.kind {
		case "adjustment":
			// Compose sliders into one matrix; an embedded blur op flushes
			// the pending matrix first, exactly like the raster pass.
			pending := identityMatrix()
			for _, o := range asArr(e.raw["ops"]) {
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
					emitMatrix(pending)
					pending = identityMatrix()
					emitBlur(blurPx)
				}
			}
			emitMatrix(pending)
		case "blur":
			emitBlur(asNum(e.raw["radius"]))
		case "duotone":
			k := 1.0
			if v, ok := e.raw["intensity"].(float64); ok {
				k = clamp01f(v)
			}
			if k == 0 {
				continue
			}
			sc, _ := shadowColor(asObj(e.raw["shadows"]))
			hc, _ := shadowColor(asObj(e.raw["highlights"]))
			orig := in()
			// Rec.601 luminance into every channel, then a 2-entry transfer
			// table interpolates each channel along the shadows->highlights
			// ramp: exactly the raster LUT.
			const lum = "0.299 0.587 0.114 0 0"
			gray := fmt.Sprintf("p%d", step)
			step++
			f.WriteString(fmt.Sprintf(`<feColorMatrix in="%s" type="matrix" values="%s %s %s 0 0 0 1 0" result="%s"/>`, orig, lum, lum, lum, gray))
			mapped := fmt.Sprintf("p%d", step)
			step++
			f.WriteString(fmt.Sprintf(`<feComponentTransfer in="%s" result="%s"><feFuncR type="table" tableValues="%s %s"/><feFuncG type="table" tableValues="%s %s"/><feFuncB type="table" tableValues="%s %s"/></feComponentTransfer>`,
				gray, mapped, num(sc.r), num(hc.r), num(sc.g), num(hc.g), num(sc.b), num(hc.b)))
			if k >= 1 {
				cur = mapped
			} else {
				res := fmt.Sprintf("p%d", step)
				step++
				f.WriteString(fmt.Sprintf(`<feComposite in="%s" in2="%s" operator="arithmetic" k1="0" k2="%s" k3="%s" k4="0" result="%s"/>`,
					mapped, orig, num(k), num(1-k), res))
				cur = res
			}
		}
	}
	src := in()

	// Silhouette-based primitives (shadow, glow), taken from the PROCESSED
	// artwork's alpha, tinted, and merged BENEATH it: the raster painting
	// order, where a blurred node casts a blurred shadow.
	var merges []string
	emitSilhouette := func(i int, dx, dy, blur float64, col color.RGBA, opacity float64) {
		res := fmt.Sprintf("s%d", i)
		f.WriteString(fmt.Sprintf(`<feGaussianBlur in="%s" stdDeviation="%s" result="%s_b"/>`, src, num(blur/2), res))
		f.WriteString(fmt.Sprintf(`<feOffset in="%s_b" dx="%s" dy="%s" result="%s_o"/>`, res, num(dx), num(dy), res))
		f.WriteString(fmt.Sprintf(`<feFlood flood-color="rgb(%d,%d,%d)" flood-opacity="%s"/>`, col.R, col.G, col.B, num(opacity)))
		f.WriteString(fmt.Sprintf(`<feComposite in2="%s_o" operator="in" result="%s"/>`, res, res))
		merges = append(merges, res)
	}
	i := 0
	if glow != nil {
		radius := asNum(glow["radius"])
		col, ca := shadowColor(asObj(glow["color"]))
		intensity := 1.0
		if v, ok := glow["intensity"].(float64); ok {
			intensity = v
		}
		if radius > 0 && ca*intensity > 0 {
			emitSilhouette(i, 0, 0, radius, rasterColor(col, 1), clamp01f(ca*intensity))
			i++
		}
	}
	for _, sh := range shadows {
		emitSilhouette(i, sh.dx, sh.dy, sh.blur, sh.col, sh.opacity)
		i++
	}

	if len(merges) > 0 {
		f.WriteString(`<feMerge>`)
		for _, m := range merges {
			f.WriteString(`<feMergeNode in="` + m + `"/>`)
		}
		f.WriteString(`<feMergeNode in="` + src + `"/></feMerge>`)
	}
	f.WriteString(`</filter>`)

	// Every op reduced to identity and nothing casts: a filter with zero
	// primitives renders its element TRANSPARENT, so emit no filter at all.
	if step == 0 && len(merges) == 0 {
		return ""
	}

	c.defs = append(c.defs, f.String())
	return ` filter="url(#` + id + `)"`
}
