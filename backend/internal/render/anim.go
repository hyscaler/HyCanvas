package render

// Server-side port of the browser animation math (@hc/engine `animation.ts` +
// `pose.ts`), so the ffmpeg MP4 export animates footage-free design elements
// exactly like the browser preview and the exact in-browser export. A clip's
// element node is posed per output frame (entrance -> emphasis + image motion,
// with an exit over the clip's tail), the transform/opacity baked into the node,
// then rasterized to a PNG sequence the timeline graph overlays. Keep these
// formulas byte-for-byte aligned with the TypeScript so the three render paths
// agree; see docs/roadmap/video-design-mode.md (P4.2).

import (
	"encoding/json"
	"math"
)

type animPatch struct {
	dx, dy, scale, rotate, opacityMul float64
}

var identityPatch = animPatch{dx: 0, dy: 0, scale: 1, rotate: 0, opacityMul: 1}

// clamp01 is defined in gradient.go (same package).

const tau = math.Pi * 2

// evalEasing mirrors animation.ts evalEasing.
func evalEasing(easing string, t float64) float64 {
	x := clamp01(t)
	switch easing {
	case "linear":
		return x
	case "ease-in":
		return x * x
	case "ease-out":
		return 1 - (1-x)*(1-x)
	case "ease-in-out":
		if x < 0.5 {
			return 2 * x * x
		}
		return 1 - math.Pow(-2*x+2, 2)/2
	case "ease-in-cubic":
		return x * x * x
	case "ease-out-cubic":
		return 1 - math.Pow(1-x, 3)
	case "ease-out-back":
		c1 := 1.70158
		c3 := c1 + 1
		return 1 + c3*math.Pow(x-1, 3) + c1*math.Pow(x-1, 2)
	case "bounce":
		n1 := 7.5625
		d1 := 2.75
		tt := x
		if tt < 1/d1 {
			return n1 * tt * tt
		}
		if tt < 2/d1 {
			tt -= 1.5 / d1
			return n1*tt*tt + 0.75
		}
		if tt < 2.5/d1 {
			tt -= 2.25 / d1
			return n1*tt*tt + 0.9375
		}
		tt -= 2.625 / d1
		return n1*tt*tt + 0.984375
	case "spring":
		if x >= 1 {
			return 1
		}
		omega := 8.0
		zeta := 0.32
		wd := omega * math.Sqrt(1-zeta*zeta)
		env := math.Exp(-zeta * omega * x)
		return 1 - env*(math.Cos(wd*x)+((zeta*omega)/wd)*math.Sin(wd*x))
	default:
		return x
	}
}

// cubicBezierEase mirrors animation.ts cubicBezierEase.
func cubicBezierEase(x, x1, y1, x2, y2 float64) float64 {
	xc := clamp01(x)
	cx := 3 * x1
	bx := 3*(x2-x1) - cx
	ax := 1 - cx - bx
	cy := 3 * y1
	by := 3*(y2-y1) - cy
	ay := 1 - cy - by
	sampleX := func(t float64) float64 { return ((ax*t+bx)*t + cx) * t }
	sampleDX := func(t float64) float64 { return (3*ax*t+2*bx)*t + cx }
	t := xc
	for i := 0; i < 8; i++ {
		dx := sampleX(t) - xc
		if math.Abs(dx) < 1e-5 {
			break
		}
		d := sampleDX(t)
		if math.Abs(d) < 1e-6 {
			break
		}
		t -= dx / d
	}
	if t < 0 || t > 1 {
		lo, hi := 0.0, 1.0
		t = xc
		for i := 0; i < 20; i++ {
			xv := sampleX(t)
			if math.Abs(xv-xc) < 1e-5 {
				break
			}
			if xv < xc {
				lo = t
			} else {
				hi = t
			}
			t = (lo + hi) / 2
		}
	}
	return ((ay*t+by)*t + cy) * t
}

// animClip is a parsed entrance/exit/emphasis clip off a node's animation map.
type animClip struct {
	preset     string
	durationMs float64
	delayMs    float64
	easing     string
	bezier     []float64
}

func (c animClip) ease(t float64) float64 {
	if len(c.bezier) == 4 {
		return cubicBezierEase(t, c.bezier[0], c.bezier[1], c.bezier[2], c.bezier[3])
	}
	return evalEasing(c.easing, t)
}

// clipProgress returns (progress in [0,1], started). started=false before delay.
func (c animClip) progress(tMs float64) (float64, bool) {
	if tMs < c.delayMs {
		return 0, false
	}
	dur := math.Max(1, c.durationMs)
	return clamp01((tMs - c.delayMs) / dur), true
}

func (c animClip) end() float64 { return c.delayMs + math.Max(0, c.durationMs) }

func entrancePatch(c animClip, tMs float64) animPatch {
	raw, ok := c.progress(tMs)
	e := 0.0
	if ok {
		e = c.ease(raw)
	}
	inv := 1 - e
	switch c.preset {
	case "fade":
		return animPatch{0, 0, 1, 0, e}
	case "rise":
		return animPatch{0, inv * 48, 1, 0, e}
	case "pan":
		return animPatch{inv * 80, 0, 1, 0, e}
	case "pop":
		return animPatch{0, 0, 0.6 + 0.4*e, 0, e}
	case "drift":
		return animPatch{inv * 24, inv * -24, 0.96 + 0.04*e, 0, e}
	case "breathe-in":
		return animPatch{0, 0, 1.12 - 0.12*e, 0, e}
	case "typewriter", "word-wipe":
		// Content reveal is handled by the rasterizer's text path; node stays put.
		return identityPatch
	case "tumble":
		return animPatch{0, inv * 32, 0.7 + 0.3*e, -180 * inv, e}
	case "stomp":
		return animPatch{0, 0, 1.6 - 0.6*e, 0, e}
	case "zoom-in":
		return animPatch{0, 0, 0.2 + 0.8*e, 0, e}
	default:
		return identityPatch
	}
}

func exitPatch(c animClip, tMs float64) animPatch {
	raw, ok := c.progress(tMs)
	e := 0.0
	if ok {
		e = c.ease(raw)
	}
	switch c.preset {
	case "fade-out":
		return animPatch{0, 0, 1, 0, 1 - e}
	case "sink":
		return animPatch{0, e * 48, 1, 0, 1 - e}
	case "pop-out":
		return animPatch{0, 0, 1 - 0.4*e, 0, 1 - e}
	case "drift-out":
		return animPatch{e * 24, e * -24, 1 - 0.04*e, 0, 1 - e}
	case "tumble-out":
		return animPatch{0, e * 32, 1 - 0.3*e, 180 * e, 1 - e}
	case "zoom-out":
		return animPatch{0, 0, 1 - 0.8*e, 0, 1 - e}
	default:
		return identityPatch
	}
}

func emphasisPatch(c animClip, tMs float64) animPatch {
	period := math.Max(1, c.durationMs)
	cycle := period + c.delayMs
	local := math.Mod(math.Mod(tMs, cycle)+cycle, cycle)
	if local < c.delayMs {
		return identityPatch
	}
	p := (local - c.delayMs) / period
	sine := math.Sin(p * tau)
	switch c.preset {
	case "pulse":
		s := 1 + 0.08*math.Sin(p*math.Pi)
		return animPatch{0, 0, s, 0, 1}
	case "wiggle":
		return animPatch{0, 0, 1, 6 * sine, 1}
	case "spin":
		return animPatch{0, 0, 1, 360 * p, 1}
	case "breathe":
		s := 1 + 0.06*math.Sin(p*math.Pi)
		return animPatch{0, 0, s, 0, 0.85 + 0.15*math.Sin(p*math.Pi)}
	case "tada":
		s := 1 + 0.1*math.Sin(p*math.Pi)
		return animPatch{0, 0, s, 4 * math.Sin(p*tau*3), 1}
	case "flicker":
		return animPatch{0, 0, 1, 0, 0.4 + 0.6*math.Abs(math.Sin(p*tau*2))}
	case "jiggle":
		return animPatch{5 * math.Sin(p*tau*3), 0, 1, 0, 1}
	case "bob":
		return animPatch{0, -6 * math.Sin(p*math.Pi), 1, 0, 1}
	default:
		return identityPatch
	}
}

// imageMotionPatch mirrors animation.ts imageMotionPatch (default period 12s).
func imageMotionPatch(kind string, intensity, tMs, periodMs float64) animPatch {
	if periodMs <= 0 {
		periodMs = 12000
	}
	k := clamp01(intensity)
	p := math.Mod(math.Mod(tMs, periodMs)+periodMs, periodMs) / periodMs
	wave := math.Sin(p * tau)
	if kind == "kenburns" {
		scale := 1 + 0.12*k*math.Sin(p*math.Pi)
		return animPatch{18 * k * wave, 10 * k * (1 - math.Cos(p*tau)) / 2, scale, 0, 1}
	}
	return animPatch{28 * k * wave, 0, 1 + 0.04*k, 0, 1}
}

func composePatch(a, b animPatch) animPatch {
	return animPatch{
		dx:         a.dx + b.dx,
		dy:         a.dy + b.dy,
		scale:      a.scale * b.scale,
		rotate:     a.rotate + b.rotate,
		opacityMul: a.opacityMul * b.opacityMul,
	}
}

// --- node-map helpers -------------------------------------------------------

func numOr(m map[string]any, key string, def float64) float64 {
	if v, ok := m[key].(float64); ok {
		return v
	}
	return def
}

// parseClip reads an entrance/exit/emphasis sub-map into an animClip.
func parseClip(anim map[string]any, key string) (animClip, bool) {
	raw, ok := anim[key].(map[string]any)
	if !ok {
		return animClip{}, false
	}
	preset, _ := raw["preset"].(string)
	if preset == "" {
		return animClip{}, false
	}
	easing, _ := raw["easing"].(string)
	if easing == "" {
		easing = "linear"
	}
	c := animClip{
		preset:     preset,
		durationMs: numOr(raw, "durationMs", 0),
		delayMs:    numOr(raw, "delayMs", 0),
		easing:     easing,
	}
	if bz, ok := raw["bezier"].([]any); ok && len(bz) == 4 {
		c.bezier = make([]float64, 4)
		for i, v := range bz {
			if f, ok := v.(float64); ok {
				c.bezier[i] = f
			}
		}
	}
	return c, true
}

// nodeIsAnimated reports whether a node map carries animation or image motion.
func NodeIsAnimated(node map[string]any) bool {
	if _, ok := node["animation"].(map[string]any); ok {
		return true
	}
	if _, ok := node["motion"].(map[string]any); ok {
		return true
	}
	return false
}

// applyPatchToNode bakes a patch into a node map's transform + opacity, mirroring
// pose.ts applyPatch (x/y offset, scaleX/scaleY multiply, rotation add, opacity
// multiply clamped to [0,1] against the resting opacity ceiling).
func applyPatchToNode(node map[string]any, p animPatch) {
	base := numOr(node, "opacity", 1)
	node["opacity"] = clamp01(base * p.opacityMul)
	tr, _ := node["transform"].(map[string]any)
	if tr == nil {
		tr = map[string]any{}
	}
	nt := map[string]any{}
	for k, v := range tr {
		nt[k] = v
	}
	nt["x"] = numOr(tr, "x", 0) + p.dx
	nt["y"] = numOr(tr, "y", 0) + p.dy
	nt["scaleX"] = numOr(tr, "scaleX", 1) * p.scale
	nt["scaleY"] = numOr(tr, "scaleY", 1) * p.scale
	nt["rotation"] = numOr(tr, "rotation", 0) + p.rotate
	node["transform"] = nt
}

// poseElementNode returns a deep copy of the element node posed at clip-local
// time tMs (ms). Mirrors pose.ts poseDesignAt (entrance until its end, else
// emphasis, else the settled entrance; plus image motion), then layers the exit
// over the clip's final exit-duration window (matching the video preview's
// posedElementFile). clipMs is the clip's total duration in ms (0 disables exit).
func PoseElementNode(node map[string]any, tMs, clipMs float64) map[string]any {
	buf, err := json.Marshal(node)
	if err != nil {
		return node
	}
	var clone map[string]any
	if err := json.Unmarshal(buf, &clone); err != nil {
		return node
	}
	anim, _ := clone["animation"].(map[string]any)
	var patch animPatch
	have := false

	entrance, hasEnt := animClip{}, false
	if anim != nil {
		entrance, hasEnt = parseClip(anim, "entrance")
	}
	entEnd := 0.0
	if hasEnt {
		entEnd = entrance.end()
	}
	if hasEnt && tMs <= entEnd {
		patch, have = entrancePatch(entrance, tMs), true
	} else if emphasis, ok := parseClip(orEmpty(anim), "emphasis"); ok {
		patch, have = emphasisPatch(emphasis, tMs-entEnd), true
	} else if hasEnt {
		patch, have = entrancePatch(entrance, entEnd), true
	}

	// Image Ken Burns / parallax composes on top and loops for the whole clip.
	if motion, ok := clone["motion"].(map[string]any); ok {
		kind, _ := motion["kind"].(string)
		if kind != "" {
			mp := imageMotionPatch(kind, numOr(motion, "intensity", 0), tMs, 0)
			if have {
				patch = composePatch(patch, mp)
			} else {
				patch, have = mp, true
			}
		}
	}

	// Exit over the clip's tail (the slide-oriented poser omits exit).
	if exit, ok := parseClip(orEmpty(anim), "exit"); ok && clipMs > 0 {
		exitStart := math.Max(0, clipMs-exit.end())
		if tMs >= exitStart {
			ep := exitPatch(exit, tMs-exitStart)
			if have {
				patch = composePatch(patch, ep)
			} else {
				patch, have = ep, true
			}
		}
	}

	if have {
		applyPatchToNode(clone, patch)
	}
	return clone
}

func orEmpty(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}
