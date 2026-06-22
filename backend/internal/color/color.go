// Package color ports the @hc/color perceptual primitives the backend needs:
// sRGB -> CIE Lab conversion and the CIE76 deltaE distance, used by the brand
// lock to tell an in-kit color from a genuinely off-brand one (tolerating
// serialization rounding). Inputs are sRGB components in 0..1.
package color

import "math"

// D65 white point (scaled to 100), matching @hc/color.
const (
	xn = 95.047
	yn = 100.0
	zn = 108.883
)

func lin(v float64) float64 {
	if v <= 0.04045 {
		return v / 12.92
	}
	return math.Pow((v+0.055)/1.055, 2.4)
}

func pivot(t float64) float64 {
	if t > 0.008856 {
		return math.Cbrt(t)
	}
	return 7.787*t + 16.0/116.0
}

// Lab is a CIE L*a*b* color.
type Lab struct{ L, A, B float64 }

// RGBToLab converts an sRGB color (components 0..1) to CIE Lab (D65).
func RGBToLab(r, g, b float64) Lab {
	rl, gl, bl := lin(r), lin(g), lin(b)
	x := (rl*0.4124564 + gl*0.3575761 + bl*0.1804375) * 100
	y := (rl*0.2126729 + gl*0.7151522 + bl*0.072175) * 100
	z := (rl*0.0193339 + gl*0.119192 + bl*0.9503041) * 100
	fx, fy, fz := pivot(x/xn), pivot(y/yn), pivot(z/zn)
	return Lab{L: 116*fy - 16, A: 500 * (fx - fy), B: 200 * (fy - fz)}
}

// DeltaE is the CIE76 perceptual distance between two sRGB colors (0..1).
func DeltaE(r1, g1, b1, r2, g2, b2 float64) float64 {
	a := RGBToLab(r1, g1, b1)
	c := RGBToLab(r2, g2, b2)
	dl, da, db := a.L-c.L, a.A-c.A, a.B-c.B
	return math.Sqrt(dl*dl + da*da + db*db)
}

// relLuminance is the WCAG relative luminance of an sRGB color (components 0..1).
func relLuminance(r, g, b float64) float64 {
	lin := func(c float64) float64 {
		if c <= 0.03928 {
			return c / 12.92
		}
		return math.Pow((c+0.055)/1.055, 2.4)
	}
	return 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b)
}

// ContrastRatio is the WCAG 2.x contrast ratio between two sRGB colors (1..21).
func ContrastRatio(r1, g1, b1, r2, g2, b2 float64) float64 {
	l1 := relLuminance(r1, g1, b1)
	l2 := relLuminance(r2, g2, b2)
	if l1 < l2 {
		l1, l2 = l2, l1
	}
	return (l1 + 0.05) / (l2 + 0.05)
}
