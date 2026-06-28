// Pure whiteboard->deck transform (port of @hc/whiteboard deck.ts + region.ts),
// operating on the opaque DesignFile JSON. Each top-level frame becomes a slide
// (child-based frames extract their children; hand-drawn sections gather nodes
// spatially inside them); a frameless board becomes one fitted slide. The input
// design is never mutated.
package convert

import (
	"encoding/json"
	"math"

	"github.com/google/uuid"

	"hycanvas/backend/internal/persistence"
)

type box struct{ x, y, w, h float64 }

func newID() string { return "n-" + uuid.NewString() }

func asArr(v any) []any          { a, _ := v.([]any); return a }
func asObj(v any) map[string]any { m, _ := v.(map[string]any); return m }
func num(m map[string]any, k string) float64 {
	switch n := m[k].(type) {
	case float64:
		return n
	case int:
		return float64(n)
	}
	return 0
}

func deepClone(v map[string]any) map[string]any {
	b, _ := json.Marshal(v)
	var out map[string]any
	_ = json.Unmarshal(b, &out)
	return out
}

func isFrame(n map[string]any) bool { t, _ := n["type"].(string); return t == "frame" }

func nodeBox(n map[string]any) box {
	t := asObj(n["transform"])
	s := asObj(n["size"])
	return box{x: num(t, "x"), y: num(t, "y"), w: num(s, "width"), h: num(s, "height")}
}

func allTopLevel(design map[string]any) []map[string]any {
	var out []map[string]any
	for _, p := range asArr(design["pages"]) {
		for _, c := range asArr(asObj(p)["children"]) {
			out = append(out, asObj(c))
		}
	}
	return out
}

func topLevelFrames(design map[string]any) []map[string]any {
	var out []map[string]any
	for _, n := range allTopLevel(design) {
		if isFrame(n) {
			out = append(out, n)
		}
	}
	return out
}

func unionBounds(nodes []map[string]any) box {
	if len(nodes) == 0 {
		return box{0, 0, 1, 1}
	}
	minX, minY := math.Inf(1), math.Inf(1)
	maxX, maxY := math.Inf(-1), math.Inf(-1)
	for _, n := range nodes {
		b := nodeBox(n)
		minX = math.Min(minX, b.x)
		minY = math.Min(minY, b.y)
		maxX = math.Max(maxX, b.x+b.w)
		maxY = math.Max(maxY, b.y+b.h)
	}
	return box{x: minX, y: minY, w: math.Max(1, maxX-minX), h: math.Max(1, maxY-minY)}
}

func regenIDs(node map[string]any) {
	node["id"] = newID()
	for _, c := range asArr(node["children"]) {
		regenIDs(asObj(c))
	}
	if ch := asObj(node["child"]); ch != nil {
		regenIDs(ch)
	}
}

func cloneWithNewIDs(n map[string]any) map[string]any {
	c := deepClone(n)
	regenIDs(c)
	return c
}

func localize(node map[string]any, dx, dy float64) {
	if t := asObj(node["transform"]); t != nil {
		t["x"] = num(t, "x") - dx
		t["y"] = num(t, "y") - dy
	}
}

func whiteBackground() map[string]any {
	return map[string]any{"type": "solid", "color": map[string]any{"srgb": map[string]any{"r": 1.0, "g": 1.0, "b": 1.0, "a": 1.0}}}
}

// makePage clones the given nodes with fresh ids, localizes them to the origin,
// and returns a page sized to the origin box.
func makePage(name string, nodes []map[string]any, origin box) map[string]any {
	children := make([]any, 0, len(nodes))
	for _, n := range nodes {
		c := cloneWithNewIDs(n)
		localize(c, origin.x, origin.y)
		children = append(children, c)
	}
	return map[string]any{
		"id": newID(), "name": name,
		"width": math.Max(1, origin.w), "height": math.Max(1, origin.h),
		"children": children,
	}
}

func nameOr(n map[string]any, def string) string {
	if s, _ := n["name"].(string); s != "" {
		return s
	}
	return def
}

// fitPageToSlide scales + centers a localized page onto a uniform slide.
func fitPageToSlide(page map[string]any, w, h float64) map[string]any {
	cw := math.Max(1, num(page, "width"))
	ch := math.Max(1, num(page, "height"))
	s := math.Min(w/cw, h/ch)
	offX := (w - cw*s) / 2
	offY := (h - ch*s) / 2
	for _, c := range asArr(page["children"]) {
		node := asObj(c)
		t := asObj(node["transform"])
		if t == nil {
			t = map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0}
			node["transform"] = t
		}
		sx, sy := 1.0, 1.0
		if v, ok := t["scaleX"].(float64); ok {
			sx = v
		}
		if v, ok := t["scaleY"].(float64); ok {
			sy = v
		}
		t["x"] = num(t, "x")*s + offX
		t["y"] = num(t, "y")*s + offY
		t["scaleX"] = sx * s
		t["scaleY"] = sy * s
	}
	page["width"] = w
	page["height"] = h
	page["background"] = whiteBackground()
	return page
}

func centerInside(b, fb box) bool {
	cx := b.x + b.w/2
	cy := b.y + b.h/2
	return cx >= fb.x && cx <= fb.x+fb.w && cy >= fb.y && cy <= fb.y+fb.h
}

// spatialSectionSlide gathers the nodes whose center is inside a childless frame.
func spatialSectionSlide(design, frame map[string]any, w, h float64) map[string]any {
	fb := nodeBox(frame)
	frameID, _ := frame["id"].(string)
	var inside []map[string]any
	for _, n := range allTopLevel(design) {
		id, _ := n["id"].(string)
		t, _ := n["type"].(string)
		if id == frameID || isFrame(n) || t == "connector" {
			continue
		}
		if centerInside(nodeBox(n), fb) {
			inside = append(inside, n)
		}
	}
	page := makePage(nameOr(frame, "Slide"), inside, box{x: fb.x, y: fb.y, w: math.Max(1, fb.w), h: math.Max(1, fb.h)})
	return fitPageToSlide(page, w, h)
}

func findFrame(design map[string]any, frameID string) map[string]any {
	for _, n := range allTopLevel(design) {
		if id, _ := n["id"].(string); id == frameID && isFrame(n) {
			return n
		}
	}
	return nil
}

// extractRegionFrame extracts a frame's content into pages (sectioned frame ->
// one page per child frame; plain frame -> one page of its children).
func extractRegionFrame(design map[string]any, frameID string) []map[string]any {
	frame := findFrame(design, frameID)
	if frame == nil {
		return []map[string]any{makePage("Page 1", nil, box{0, 0, 1, 1})}
	}
	var childFrames []map[string]any
	for _, c := range asArr(frame["children"]) {
		if cm := asObj(c); isFrame(cm) {
			childFrames = append(childFrames, cm)
		}
	}
	var pages []map[string]any
	if len(childFrames) > 0 {
		for _, section := range childFrames {
			nodes := objSlice(asArr(section["children"]))
			pages = append(pages, makePage(nameOr(section, "Section"), nodes, nodeBox(section)))
		}
	} else {
		nodes := objSlice(asArr(frame["children"]))
		pages = append(pages, makePage(nameOr(frame, "Frame"), nodes, nodeBox(frame)))
	}
	return pages
}

func objSlice(arr []any) []map[string]any {
	out := make([]map[string]any, 0, len(arr))
	for _, v := range arr {
		out = append(out, asObj(v))
	}
	return out
}

func createBlankDeck(title string, w, h float64) map[string]any {
	return map[string]any{
		"format": "hycanvas.design", "schemaVersion": float64(persistence.CurrentSchemaVersion),
		"id": newID(), "title": title, "unit": "px", "dpi": 96.0,
		"pages": []any{map[string]any{
			"id": newID(), "name": "Page 1", "width": w, "height": h,
			"background": whiteBackground(), "children": []any{},
		}},
		"assets": []any{}, "fonts": []any{}, "meta": map[string]any{},
	}
}

// WhiteboardToDeck converts a whiteboard design into a presentation deck (a
// normal multi-page DesignFile). Returns the deck and the slide count.
func WhiteboardToDeck(design map[string]any) (map[string]any, int) {
	const w, h = 1920.0, 1080.0
	title, _ := design["title"].(string)
	deck := createBlankDeck(title+" (deck)", w, h)

	meta := map[string]any{}
	for k, v := range asObj(design["meta"]) {
		meta[k] = v
	}
	delete(meta, "kind")
	delete(meta, "whiteboard")
	deck["meta"] = meta

	frames := topLevelFrames(design)
	var pages []any
	if len(frames) > 0 {
		for _, frame := range frames {
			if len(asArr(frame["children"])) > 0 {
				for _, p := range extractRegionFrame(design, frame["id"].(string)) {
					pages = append(pages, fitPageToSlide(p, w, h))
				}
			} else {
				pages = append(pages, spatialSectionSlide(design, frame, w, h))
			}
		}
	} else {
		all := allTopLevel(design)
		origin := unionBounds(all)
		hit := make([]map[string]any, 0, len(all))
		for _, n := range all {
			if boxesIntersect(nodeBox(n), origin) {
				hit = append(hit, n)
			}
		}
		pages = append(pages, fitPageToSlide(makePage("Page 1", hit, origin), w, h))
	}

	if len(pages) > 0 {
		deck["pages"] = pages
	}
	return deck, len(asArr(deck["pages"]))
}

func boxesIntersect(a, b box) bool {
	return a.x < b.x+b.w && a.x+a.w > b.x && a.y < b.y+b.h && a.y+a.h > b.y
}
