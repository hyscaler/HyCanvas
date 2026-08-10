// PDF effect layers (F38 export parity). Shadows, glows, layer blurs, colour
// adjustments and duotones have no PDF vector equivalent (PDF has no blur
// primitive and no colour matrix short of transparency-group trickery), so a
// node that carries them gets its effect layers RASTERIZED by the same
// compositing code the PNG export uses and embedded as image XObjects:
//
//   - shadows/glow become an UNDERLAY image drawn beneath the vector body, so
//     the artwork itself stays vector;
//   - a layer blur, adjustment, or duotone changes the content itself, so the
//     body (and its subtree) is REPLACED by the processed raster - except when
//     the subtree draws text, which stays vector (and keeps its content
//     effects dropped, as before) because rasterizing it would break
//     tagged-PDF text extraction.
//
// The node is rendered alone on a synthetic page, wrapped in copies of its
// ancestor chain so nested TRANSFORMS hold (the raster path draws containers
// as pure transforms, so nothing else of the ancestors matters here), with
// the ancestors' own opacity/blend/effects stripped (each ancestor applies
// those in its own PDF layer). The node's opacity/blend are stripped too:
// the surrounding /ExtGState applies them to the embedded image, keeping
// shadow fade and blend parity with the raster path. The render is cropped
// to the node's world box plus its effect reach, so a page of shadowed nodes
// pays per-node crops rather than per-node full pages.
package render

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"math"
	"strings"
)

// fxRasterScale is the raster density of embedded effect layers, in device
// pixels per design unit (2x ~ 144dpi at PDF's 72pt units).
const fxRasterScale = 2.0

// pdfFx classifies a node's raster-only effects.
type pdfFx struct {
	underlay bool // shadows and/or glow: raster beneath the vector body
	replace  bool // blur/adjustment/duotone: the content itself changes
	// composed folds the silhouette effects INTO the replacement raster (one
	// image = the raster path's isolated layer). Used when the node blends
	// (the blend must apply once to the finished layer) or when the PDF body
	// path cannot draw the node type at all.
	composed bool
}

// pdfDrawableType reports whether emitNode's body switch can draw this node
// type as vectors. Types outside this set (chart, table, qr, stamp, ...)
// rasterize wholesale when they carry effects, because an effect underlay
// with no body would show a floating shadow.
func pdfDrawableType(kind string) bool {
	switch kind {
	case "shape", "path", "line", "text", "image", "ink", "sticky", "connector", "group", "frame", "grid":
		return true
	}
	return false
}

// hasGlowFx reports a glow with a positive radius.
func hasGlowFx(node map[string]any) bool {
	for _, e := range effectsOf(node) {
		if e.kind == "glow" && asNum(e.raw["radius"]) > 0 {
			return true
		}
	}
	return false
}

func pdfFxOf(node map[string]any) pdfFx {
	var fx pdfFx
	if len(shadowsOf(node)) > 0 {
		fx.underlay = true
	}
	for _, e := range effectsOf(node) {
		switch e.kind {
		case "glow":
			if asNum(e.raw["radius"]) > 0 {
				fx.underlay = true
			}
		case "blur":
			if asNum(e.raw["radius"]) > 0 {
				fx.replace = true
			}
		case "adjustment":
			for _, o := range asArr(e.raw["ops"]) {
				oo := asObj(o)
				if oo == nil {
					continue
				}
				if m, blurPx, known := adjustmentMatrix(asStr(oo["name"]), asNum(oo["value"])); known && (blurPx > 0 || m != identityMatrix()) {
					fx.replace = true
				}
			}
		case "duotone":
			if v, ok := e.raw["intensity"].(float64); !ok || v > 0 {
				fx.replace = true
			}
		}
	}
	return fx
}

// containsText reports whether the subtree draws real, extractable text;
// rasterizing it would break tagged-PDF text extraction. Sticky notes draw
// their note as Tj text, and a connector's label does too.
func containsText(node map[string]any) bool {
	switch asStr(node["type"]) {
	case "text", "sticky":
		return true
	case "connector":
		if asStr(node["label"]) != "" {
			return true
		}
	}
	for _, ch := range childrenOf(node) {
		if containsText(asObj(ch)) {
			return true
		}
	}
	return false
}

// deepCopyJSON round-trips a JSON-shaped value; nodes are map[string]any all
// the way down, so this is a faithful deep copy.
func deepCopyJSON(node map[string]any) map[string]any {
	b, err := json.Marshal(node)
	if err != nil {
		return nil
	}
	var out map[string]any
	if json.Unmarshal(b, &out) != nil {
		return nil
	}
	return out
}

// inlineFxAssets embeds image pixels as data URLs on the COPIED subtree, the
// form the raster path reads, resolving them through the PDF's ImageSource.
func (c *pdfCtx) inlineFxAssets(node map[string]any) {
	if asStr(node["type"]) == "image" && !strings.HasPrefix(asStr(node["src"]), "data:") {
		if _, data, ok := assetBytes(node, c.src); ok {
			node["src"] = "data:application/octet-stream;base64," + base64.StdEncoding.EncodeToString(data)
		}
	}
	for _, ch := range childrenOf(node) {
		c.inlineFxAssets(asObj(ch))
	}
}

// fxSynthetic builds a one-page design holding only the sanitized node inside
// copies of its ancestor chain. keepSilhouette leaves the node's shadows,
// glow, and outline IN the render (the composed single-layer mode); otherwise
// they are stripped, because the underlay carries them and the silhouette
// they are computed FROM must not include them. Returns the synthetic design
// plus the crop origin in page units (the embedded layer's rects are relative
// to the crop); a nil design means the copy failed.
func (c *pdfCtx) fxSynthetic(node map[string]any, keepSilhouette bool) (synthOut Design, offX, offY float64) {
	leaf := deepCopyJSON(node)
	if leaf == nil {
		return nil, 0, 0
	}
	// The PDF's own graphics state applies these to the embedded image.
	delete(leaf, "opacity")
	delete(leaf, "blendMode")
	if !keepSilhouette {
		if effs, ok := leaf["effects"].([]any); ok {
			kept := make([]any, 0, len(effs))
			for _, e := range effs {
				switch asStr(asObj(e)["kind"]) {
				case "shadow", "glow", "outline":
					continue
				}
				kept = append(kept, e)
			}
			leaf["effects"] = kept
		}
		delete(leaf, "textEffects")
	}
	c.inlineFxAssets(leaf)

	var cur map[string]any = leaf
	for i := len(c.chain) - 1; i >= 0; i-- {
		src := c.chain[i]
		// Only the transform chain matters to the raster path here; the other
		// keys are carried for completeness (the raster renderer draws
		// containers as pure transforms).
		anc := map[string]any{
			"id":        asStr(src["id"]) + "-fx",
			"type":      asStr(src["type"]),
			"transform": src["transform"],
			"size":      src["size"],
			"children":  []any{cur},
		}
		cur = anc
	}

	// Render only the node's world box plus the furthest effect reach, not
	// the whole page: a deck full of shadowed nodes would otherwise pay a
	// full-page rasterization PER NODE. The crop is clamped to the page so a
	// shadow cannot reach further than the page export would show it, and a
	// sizeless container falls back to the full page.
	offX, offY = 0, 0
	pw, ph := c.pageW, c.pageH
	if w, h := sizeOf(node); w > 0 && h > 0 {
		wm := matIdentity()
		for _, anc := range c.chain {
			wm = wm.compose(nodeMat(anc))
		}
		wm = wm.compose(nodeMat(node))
		minX, minY := math.Inf(1), math.Inf(1)
		maxX, maxY := math.Inf(-1), math.Inf(-1)
		for _, p := range [][2]float64{{0, 0}, {w, 0}, {w, h}, {0, h}} {
			x, y := wm.apply(p[0], p[1])
			minX, minY = math.Min(minX, x), math.Min(minY, y)
			maxX, maxY = math.Max(maxX, x), math.Max(maxY, y)
		}
		margin := fxMargin(node)*offsetXformOf(wm).scale + 8
		x0 := math.Max(0, math.Floor(minX-margin))
		y0 := math.Max(0, math.Floor(minY-margin))
		x1 := math.Min(c.pageW, math.Ceil(maxX+margin))
		y1 := math.Min(c.pageH, math.Ceil(maxY+margin))
		if x1 > x0 && y1 > y0 {
			offX, offY = x0, y0
			pw, ph = x1-x0, y1-y0
			cur = map[string]any{
				"id": "fx-crop", "type": "group",
				"transform": map[string]any{"x": -x0, "y": -y0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
				"children":  []any{cur},
			}
		}
	}

	synth := Design{}
	for k, v := range c.file {
		synth[k] = v
	}
	synth["pages"] = []any{map[string]any{
		"width":    pw,
		"height":   ph,
		"children": []any{cur},
	}}
	return synth, offX, offY
}

// fxMargin is the furthest reach of the node's effects past its box, in the
// node's LOCAL units (the caller scales it into world units): shadow/glow
// blurs use the blur-is-2x-sigma convention (3 sigma = 1.5x), a layer blur's
// radius IS its sigma (3 sigma = 3x).
func fxMargin(node map[string]any) float64 {
	m := 0.0
	for _, sh := range shadowsOf(node) {
		if e := math.Max(math.Abs(sh.dx), math.Abs(sh.dy)) + 1.5*sh.blur; e > m {
			m = e
		}
	}
	for _, e := range effectsOf(node) {
		switch e.kind {
		case "glow":
			if v := 1.5 * asNum(e.raw["radius"]); v > m {
				m = v
			}
		case "blur":
			if v := 3 * asNum(e.raw["radius"]); v > m {
				m = v
			}
		case "adjustment":
			for _, o := range asArr(e.raw["ops"]) {
				oo := asObj(o)
				if oo == nil {
					continue
				}
				if _, blurPx, known := adjustmentMatrix(asStr(oo["name"]), asNum(oo["value"])); known && 3*blurPx > m {
					m = 3 * blurPx
				}
			}
		case "outline":
			if v := asNum(e.raw["width"]); v > m {
				m = v
			}
		}
	}
	return m
}

// fxLayers renders the node's raster effect layers: the shadow/glow underlay
// and, when fx.replace, the processed body. Either may come back nil (fully
// transparent, or the render failed, in which case the caller degrades to
// what the PDF drew before: unfiltered vector artwork).
func (c *pdfCtx) fxLayers(node map[string]any, fx pdfFx) (under, body *pdfImage, ub, bb [4]float64) {
	synth, offX, offY := c.fxSynthetic(node, fx.composed)
	if synth == nil {
		return
	}
	content, err := toRaster(synth, 0, fxRasterScale, true)
	if err != nil {
		return
	}
	shift := func(r [4]float64) [4]float64 { return [4]float64{r[0] + offX, r[1] + offY, r[2], r[3]} }
	if fx.composed {
		// One image = the raster path's isolated layer: content, shadows,
		// glow, and outline together, blended/faded once by the node's gs.
		body, bb = c.fxEmbed(content)
		bb = shift(bb)
		return
	}
	if fx.underlay {
		wm := matScale(fxRasterScale)
		for _, anc := range c.chain {
			wm = wm.compose(nodeMat(anc))
		}
		wm = wm.compose(nodeMat(node))
		xf := offsetXformOf(wm)
		u := image.NewRGBA(content.Bounds())
		for _, e := range effectsOf(node) {
			if e.kind == "glow" {
				drawGlow(u, content, e.raw, xf, 1)
			}
		}
		if sh := shadowsOf(node); len(sh) > 0 {
			drawShadows(u, content, sh, xf, 1)
		}
		under, ub = c.fxEmbed(u)
		ub = shift(ub)
	}
	if fx.replace {
		body, bb = c.fxEmbed(content)
		bb = shift(bb)
	}
	return
}

// fxEmbed crops a layer to its non-transparent bounds, PNG-encodes it, and
// registers it as a page image XObject. Returns nil for an all-clear layer.
// The rect is in PAGE units: x, y, w, h.
func (c *pdfCtx) fxEmbed(img *image.RGBA) (*pdfImage, [4]float64) {
	b, ok := tightBounds(img)
	if !ok {
		return nil, [4]float64{}
	}
	sub := img.SubImage(b).(*image.RGBA)
	var buf bytes.Buffer
	if png.Encode(&buf, sub) != nil {
		return nil, [4]float64{}
	}
	im, built := encodeImage(fmt.Sprintf("Im%d", len(c.images)), buf.Bytes())
	if !built {
		return nil, [4]float64{}
	}
	c.images = append(c.images, im)
	return im, [4]float64{
		float64(b.Min.X) / fxRasterScale,
		float64(b.Min.Y) / fxRasterScale,
		float64(b.Dx()) / fxRasterScale,
		float64(b.Dy()) / fxRasterScale,
	}
}

// tightBounds scans for the smallest rectangle holding every pixel with alpha.
func tightBounds(img *image.RGBA) (image.Rectangle, bool) {
	b := img.Bounds()
	minX, minY := b.Max.X, b.Max.Y
	maxX, maxY := b.Min.X-1, b.Min.Y-1
	for y := b.Min.Y; y < b.Max.Y; y++ {
		row := img.Pix[img.PixOffset(b.Min.X, y):img.PixOffset(b.Max.X, y):img.PixOffset(b.Max.X, y)]
		for x := 0; x < len(row)/4; x++ {
			if row[x*4+3] != 0 {
				px := b.Min.X + x
				if px < minX {
					minX = px
				}
				if px > maxX {
					maxX = px
				}
				if y < minY {
					minY = y
				}
				if y > maxY {
					maxY = y
				}
			}
		}
	}
	if maxX < minX || maxY < minY {
		return image.Rectangle{}, false
	}
	return image.Rect(minX, minY, maxX+1, maxY+1), true
}

// drawFxImage paints an embedded effect layer. The rect is in PAGE space, but
// the current transform may already carry the node's ancestor chain (nested
// nodes), so the placement is prefixed with the chain's inverse.
func (c *pdfCtx) drawFxImage(im *pdfImage, r [4]float64) {
	chain := matIdentity()
	for _, anc := range c.chain {
		chain = chain.compose(nodeMat(anc))
	}
	inv, ok := chain.invert()
	if !ok {
		return
	}
	place := mat{a: r[2], b: 0, c: 0, d: -r[3], e: r[0], f: r[1] + r[3]}
	t := inv.compose(place)
	c.op("q")
	c.op(pn(t.a) + " " + pn(t.b) + " " + pn(t.c) + " " + pn(t.d) + " " + pn(t.e) + " " + pn(t.f) + " cm")
	c.op("/" + im.name + " Do")
	c.op("Q")
}

// invert returns the affine inverse; ok=false for a degenerate matrix.
func (m mat) invert() (mat, bool) {
	det := m.a*m.d - m.b*m.c
	if det == 0 {
		return mat{}, false
	}
	ia, ib, ic, id := m.d/det, -m.b/det, -m.c/det, m.a/det
	return mat{
		a: ia, b: ib, c: ic, d: id,
		e: -(ia*m.e + ic*m.f),
		f: -(ib*m.e + id*m.f),
	}, true
}
