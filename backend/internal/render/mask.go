package render

// Mask rendering (F40 Phase 1 groundwork).
//
// A `mask` node keeps its subject in `child` and its boundary in `maskShape`.
// Before this file, no Go backend drew either: raster had no case at all, SVG
// emitted an unsupported-type comment, and PDF dropped it silently, so a
// masked object exported as a hole. The browser matched, because the engine
// never built a SceneNode for `child`.
//
// The raster approach mirrors what the isolated-layer effect path already does:
// draw the subject into its own transparent layer, build the mask's coverage
// into a second layer, multiply the subject's alpha by that coverage, then
// composite. Doing it through coverage rather than a hard per-pixel test is
// what gives an antialiased mask edge; a boolean in/out test would stair-step
// every curve.

import (
	"image"
	"image/color"
	"strings"

	"golang.org/x/image/vector"
)

// traceMaskPath feeds a VectorPath into a rasterizer, honouring anchor handles.
//
// Curves are traced as curves. A mask edge IS the visible boundary of whatever
// it contains, so flattening it to line segments shows up as faceting on every
// rounded mask, and this is the shape most masks actually have.
//
// Reports whether anything traceable was found.
func traceMaskPath(r *vector.Rasterizer, m mat, path map[string]any) bool {
	subs := asArr(path["subpaths"])
	traced := false
	for _, sp := range subs {
		anchors := asArr(asObj(sp)["anchors"])
		if len(anchors) < 2 {
			continue
		}
		pt := func(i int) (float64, float64) {
			a := asObj(anchors[i])
			return m.apply(asNum(a["x"]), asNum(a["y"]))
		}
		// A handle is stored in the same local space as the anchor, so it goes
		// through the same transform.
		handle := func(i int, key string) (float64, float64, bool) {
			h := asObj(asObj(anchors[i])[key])
			if h == nil {
				return 0, 0, false
			}
			x, y := m.apply(asNum(h["x"]), asNum(h["y"]))
			return x, y, true
		}

		x0, y0 := pt(0)
		r.MoveTo(float32(x0), float32(y0))
		for i := 1; i < len(anchors); i++ {
			cx, cy := pt(i)
			c1x, c1y, hasOut := handle(i-1, "outHandle")
			c2x, c2y, hasIn := handle(i, "inHandle")
			if hasOut || hasIn {
				px, py := pt(i - 1)
				if !hasOut {
					c1x, c1y = px, py
				}
				if !hasIn {
					c2x, c2y = cx, cy
				}
				r.CubeTo(float32(c1x), float32(c1y), float32(c2x), float32(c2y), float32(cx), float32(cy))
			} else {
				r.LineTo(float32(cx), float32(cy))
			}
		}
		if asBool(asObj(sp)["closed"]) {
			last := len(anchors) - 1
			c1x, c1y, hasOut := handle(last, "outHandle")
			c2x, c2y, hasIn := handle(0, "inHandle")
			if hasOut || hasIn {
				lx, ly := pt(last)
				if !hasOut {
					c1x, c1y = lx, ly
				}
				if !hasIn {
					c2x, c2y = x0, y0
				}
				r.CubeTo(float32(c1x), float32(c1y), float32(c2x), float32(c2y), float32(x0), float32(y0))
			}
			r.ClosePath()
		}
		traced = true
	}
	return traced
}

// applyAlphaMask multiplies every channel of dst by the coverage in mask.
//
// image.RGBA is premultiplied, so the colour channels scale alongside alpha;
// scaling alpha alone would leave the colour too bright at the soft edge and
// produce a light fringe around every mask.
func applyAlphaMask(dst, mask *image.RGBA) {
	b := dst.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		di := dst.PixOffset(b.Min.X, y)
		mi := mask.PixOffset(b.Min.X, y)
		for x := b.Min.X; x < b.Max.X; x++ {
			cov := uint32(mask.Pix[mi+3])
			switch cov {
			case 255:
				// Fully inside: leave the pixel exactly as drawn, so an
				// unmasked interior is bit-identical to drawing without a mask.
			case 0:
				dst.Pix[di] = 0
				dst.Pix[di+1] = 0
				dst.Pix[di+2] = 0
				dst.Pix[di+3] = 0
			default:
				// +127 rounds to nearest rather than truncating, which keeps a
				// fully-opaque subject under full coverage from drifting down.
				dst.Pix[di] = uint8((uint32(dst.Pix[di])*cov + 127) / 255)
				dst.Pix[di+1] = uint8((uint32(dst.Pix[di+1])*cov + 127) / 255)
				dst.Pix[di+2] = uint8((uint32(dst.Pix[di+2])*cov + 127) / 255)
				dst.Pix[di+3] = uint8((uint32(dst.Pix[di+3])*cov + 127) / 255)
			}
			di += 4
			mi += 4
		}
	}
}

// rasterMask draws a mask node: its subject, trimmed to its shape.
//
// `m` is the mask's own composed matrix, so the shape and the child share one
// coordinate space.
func (rc *rctx) rasterMask(m mat, node map[string]any) {
	child := asObj(node["child"])
	if child == nil {
		return
	}

	shape := asObj(node["maskShape"])
	r := vector.NewRasterizer(rc.w, rc.h)
	if shape == nil || !traceMaskPath(r, m, shape) {
		// An unusable mask shape draws the subject UNMASKED rather than
		// hiding it. Both outcomes are wrong; one loses the artwork from the
		// export entirely and the other merely fails to trim it, and a
		// document that renders today must not start exporting blank.
		rc.rasterNode(m, child)
		return
	}

	maskLayer := rc.takeLayer()
	defer rc.releaseLayer(maskLayer)
	r.Draw(maskLayer, maskLayer.Bounds(), image.NewUniform(color.RGBA{A: 255, R: 255, G: 255, B: 255}), image.Point{})

	subject := rc.takeLayer()
	defer rc.releaseLayer(subject)
	page, prevAlpha := rc.dst, rc.alpha
	// The subject is drawn at full strength inside the layer; the mask node's
	// inherited alpha is applied once on the way back out, exactly as
	// rasterLayered does, so opacity is not multiplied in twice.
	rc.dst, rc.alpha = subject, 1
	rc.rasterNode(m, child)
	rc.dst, rc.alpha = page, prevAlpha

	applyAlphaMask(subject, maskLayer)
	if prevAlpha < 1 {
		scaleLayerAlpha(subject, prevAlpha)
	}
	mode := blendModeOf(node)
	if mode == "" {
		mode = "normal"
	}
	compositeLayer(page, subject, mode)
}

// svgMaskPathData renders a VectorPath as SVG path data in the node's LOCAL
// space, honouring anchor handles.
//
// Local space, not page space: the emitted <clipPath> lives inside the mask's
// own <g>, which already carries the node transform, so transforming the points
// here as well would apply it twice.
func svgMaskPathData(path map[string]any) string {
	subs := asArr(path["subpaths"])
	var sb strings.Builder
	for _, sp := range subs {
		anchors := asArr(asObj(sp)["anchors"])
		if len(anchors) < 2 {
			continue
		}
		at := func(i int) (float64, float64) {
			a := asObj(anchors[i])
			return asNum(a["x"]), asNum(a["y"])
		}
		handle := func(i int, key string) (float64, float64, bool) {
			h := asObj(asObj(anchors[i])[key])
			if h == nil {
				return 0, 0, false
			}
			return asNum(h["x"]), asNum(h["y"]), true
		}
		x0, y0 := at(0)
		sb.WriteString("M" + num(x0) + " " + num(y0))
		for i := 1; i < len(anchors); i++ {
			cx, cy := at(i)
			c1x, c1y, hasOut := handle(i-1, "outHandle")
			c2x, c2y, hasIn := handle(i, "inHandle")
			if hasOut || hasIn {
				px, py := at(i - 1)
				if !hasOut {
					c1x, c1y = px, py
				}
				if !hasIn {
					c2x, c2y = cx, cy
				}
				sb.WriteString("C" + num(c1x) + " " + num(c1y) + " " + num(c2x) + " " + num(c2y) + " " + num(cx) + " " + num(cy))
			} else {
				sb.WriteString("L" + num(cx) + " " + num(cy))
			}
		}
		if asBool(asObj(sp)["closed"]) {
			last := len(anchors) - 1
			c1x, c1y, hasOut := handle(last, "outHandle")
			c2x, c2y, hasIn := handle(0, "inHandle")
			if hasOut || hasIn {
				lx, ly := at(last)
				if !hasOut {
					c1x, c1y = lx, ly
				}
				if !hasIn {
					c2x, c2y = x0, y0
				}
				sb.WriteString("C" + num(c1x) + " " + num(c1y) + " " + num(c2x) + " " + num(c2y) + " " + num(x0) + " " + num(y0))
			}
			sb.WriteString("Z")
		}
	}
	return sb.String()
}

// pdfMaskPath emits a VectorPath as PDF path operators in the node's LOCAL
// space, honouring anchor handles.
//
// Local space for the same reason as the SVG form: the mask's own `cm` is
// already on the stack when this runs.
//
// Reports whether anything was emitted, so the caller can tell "clip to this"
// apart from "there is nothing to clip to".
func pdfMaskPath(c *pdfCtx, path map[string]any) bool {
	subs := asArr(path["subpaths"])
	emitted := false
	for _, sp := range subs {
		anchors := asArr(asObj(sp)["anchors"])
		if len(anchors) < 2 {
			continue
		}
		at := func(i int) (float64, float64) {
			a := asObj(anchors[i])
			return asNum(a["x"]), asNum(a["y"])
		}
		handle := func(i int, key string) (float64, float64, bool) {
			h := asObj(asObj(anchors[i])[key])
			if h == nil {
				return 0, 0, false
			}
			return asNum(h["x"]), asNum(h["y"]), true
		}
		x0, y0 := at(0)
		c.op(pn(x0) + " " + pn(y0) + " m")
		for i := 1; i < len(anchors); i++ {
			cx, cy := at(i)
			c1x, c1y, hasOut := handle(i-1, "outHandle")
			c2x, c2y, hasIn := handle(i, "inHandle")
			if hasOut || hasIn {
				px, py := at(i - 1)
				if !hasOut {
					c1x, c1y = px, py
				}
				if !hasIn {
					c2x, c2y = cx, cy
				}
				c.op(pn(c1x) + " " + pn(c1y) + " " + pn(c2x) + " " + pn(c2y) + " " + pn(cx) + " " + pn(cy) + " c")
			} else {
				c.op(pn(cx) + " " + pn(cy) + " l")
			}
		}
		if asBool(asObj(sp)["closed"]) {
			last := len(anchors) - 1
			c1x, c1y, hasOut := handle(last, "outHandle")
			c2x, c2y, hasIn := handle(0, "inHandle")
			if hasOut || hasIn {
				lx, ly := at(last)
				if !hasOut {
					c1x, c1y = lx, ly
				}
				if !hasIn {
					c2x, c2y = x0, y0
				}
				c.op(pn(c1x) + " " + pn(c1y) + " " + pn(c2x) + " " + pn(c2y) + " " + pn(x0) + " " + pn(y0) + " c")
			}
			c.op("h")
		}
		emitted = true
	}
	return emitted
}

// groupNeedsIsolation reports whether a container must composite as a unit.
//
// Mirrors `needsIsolation` in the engine's layer.ts, including the reason for
// the child-count guard: with a single child there is nothing to overlap, so
// multiplying alpha down is pixel-identical and a page-sized layer would be
// pure cost. Blend and an explicit isolation flag change the compositing model
// rather than only the alpha, and those are handled by the caller's other
// conditions and by this flag respectively.
func groupNeedsIsolation(node map[string]any) bool {
	switch asStr(node["type"]) {
	case "group", "frame", "grid":
	default:
		return false
	}
	if asBool(node["isolation"]) {
		return true
	}
	return nodeOpacity(node) < 1 && len(childrenOf(node)) > 1
}

// shallowCopyMap copies a node one level deep.
//
// Group isolation needs to draw a container with its own opacity neutralized
// (the fade belongs on the composite, not on each child), without mutating the
// caller's document: the same loaded design is reused across pages and export
// formats, so an in-place edit would leak into the next one.
func shallowCopyMap(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}
