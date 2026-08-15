// Linear/radial gradient fills for the raster export. The browser engine paints
// gradients per-pixel; here we expose a gradient as an image.Image source the
// vector rasterizer samples while filling a shape, so PNG/JPG exports match the
// editor instead of flattening to the first stop. Geometry uses the same
// objectBoundingBox convention as the SVG exporter (svg.go): the linear axis runs
// from (0.5-cos/2, 0.5-sin/2) to (0.5+cos/2, 0.5+sin/2) of the shape's box.
package render

import (
	"image"
	"image/color"
	"math"
	"sort"
)

type gradStop struct {
	pos float64
	col pdfColor
	a   float64 // per-stop alpha 0..1 (pdfColor carries only rgb)
}

// gradSpec is a parsed gradient fill (linear or radial). ok is false when the
// fill is not a gradient or has fewer than two usable stops (caller falls back
// to a flat color).
type gradSpec struct {
	ok     bool
	radial bool
	conic  bool
	angle  float64 // linear/conic start angle, degrees
	cx, cy float64 // radial/conic center in objectBoundingBox units (default 0.5)
	radius float64 // radial radius in objectBoundingBox units (default 0.5)
	stops  []gradStop
}

func parseGradient(fill map[string]any) gradSpec {
	if fill == nil || asStr(fill["type"]) != "gradient" {
		return gradSpec{}
	}
	raw := asArr(fill["stops"])
	stops := make([]gradStop, 0, len(raw))
	for _, s := range raw {
		so := asObj(s)
		colObj := asObj(so["color"])
		c := colorComponents(colObj)
		if !c.ok {
			continue
		}
		// pdfColor drops alpha; read srgb.a directly (default opaque when absent)
		// so a semi-transparent stop matches the editor and SVG export.
		a := 1.0
		if srgb := asObj(colObj["srgb"]); srgb != nil {
			if av, present := srgb["a"]; present {
				a = clamp01(asNum(av))
			}
		}
		stops = append(stops, gradStop{pos: clamp01(asNum(so["position"])), col: c, a: a})
	}
	if len(stops) < 2 {
		return gradSpec{}
	}
	sort.SliceStable(stops, func(i, j int) bool { return stops[i].pos < stops[j].pos })
	g := gradSpec{ok: true, stops: stops, angle: asNum(fill["angle"]), cx: 0.5, cy: 0.5, radius: 0.5}
	if asStr(fill["gradient"]) == "radial" {
		g.radial = true
		if ctr := asObj(fill["center"]); ctr != nil {
			g.cx, g.cy = asNum(ctr["x"]), asNum(ctr["y"])
		}
		if r := asNum(fill["radius"]); r > 0 {
			g.radius = r
		}
	} else if asStr(fill["gradient"]) == "conic" {
		g.conic = true
		if ctr := asObj(fill["center"]); ctr != nil {
			g.cx, g.cy = asNum(ctr["x"]), asNum(ctr["y"])
		}
	}
	return g
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

func u8(v float64) uint8 {
	if v < 0 {
		v = 0
	}
	if v > 1 {
		v = 1
	}
	return uint8(math.Round(v * 255))
}

// colorAt returns the interpolated color at position t in [0,1]. NRGBA (NON-
// premultiplied) so a partly-transparent stop composites correctly - color.RGBA
// is premultiplied and would render a transparent stop as added color.
func (g gradSpec) colorAt(t float64) color.NRGBA {
	t = clamp01(t)
	if t <= g.stops[0].pos {
		s := g.stops[0]
		return color.NRGBA{R: u8(s.col.r), G: u8(s.col.g), B: u8(s.col.b), A: u8(s.a)}
	}
	last := g.stops[len(g.stops)-1]
	if t >= last.pos {
		return color.NRGBA{R: u8(last.col.r), G: u8(last.col.g), B: u8(last.col.b), A: u8(last.a)}
	}
	for i := 1; i < len(g.stops); i++ {
		s0, s1 := g.stops[i-1], g.stops[i]
		if t <= s1.pos {
			f := 0.0
			if span := s1.pos - s0.pos; span > 0 {
				f = (t - s0.pos) / span
			}
			return color.NRGBA{
				R: u8(s0.col.r + (s1.col.r-s0.col.r)*f),
				G: u8(s0.col.g + (s1.col.g-s0.col.g)*f),
				B: u8(s0.col.b + (s1.col.b-s0.col.b)*f),
				A: u8(s0.a + (s1.a-s0.a)*f),
			}
		}
	}
	return color.NRGBA{R: u8(last.col.r), G: u8(last.col.g), B: u8(last.col.b), A: u8(last.a)}
}

// gradientSrc is an image.Image that yields the gradient color at each device
// pixel, sampled by the rasterizer under the shape's coverage mask.
type gradientSrc struct {
	bounds image.Rectangle
	spec   gradSpec
	radial bool
	conic  bool
	// linear axis (device space)
	p0x, p0y, dx, dy, len2 float64
	// radial/conic frame (device space, objectBoundingBox)
	minX, minY, w, h float64
	startAngle       float64 // conic, radians
}

func (s *gradientSrc) ColorModel() color.Model { return color.NRGBAModel }
func (s *gradientSrc) Bounds() image.Rectangle { return s.bounds }
func (s *gradientSrc) At(x, y int) color.Color {
	var t float64
	if s.conic {
		if s.w == 0 || s.h == 0 {
			t = 0
		} else {
			cxp := s.minX + s.spec.cx*s.w
			cyp := s.minY + s.spec.cy*s.h
			// Canvas createConicGradient: angle measured clockwise from +x (y is
			// down), starting at startAngle; wrap into [0,1).
			tt := math.Mod(math.Atan2(float64(y)-cyp, float64(x)-cxp)-s.startAngle, 2*math.Pi)
			if tt < 0 {
				tt += 2 * math.Pi
			}
			t = tt / (2 * math.Pi)
		}
	} else if s.radial {
		if s.w == 0 || s.h == 0 || s.spec.radius <= 0 {
			t = 0
		} else {
			nx := (float64(x)-s.minX)/s.w - s.spec.cx
			ny := (float64(y)-s.minY)/s.h - s.spec.cy
			t = math.Hypot(nx, ny) / s.spec.radius
		}
	} else if s.len2 > 0 {
		t = ((float64(x)-s.p0x)*s.dx + (float64(y)-s.p0y)*s.dy) / s.len2
	}
	return s.spec.colorAt(t)
}

// source builds a device-space gradient sampler for a shape whose transformed
// polygon spans the bounding box bb=[minX,minY,maxX,maxY].
func (g gradSpec) source(bb [4]float64, bounds image.Rectangle) *gradientSrc {
	minX, minY, maxX, maxY := bb[0], bb[1], bb[2], bb[3]
	w, h := maxX-minX, maxY-minY
	src := &gradientSrc{bounds: bounds, spec: g, radial: g.radial, conic: g.conic, minX: minX, minY: minY, w: w, h: h, startAngle: g.angle * math.Pi / 180}
	if !g.radial && !g.conic {
		rad := g.angle * math.Pi / 180
		ddx, ddy := math.Cos(rad)*0.5, math.Sin(rad)*0.5
		src.p0x = minX + (0.5-ddx)*w
		src.p0y = minY + (0.5-ddy)*h
		p1x := minX + (0.5+ddx)*w
		p1y := minY + (0.5+ddy)*h
		src.dx, src.dy = p1x-src.p0x, p1y-src.p0y
		src.len2 = src.dx*src.dx + src.dy*src.dy
	}
	return src
}

func bboxOf(pts [][2]float64) [4]float64 {
	minX, minY := math.Inf(1), math.Inf(1)
	maxX, maxY := math.Inf(-1), math.Inf(-1)
	for _, p := range pts {
		minX = math.Min(minX, p[0])
		minY = math.Min(minY, p[1])
		maxX = math.Max(maxX, p[0])
		maxY = math.Max(maxY, p[1])
	}
	return [4]float64{minX, minY, maxX, maxY}
}
