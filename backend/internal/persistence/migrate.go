// Forward-only schema migration of stored design files (ports @hc/schema
// migrate.ts). With the Go service the sole backend, LoadFile migrates an older
// stored file up to the current schema version before returning it, so server-
// side consumers (render/export, brand-lint, comment anchors) always see the
// current shape. Steps are pure + idempotent; opening an older file always
// succeeds. Most steps are additive version bumps; v1->v2 (rich text), v2->v3
// (image model), v3->v4 (unified color/fill), and v5->v6 (animation lift)
// transform the node tree.
package persistence

import "math"

// JSON accessors over the opaque DesignFile node maps.
func asObj(v any) map[string]any { m, _ := v.(map[string]any); return m }
func asArr(v any) []any          { a, _ := v.([]any); return a }
func asStr(v any) string         { s, _ := v.(string); return s }
func asNum(v any) float64        { f, _ := v.(float64); return f }
func asBool(v any) bool          { b, _ := v.(bool); return b }

// migrateFile forward-migrates a parsed DesignFile to the current schema version
// and repairs page dimensions. The schema bump is skipped when already current,
// but normalizePageDims always runs so a stored design with missing/invalid page
// width/height (e.g. an older template-derived file) is served renderable.
func migrateFile(file DesignFile) DesignFile {
	from := schemaVersionOf(file)
	cur := map[string]any(file)
	for v := from; v < currentSchemaVersion; v++ {
		switch v {
		case 1:
			cur = bumpPages(cur, 2, mapNodesV2)
		case 2:
			cur = bumpPages(cur, 3, mapNodesV3)
		case 3:
			cur = deepConvertColors(cur).(map[string]any)
			cur["schemaVersion"] = float64(4)
		case 5:
			cur = bumpPages(cur, 6, mapNodesV6)
		default:
			// Additive bumps (v4->v5, v6->v7, v7->v8, v8->v9): no transform.
			cur = shallowCopy(cur)
			cur["schemaVersion"] = float64(v + 1)
		}
	}
	return normalizePageDims(cur)
}

// finite reports a usable positive dimension.
func finiteDim(n float64) bool { return n > 0 && !math.IsNaN(n) && !math.IsInf(n, 0) }

// normalizePageDims ensures every page has a finite, positive width/height. When
// missing, it reuses an existing valid page size, else derives one from the
// content bounding box across all pages, else falls back to 1080. Returns the
// input unchanged when all pages are already valid.
func normalizePageDims(file map[string]any) DesignFile {
	pages := asArr(file["pages"])
	if len(pages) == 0 {
		return file
	}
	var fw, fh float64
	for _, p := range pages {
		po := asObj(p)
		if w, h := asNum(po["width"]), asNum(po["height"]); finiteDim(w) && finiteDim(h) {
			fw, fh = w, h
			break
		}
	}
	if !finiteDim(fw) || !finiteDim(fh) {
		var mw, mh float64
		for _, p := range pages {
			for _, n := range asArr(asObj(p)["children"]) {
				node := asObj(n)
				t := asObj(node["transform"])
				s := asObj(node["size"])
				w, h := asNum(s["width"]), asNum(s["height"])
				x, y := asNum(t["x"]), asNum(t["y"])
				if finiteDim(w) && finiteDim(h) && !math.IsNaN(x) && !math.IsNaN(y) {
					mw = math.Max(mw, x+w)
					mh = math.Max(mh, y+h)
				}
			}
		}
		fw = map[bool]float64{true: math.Round(mw), false: 1080}[mw > 0]
		fh = map[bool]float64{true: math.Round(mh), false: 1080}[mh > 0]
	}
	changed := false
	newPages := make([]any, len(pages))
	for i, p := range pages {
		po := asObj(p)
		w, h := asNum(po["width"]), asNum(po["height"])
		if finiteDim(w) && finiteDim(h) {
			newPages[i] = p
			continue
		}
		np := shallowCopy(po)
		if !finiteDim(w) {
			np["width"] = fw
		}
		if !finiteDim(h) {
			np["height"] = fh
		}
		newPages[i] = np
		changed = true
	}
	if !changed {
		return file
	}
	out := shallowCopy(file)
	out["pages"] = newPages
	return out
}

func shallowCopy(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// bumpPages sets the schema version and maps each page's children with fn.
func bumpPages(file map[string]any, version int, fn func([]any) []any) map[string]any {
	out := shallowCopy(file)
	out["schemaVersion"] = float64(version)
	pages := asArr(file["pages"])
	newPages := make([]any, len(pages))
	for i, p := range pages {
		page := shallowCopy(asObj(p))
		page["children"] = fn(asArr(page["children"]))
		newPages[i] = page
	}
	out["pages"] = newPages
	return out
}

// --- v1 -> v2: rich text -------------------------------------------------

func mapNodesV2(nodes []any) []any {
	out := make([]any, len(nodes))
	for i, n := range nodes {
		node := asObj(n)
		if asStr(node["type"]) == "text" && node["box"] == nil {
			node = migrateTextV1toV2(node)
		}
		if kids := asArr(node["children"]); kids != nil {
			node = shallowCopy(node)
			node["children"] = mapNodesV2(kids)
		}
		out[i] = node
	}
	return out
}

func migrateTextV1toV2(node map[string]any) map[string]any {
	oldRuns := asArr(node["content"])
	runs := make([]any, 0, len(oldRuns))
	for _, r := range oldRuns {
		ro := asObj(r)
		style := map[string]any{
			"fontFamily": orStr(ro["fontId"], "system"),
			"fontStyle":  ifElse(asBool(ro["italic"]), "Italic", "Regular"),
			"fontSize":   orNum(ro["fontSize"], 16),
			"fill":       map[string]any{"type": "solid", "color": orColor(ro["color"])},
		}
		if w, ok := ro["weight"].(float64); ok {
			style["axes"] = map[string]any{"wght": w}
		}
		copyIfPresent(ro, style, "letterSpacing", "lineHeight", "decoration", "features")
		runs = append(runs, map[string]any{"text": orStr(ro["text"], ""), "style": style})
	}
	size := asObj(node["size"])
	mode := "fixed"
	autoFit := asStr(node["autoFit"])
	if autoFit == "grow" {
		mode = "autoHeight"
	}
	box := map[string]any{
		"mode":          mode,
		"width":         asNum(size["width"]),
		"height":        asNum(size["height"]),
		"autoFit":       map[string]any{"enabled": autoFit != "" && autoFit != "none", "min": float64(8), "max": float64(512)},
		"verticalAlign": orStr(node["verticalAlign"], "top"),
	}
	paragraph := map[string]any{
		"runs":  runs,
		"style": map[string]any{"align": orStr(node["align"], "left"), "direction": orStr(node["direction"], "auto")},
	}
	next := shallowCopy(node)
	delete(next, "align")
	delete(next, "verticalAlign")
	delete(next, "direction")
	delete(next, "autoFit")
	delete(next, "fills")
	next["box"] = box
	next["content"] = []any{paragraph}
	return next
}

// --- v2 -> v3: image model -----------------------------------------------

func mapNodesV3(nodes []any) []any {
	out := make([]any, len(nodes))
	for i, n := range nodes {
		node := asObj(n)
		if asStr(node["type"]) == "image" && node["source"] == nil {
			node = migrateImageV2toV3(node)
		}
		if kids := asArr(node["children"]); kids != nil {
			node = shallowCopy(node)
			node["children"] = mapNodesV3(kids)
		}
		out[i] = node
	}
	return out
}

func migrateImageV2toV3(node map[string]any) map[string]any {
	next := shallowCopy(node)
	next["source"] = map[string]any{"assetId": orStr(node["assetId"], ""), "naturalWidth": float64(0), "naturalHeight": float64(0)}
	fit := asStr(node["fit"])
	switch fit {
	case "fill":
		next["fit"] = "stretch"
	case "contain":
		next["fit"] = "contain"
	default:
		next["fit"] = "cover"
	}
	delete(next, "assetId")
	delete(next, "crop")
	delete(next, "fills")
	return next
}

// --- v3 -> v4: unified color/fill ----------------------------------------

var fillTypes = map[string]bool{"solid": true, "linear": true, "radial": true, "conic": true, "mesh": true, "pattern": true, "image": true, "gradient": true}
var colorSpaces = map[string]bool{"srgb": true, "p3": true, "cmyk": true, "spot": true}

func cmykToSrgb(c, m, y, k, a float64) map[string]any {
	return map[string]any{"r": (1 - c) * (1 - k), "g": (1 - m) * (1 - k), "b": (1 - y) * (1 - k), "a": a}
}

func srgbToCmyk(s map[string]any) map[string]any {
	r, g, b := asNum(s["r"]), asNum(s["g"]), asNum(s["b"])
	k := 1 - math.Max(r, math.Max(g, b))
	if k >= 1 {
		return map[string]any{"c": float64(0), "m": float64(0), "y": float64(0), "k": float64(1)}
	}
	return map[string]any{"c": (1 - r - k) / (1 - k), "m": (1 - g - k) / (1 - k), "y": (1 - b - k) / (1 - k), "k": k}
}

func convertColor(c map[string]any) map[string]any {
	if c["srgb"] != nil {
		return c
	}
	space := asStr(c["space"])
	switch space {
	case "srgb", "p3":
		return map[string]any{"srgb": map[string]any{"r": c["r"], "g": c["g"], "b": c["b"], "a": c["a"]}}
	case "cmyk":
		return map[string]any{
			"srgb": cmykToSrgb(asNum(c["c"]), asNum(c["m"]), asNum(c["y"]), asNum(c["k"]), orNum(c["a"], 1)),
			"cmyk": map[string]any{"c": c["c"], "m": c["m"], "y": c["y"], "k": c["k"]},
		}
	case "spot":
		fb := convertColor(asObjOrEmpty(c["fallback"]))
		spotFallback := fb["cmyk"]
		if spotFallback == nil {
			spotFallback = srgbToCmyk(asObj(fb["srgb"]))
		}
		return map[string]any{"srgb": fb["srgb"], "spot": map[string]any{"name": c["name"], "fallback": spotFallback}}
	}
	return c
}

func convStops(stops []any) []any {
	out := make([]any, len(stops))
	for i, s := range stops {
		so := asObj(s)
		pos := so["position"]
		if pos == nil {
			pos = orNum(so["offset"], 0)
		}
		out[i] = map[string]any{"position": pos, "color": convertColor(asObj(so["color"]))}
	}
	return out
}

func convertFill(f map[string]any) map[string]any {
	switch asStr(f["type"]) {
	case "solid":
		return map[string]any{"type": "solid", "color": convertColor(asObj(f["color"]))}
	case "linear":
		return map[string]any{"type": "gradient", "gradient": "linear", "stops": convStops(asArr(f["stops"])), "angle": f["angle"]}
	case "radial":
		return map[string]any{"type": "gradient", "gradient": "radial", "stops": convStops(asArr(f["stops"])), "center": map[string]any{"x": f["cx"], "y": f["cy"]}, "radius": f["r"]}
	case "conic":
		return map[string]any{"type": "gradient", "gradient": "conic", "stops": convStops(asArr(f["stops"])), "center": map[string]any{"x": f["cx"], "y": f["cy"]}, "angle": f["angle"]}
	case "mesh":
		pts := asArr(f["points"])
		mpts := make([]any, len(pts))
		for i, p := range pts {
			po := asObj(p)
			mpts[i] = map[string]any{"x": po["x"], "y": po["y"], "color": convertColor(asObj(po["color"]))}
		}
		return map[string]any{"type": "gradient", "gradient": "mesh", "stops": []any{}, "mesh": map[string]any{"rows": f["rows"], "cols": f["cols"], "points": mpts}}
	case "pattern":
		repeat := asStr(f["repeat"])
		if repeat == "none" {
			repeat = "no-repeat"
		}
		return compactMap(map[string]any{"type": "pattern", "assetId": f["assetId"], "scale": f["scale"], "rotation": f["rotation"], "repeat": repeat})
	case "image":
		if f["source"] != nil {
			return f
		}
		fit := asStr(f["fit"])
		switch fit {
		case "fill":
			fit = "stretch"
		case "tile":
			fit = "cover"
		case "":
			fit = "cover"
		}
		return map[string]any{"type": "image", "source": map[string]any{"assetId": orStr(f["assetId"], ""), "naturalWidth": float64(0), "naturalHeight": float64(0)}, "fit": fit}
	case "gradient":
		out := shallowCopy(f)
		out["stops"] = convStops(asArr(f["stops"]))
		if mesh := asObj(f["mesh"]); mesh != nil {
			pts := asArr(mesh["points"])
			mpts := make([]any, len(pts))
			for i, p := range pts {
				po := shallowCopy(asObj(p))
				po["color"] = convertColor(asObj(asObj(p)["color"]))
				mpts[i] = po
			}
			nm := shallowCopy(mesh)
			nm["points"] = mpts
			out["mesh"] = nm
		}
		return out
	}
	return f
}

func isColorObj(v map[string]any) bool {
	if sp, ok := v["space"].(string); ok && colorSpaces[sp] {
		return true
	}
	if srgb, ok := v["srgb"].(map[string]any); ok {
		_, hasR := srgb["r"]
		_, hasType := v["type"]
		return hasR && !hasType
	}
	return false
}

func isFillObj(v map[string]any) bool {
	t, ok := v["type"].(string)
	if !ok || !fillTypes[t] {
		return false
	}
	_, hasID := v["id"]
	_, hasTransform := v["transform"]
	return !hasID && !hasTransform
}

func deepConvertColors(value any) any {
	switch v := value.(type) {
	case []any:
		out := make([]any, len(v))
		for i, e := range v {
			out[i] = deepConvertColors(e)
		}
		return out
	case map[string]any:
		if isColorObj(v) {
			return convertColor(v)
		}
		if isFillObj(v) {
			return convertFill(v)
		}
		out := make(map[string]any, len(v))
		for k, val := range v {
			if k == "raw" || k == "data" {
				out[k] = val // preserve lossless slots
			} else {
				out[k] = deepConvertColors(val)
			}
		}
		return out
	}
	return value
}

// --- v5 -> v6: animation lift --------------------------------------------

var legacyEntrance = map[string]string{"fade": "fade", "rise": "rise", "pop": "pop", "slideL": "pan", "slideR": "pan"}

func mapNodesV6(nodes []any) []any {
	out := make([]any, len(nodes))
	for i, n := range nodes {
		node := migrateAnimationsV5toV6(asObj(n))
		if kids := asArr(node["children"]); kids != nil {
			node = shallowCopy(node)
			node["children"] = mapNodesV6(kids)
		}
		if child := asObj(node["child"]); child != nil {
			node = shallowCopy(node)
			node["child"] = mapNodesV6([]any{child})[0]
		}
		out[i] = node
	}
	return out
}

func migrateAnimationsV5toV6(node map[string]any) map[string]any {
	if node["animation"] != nil {
		return node
	}
	anims := asArr(node["animations"])
	if len(anims) == 0 {
		return node
	}
	legacy := asObj(anims[0])
	if legacy == nil {
		return node
	}
	preset, ok := legacyEntrance[asStr(legacy["preset"])]
	if !ok {
		return node
	}
	next := shallowCopy(node)
	next["animation"] = map[string]any{"entrance": map[string]any{
		"preset":     preset,
		"durationMs": orNum(legacy["durationMs"], 500),
		"delayMs":    orNum(legacy["delayMs"], 0),
		"easing":     "ease-out",
	}}
	return next
}

// --- tiny helpers --------------------------------------------------------

func orStr(v any, def string) string {
	if s, ok := v.(string); ok && s != "" {
		return s
	}
	return def
}

func orNum(v any, def float64) float64 {
	if f, ok := v.(float64); ok {
		return f
	}
	return def
}

func orColor(v any) map[string]any {
	if c, ok := v.(map[string]any); ok {
		return c
	}
	return map[string]any{"space": "srgb", "r": float64(0), "g": float64(0), "b": float64(0), "a": float64(1)}
}

func ifElse(cond bool, a, b string) string {
	if cond {
		return a
	}
	return b
}

func copyIfPresent(src, dst map[string]any, keys ...string) {
	for _, k := range keys {
		if v, ok := src[k]; ok {
			dst[k] = v
		}
	}
}

func asObjOrEmpty(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func compactMap(m map[string]any) map[string]any {
	for k, v := range m {
		if v == nil {
			delete(m, k)
		}
	}
	return m
}
