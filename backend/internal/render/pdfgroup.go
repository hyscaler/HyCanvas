package render

// PDF transparency groups (F40 Phase 1 groundwork).
//
// PDF applied node opacity as a cumulative /ca down the ancestor chain, which
// is the same multiply-down model the browser and the raster path used: two
// overlapping children in a 50% group were each drawn at 50%, so the overlap
// reached 75% and the group showed a seam along every shared edge.
//
// The other backends fixed this with an offscreen layer. PDF's equivalent is a
// Form XObject carrying `/Group << /S /Transparency >>`: its content composites
// into its own backdrop and the result is painted once, with the group's alpha
// on an /ExtGState. There is no way to express this inline, which is why this
// needed a real object rather than a flag.

import (
	"fmt"
	"math"
)

// pdfForm is one transparency group: a content stream plus the box it paints
// into, in the coordinate space that is current where the form is invoked.
type pdfForm struct {
	content string
	x0, y0  float64
	x1, y1  float64
}

// localContentBox is the union of a node's own box and every descendant's,
// expressed in the node's LOCAL space.
//
// This has to be exact rather than generous. A BBox CLIPS, so under-covering
// silently cuts off artwork, and the obvious escape of using an enormous fixed
// box does not work either: a group scaled down by 100x puts its children at
// coordinates 100x larger in local space, so no constant is safe. Transforming
// all four corners of each descendant handles rotation, which an axis-aligned
// accumulation would get wrong.
func localContentBox(node map[string]any) (float64, float64, float64, float64) {
	minX, minY := math.Inf(1), math.Inf(1)
	maxX, maxY := math.Inf(-1), math.Inf(-1)

	var walk func(n map[string]any, m mat, isRoot bool)
	walk = func(n map[string]any, m mat, isRoot bool) {
		if n == nil {
			return
		}
		// The root's own transform is applied by the caller's `cm`, so the form
		// space already includes it; only descendants compose theirs here.
		local := m
		if !isRoot {
			local = m.compose(nodeMat(n))
		}
		if w, h := sizeOf(n); w > 0 && h > 0 {
			for _, c := range [][2]float64{{0, 0}, {w, 0}, {w, h}, {0, h}} {
				x, y := local.apply(c[0], c[1])
				minX, minY = math.Min(minX, x), math.Min(minY, y)
				maxX, maxY = math.Max(maxX, x), math.Max(maxY, y)
			}
		}
		for _, ch := range childrenOf(n) {
			walk(asObj(ch), local, false)
		}
		// A mask's subject lives outside `children` and still paints.
		if asStr(n["type"]) == "mask" {
			walk(asObj(n["child"]), local, false)
		}
	}
	walk(node, matIdentity(), true)

	if math.IsInf(minX, 1) {
		// Nothing measurable: fall back to the node's own box so the form is
		// valid rather than degenerate.
		w, h := sizeOf(node)
		return 0, 0, math.Max(w, 1), math.Max(h, 1)
	}
	// Effects (blur haloes, shadows, outlines) paint outside the geometry, and
	// a clipped shadow is exactly the kind of subtle export-only difference
	// this whole exercise exists to prevent. The pad is proportional so it
	// survives any scale.
	padX := math.Max((maxX-minX)*0.25, 64)
	padY := math.Max((maxY-minY)*0.25, 64)
	return minX - padX, minY - padY, maxX + padX, maxY + padY
}

// emitTransparencyGroup captures `draw` into a Form XObject carrying a
// transparency group, then invokes it with the group's alpha on an ExtGState.
//
// The alpha rides on the INVOCATION, not on the contents: that is the whole
// point. Children draw at full strength inside the form and the finished
// composite is faded once, so an overlap is no darker than the rest.
func (c *pdfCtx) emitTransparencyGroup(node map[string]any, ca float64, bm string, draw func()) {
	// Divert emission. Captured by value rather than by swapping the Buffer
	// struct, which would copy a slice header around behind the type's back.
	saved := c.buf.String()
	c.buf.Reset()

	prevAlpha := c.alpha
	c.alpha = 1 // inside the group, nothing inherits the group's fade
	draw()
	c.alpha = prevAlpha

	inner := c.buf.String()
	c.buf.Reset()
	c.buf.WriteString(saved)

	x0, y0, x1, y1 := localContentBox(node)
	k := len(c.forms)
	c.forms = append(c.forms, pdfForm{content: inner, x0: x0, y0: y0, x1: x1, y1: y1})

	c.op("q")
	if ca < 1 || bm != "" {
		c.op("/" + c.gstateFor(ca, bm) + " gs")
	}
	c.op("/" + formResourceRef(k) + " Do")
	c.op("Q")
}

// formObject serializes one transparency group. `res` is the page's resource
// dictionary, reused verbatim: the form is emitted during the same pass that
// registers every font, image, and graphics state, so by the time resources
// are assembled they already cover whatever the form's content referenced.
func (f pdfForm) object(res string) string {
	return fmt.Sprintf(
		"<< /Type /XObject /Subtype /Form /FormType 1 /BBox [%s %s %s %s] "+
			"/Group << /Type /Group /S /Transparency /CS /DeviceRGB /I true /K false >> "+
			"/Resources %s /Length %d >>\nstream\n%s\nendstream",
		pn(f.x0), pn(f.y0), pn(f.x1), pn(f.y1), res, len(f.content)+1, f.content)
}

// formResourceRef is the name a page's resource dictionary uses for form k.
func formResourceRef(k int) string { return fmt.Sprintf("Fm%d", k) }
