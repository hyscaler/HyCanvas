package brand

import (
	"math"

	"hycanvas/backend/internal/color"
)

// What counts as a brand colour.
//
// A kit lists swatches; a design uses far more colours than that: the tint
// a panel is filled with, the muted ink of a caption, the two stops of a
// gradient, the shade a rule is drawn in. Every one of them is a blend of
// swatches, or of a swatch with white or black, and a brand guide calls
// them the brand's. Matching each colour against the swatches alone flagged
// 105 of them on one eight-page deck the composer built from a four-colour
// kit, and with the colour lock on it would have refused a member's save.
//
// The brand's colour space is therefore every swatch, every straight blend
// of two members of the extended palette (swatches, white, black), and
// every blend of three: the closest point on any of those triangles, in
// sRGB, judged by the same perceptual distance as a swatch match but with a
// wider tolerance, since a derived tint is not a swatch and the eye reads
// it as the brand's anyway.

// blendTolerance is the deltaE within which a colour counts as a tint, shade
// or blend of approved colours.
const blendTolerance = 5.0

var (
	brandWhite = rgb{1, 1, 1}
	brandBlack = rgb{0, 0, 0}
)

// onBrandDistance returns the perceptual distance from c to the brand's colour
// space: zero for a swatch, small for a tint, shade or blend, large for a
// foreign hue.
func onBrandDistance(c rgb, palette []rgb) float64 {
	best := math.Inf(1)
	dist := func(p rgb) {
		if d := color.DeltaE(c.r, c.g, c.b, p.r, p.g, p.b); d < best {
			best = d
		}
	}
	for _, p := range palette {
		dist(p)
	}
	if best <= colorTolerance {
		return best
	}
	ext := make([]rgb, 0, len(palette)+2)
	ext = append(ext, palette...)
	ext = append(ext, brandWhite, brandBlack)
	n := len(ext)
	for i := 0; i < n; i++ {
		for j := i + 1; j < n; j++ {
			dist(closestOnSegment(c, ext[i], ext[j]))
			for k := j + 1; k < n; k++ {
				dist(closestOnTriangle(c, ext[i], ext[j], ext[k]))
			}
		}
	}
	return best
}

// onBrand reports whether c is a swatch or a tint, shade or blend of swatches.
func onBrand(c rgb, palette []rgb) bool {
	return onBrandDistance(c, palette) <= blendTolerance
}

func sub(a, b rgb) rgb             { return rgb{a.r - b.r, a.g - b.g, a.b - b.b} }
func add(a, b rgb) rgb             { return rgb{a.r + b.r, a.g + b.g, a.b + b.b} }
func scale(a rgb, t float64) rgb   { return rgb{a.r * t, a.g * t, a.b * t} }
func dot(a, b rgb) float64         { return a.r*b.r + a.g*b.g + a.b*b.b }
func lerp(a, b rgb, t float64) rgb { return add(a, scale(sub(b, a), t)) }

// closestOnSegment is the point of segment ab nearest p.
func closestOnSegment(p, a, b rgb) rgb {
	ab := sub(b, a)
	den := dot(ab, ab)
	if den == 0 {
		return a
	}
	t := dot(sub(p, a), ab) / den
	if t < 0 {
		t = 0
	} else if t > 1 {
		t = 1
	}
	return lerp(a, b, t)
}

// closestOnTriangle is the point of triangle abc nearest p (Ericson,
// Real-Time Collision Detection, 5.1.5).
func closestOnTriangle(p, a, b, c rgb) rgb {
	ab := sub(b, a)
	ac := sub(c, a)
	ap := sub(p, a)
	d1 := dot(ab, ap)
	d2 := dot(ac, ap)
	if d1 <= 0 && d2 <= 0 {
		return a
	}
	bp := sub(p, b)
	d3 := dot(ab, bp)
	d4 := dot(ac, bp)
	if d3 >= 0 && d4 <= d3 {
		return b
	}
	vc := d1*d4 - d3*d2
	if vc <= 0 && d1 >= 0 && d3 <= 0 {
		den := d1 - d3
		if den == 0 {
			return a
		}
		return add(a, scale(ab, d1/den))
	}
	cp := sub(p, c)
	d5 := dot(ab, cp)
	d6 := dot(ac, cp)
	if d6 >= 0 && d5 <= d6 {
		return c
	}
	vb := d5*d2 - d1*d6
	if vb <= 0 && d2 >= 0 && d6 <= 0 {
		den := d2 - d6
		if den == 0 {
			return a
		}
		return add(a, scale(ac, d2/den))
	}
	va := d3*d6 - d5*d4
	if va <= 0 && (d4-d3) >= 0 && (d5-d6) >= 0 {
		den := (d4 - d3) + (d5 - d6)
		if den == 0 {
			return b
		}
		return add(b, scale(sub(c, b), (d4-d3)/den))
	}
	den := va + vb + vc
	if den == 0 {
		return a
	}
	v := vb / den
	w := vc / den
	return add(a, add(scale(ab, v), scale(ac, w)))
}
