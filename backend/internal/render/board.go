// Shared geometry for exporting F30 whiteboard nodes (ink/sticky/connector) in
// the raster/svg/pdf renderers. Connector routing is a Go port of @hc/whiteboard
// routeConnector + the engine's drawConnector (scene.ts connectorPolyline),
// including user waypoints, so the exported connector matches what the editor
// draws. Connectors are assumed top-level with an identity transform (the board
// always produces them that way), so their routed page-space polyline is drawn
// directly inside the node's transform wrapper, exactly like the engine.
package render

import (
	"math"
	"strings"
)

type rbox struct{ x, y, w, h float64 }

// pageBoxMap computes each node's world AABB in PAGE coordinates (no output
// scale), keyed by id, walking nested children with composed transforms. Used to
// resolve connector endpoints that attach to another node's box.
func pageBoxMap(page map[string]any) map[string]rbox {
	boxes := map[string]rbox{}
	var walk func(parent mat, node map[string]any)
	walk = func(parent mat, node map[string]any) {
		world := parent.compose(nodeMat(node))
		w, h := sizeOf(node)
		// Match the engine's box map (render2d buildBoxMap / scene.ts boxMap): a
		// translate-anchored box with scaled size, rotation IGNORED, so the
		// connector auto-anchor resolves to the same side the editor picks.
		if id := asStr(node["id"]); id != "" {
			boxes[id] = rbox{world.e, world.f, w * math.Hypot(world.a, world.b), h * math.Hypot(world.c, world.d)}
		}
		for _, ch := range childrenOf(node) {
			walk(world, asObj(ch))
		}
	}
	for _, n := range asArr(page["children"]) {
		walk(matIdentity(), asObj(n))
	}
	return boxes
}

func boxCenter(b rbox) [2]float64 { return [2]float64{b.x + b.w/2, b.y + b.h/2} }

// anchorPoint ports @hc/whiteboard routing.anchorPoint / scene.ts connectorAnchor:
// the connection point on a box for an anchor ("auto" picks the side nearest the
// other endpoint).
func anchorPoint(b rbox, anchor string, toward *[2]float64) [2]float64 {
	cx, cy := b.x+b.w/2, b.y+b.h/2
	switch anchor {
	case "top":
		return [2]float64{cx, b.y}
	case "bottom":
		return [2]float64{cx, b.y + b.h}
	case "left":
		return [2]float64{b.x, cy}
	case "right":
		return [2]float64{b.x + b.w, cy}
	case "center":
		return [2]float64{cx, cy}
	default: // auto
		sides := [][2]float64{{cx, b.y}, {b.x + b.w, cy}, {cx, b.y + b.h}, {b.x, cy}}
		target := [2]float64{b.x + b.w, cy}
		if toward != nil {
			target = *toward
		}
		best, bestD := sides[0], math.Inf(1)
		for _, s := range sides {
			d := (s[0]-target[0])*(s[0]-target[0]) + (s[1]-target[1])*(s[1]-target[1])
			if d < bestD {
				bestD, best = d, s
			}
		}
		return best
	}
}

func connectorEndRef(ep map[string]any, boxes map[string]rbox) *[2]float64 {
	if ep == nil {
		return nil
	}
	if att := asObj(ep["attach"]); att != nil {
		if b, ok := boxes[asStr(att["nodeId"])]; ok {
			c := boxCenter(b)
			return &c
		}
	}
	if pt := asObj(ep["point"]); pt != nil {
		p := [2]float64{asNum(pt["x"]), asNum(pt["y"])}
		return &p
	}
	return nil
}

func resolveConnectorEnd(ep map[string]any, boxes map[string]rbox, toward *[2]float64) ([2]float64, bool) {
	if ep == nil {
		return [2]float64{}, false
	}
	if att := asObj(ep["attach"]); att != nil {
		if b, ok := boxes[asStr(att["nodeId"])]; ok {
			return anchorPoint(b, asStr(att["anchor"]), toward), true
		}
	}
	if pt := asObj(ep["point"]); pt != nil {
		return [2]float64{asNum(pt["x"]), asNum(pt["y"])}, true
	}
	return [2]float64{}, false
}

// orthogonalChain visits each point with axis-aligned segments (mirrors the
// engine + @hc/whiteboard helper) so an elbow route through waypoints stays
// orthogonal.
func orthogonalChain(pts [][2]float64) [][2]float64 {
	if len(pts) == 0 {
		return nil
	}
	out := [][2]float64{pts[0]}
	for i := 1; i < len(pts); i++ {
		p, q := out[len(out)-1], pts[i]
		if p[0] != q[0] && p[1] != q[1] {
			out = append(out, [2]float64{q[0], p[1]})
		}
		out = append(out, q)
	}
	return out
}

// connectorPoints resolves a connector to its routed polyline in PAGE coords,
// mirroring routeConnector + drawConnector (incl. waypoints). Returns nil when
// the endpoints cannot be resolved (e.g. attached to a deleted node).
func connectorPoints(node map[string]any, boxes map[string]rbox) [][2]float64 {
	start, end := asObj(node["start"]), asObj(node["end"])
	a, oka := resolveConnectorEnd(start, boxes, connectorEndRef(end, boxes))
	b, okb := resolveConnectorEnd(end, boxes, connectorEndRef(start, boxes))
	if !oka || !okb {
		return nil
	}
	route := asStr(node["route"])
	if wps := asArr(node["waypoints"]); len(wps) > 0 {
		through := [][2]float64{a}
		for _, w := range wps {
			wo := asObj(w)
			through = append(through, [2]float64{asNum(wo["x"]), asNum(wo["y"])})
		}
		through = append(through, b)
		if route == "elbow" {
			return orthogonalChain(through)
		}
		return through
	}
	dx, dy := b[0]-a[0], b[1]-a[1]
	if route == "straight" || (dx == 0 && dy == 0) {
		return [][2]float64{a, b}
	}
	if route == "curved" {
		return [][2]float64{a, {a[0] + dx/2, a[1] + dy/2}, b}
	}
	// elbow: split on the dominant axis at the midpoint.
	if math.Abs(dx) >= math.Abs(dy) {
		if dy == 0 {
			return [][2]float64{a, b}
		}
		midX := a[0] + dx/2
		return [][2]float64{a, {midX, a[1]}, {midX, b[1]}, b}
	}
	if dx == 0 {
		return [][2]float64{a, b}
	}
	midY := a[1] + dy/2
	return [][2]float64{a, {a[0], midY}, {b[0], midY}, b}
}

// pointAlong returns the point at fraction t (0..1) of a polyline's arc length.
func pointAlong(pts [][2]float64, t float64) [2]float64 {
	if len(pts) == 0 {
		return [2]float64{}
	}
	if len(pts) == 1 {
		return pts[0]
	}
	total := 0.0
	segs := make([]float64, 0, len(pts)-1)
	for i := 1; i < len(pts); i++ {
		d := math.Hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1])
		segs = append(segs, d)
		total += d
	}
	if total == 0 {
		return pts[0]
	}
	target := t * total
	for i, d := range segs {
		if target <= d || i == len(segs)-1 {
			f := 0.0
			if d != 0 {
				f = target / d
			}
			return [2]float64{pts[i][0] + (pts[i+1][0]-pts[i][0])*f, pts[i][1] + (pts[i+1][1]-pts[i][1])*f}
		}
		target -= d
	}
	return pts[len(pts)-1]
}

func connectorStrokeColor(node map[string]any) pdfColor {
	if st := asObj(node["stroke"]); st != nil {
		if c := pdfPaint(asObj(st["fill"])); c.ok {
			return c
		}
	}
	return pdfColor{r: 0.28, g: 0.33, b: 0.41, ok: true}
}

func connectorStrokeWidth(node map[string]any) float64 {
	if st := asObj(node["stroke"]); st != nil {
		if w := asNum(st["width"]); w > 0 {
			return w
		}
	}
	return 2
}

func capIs(node map[string]any, key, kind string) bool {
	c := asObj(node[key])
	return c != nil && asStr(c["kind"]) == kind
}

func connectorLabel(node map[string]any) (string, float64) {
	l := asObj(node["label"])
	if l == nil {
		return "", 0.5
	}
	pos := 0.5
	if p, ok := l["position"].(float64); ok {
		pos = p
	}
	return asStr(l["text"]), pos
}

// inkBrush reads an ink node's brush (color/width/opacity/mode), with defaults.
func inkBrush(node map[string]any) (col pdfColor, width, opacity float64, mode string) {
	b := asObj(node["brush"])
	width, opacity, mode = 4, 1, "pen"
	col = pdfColor{ok: true}
	if b != nil {
		if c := colorComponents(asObj(b["color"])); c.ok {
			col = c
		}
		if w := asNum(b["width"]); w > 0 {
			width = w
		}
		if o, ok := b["opacity"].(float64); ok {
			opacity = o
		}
		if m := asStr(b["mode"]); m != "" {
			mode = m
		}
	}
	return
}

// pdfRGBString formats a resolved color as an SVG "rgb(r,g,b)" string.
func pdfRGBString(c pdfColor) string {
	return "rgb(" + num(math.Round(c.r*255)) + "," + num(math.Round(c.g*255)) + "," + num(math.Round(c.b*255)) + ")"
}

// arrowHead returns the 3 polygon points of an arrowhead at `to`, pointing along
// from->to, sized from the stroke width. Empty when the segment has no length.
func arrowHead(from, to [2]float64, width float64) [][2]float64 {
	dx, dy := to[0]-from[0], to[1]-from[1]
	length := math.Hypot(dx, dy)
	if length == 0 {
		return nil
	}
	ux, uy := dx/length, dy/length
	size := math.Max(8, width*3)
	bx, by := to[0]-ux*size, to[1]-uy*size
	px, py := -uy, ux
	half := size * 0.5
	return [][2]float64{{to[0], to[1]}, {bx + px*half, by + py*half}, {bx - px*half, by - py*half}}
}

func inkPoints(node map[string]any) [][2]float64 {
	raw := asArr(node["points"])
	out := make([][2]float64, 0, len(raw))
	for _, p := range raw {
		po := asObj(p)
		out = append(out, [2]float64{asNum(po["x"]), asNum(po["y"])})
	}
	return out
}

// wrapStickyLines greedily wraps sticky text to a pixel width using an estimated
// glyph advance (~0.55*fontPx), mirroring the engine's DOM-free fallback; splits
// on existing newlines too.
func wrapStickyLines(text string, maxW, fontPx float64) []string {
	est := fontPx * 0.55
	if est <= 0 {
		est = 1
	}
	maxChars := int(math.Max(1, maxW/est))
	out := []string{}
	for _, para := range strings.Split(text, "\n") {
		words := strings.Fields(para)
		if len(words) == 0 {
			out = append(out, "")
			continue
		}
		line := ""
		for _, wd := range words {
			cand := wd
			if line != "" {
				cand = line + " " + wd
			}
			if len(cand) > maxChars && line != "" {
				out = append(out, line)
				line = wd
			} else {
				line = cand
			}
		}
		out = append(out, line)
	}
	return out
}
