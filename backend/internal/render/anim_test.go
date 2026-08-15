package render

import (
	"context"
	"fmt"
	"image/png"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestEvalEasingParity spot-checks the Go easing curves against the known
// closed-form values the TypeScript (@hc/engine animation.ts) produces, so the
// server posing matches the browser.
func TestEvalEasingParity(t *testing.T) {
	cases := []struct {
		easing string
		t, exp float64
	}{
		{"linear", 0.3, 0.3},
		{"ease-in", 0.5, 0.25},
		{"ease-out", 0.5, 0.75},
		{"ease-in-out", 0.25, 0.125},
		{"ease-in-cubic", 0.5, 0.125},
		{"ease-out-cubic", 0.5, 0.875},
	}
	for _, c := range cases {
		got := evalEasing(c.easing, c.t)
		if math.Abs(got-c.exp) > 1e-9 {
			t.Errorf("evalEasing(%q,%v)=%v want %v", c.easing, c.t, got, c.exp)
		}
	}
	// Boundary invariants shared by every curve.
	for _, e := range []string{"linear", "ease-in", "ease-out", "ease-in-out", "spring", "bounce", "ease-out-back"} {
		if v := evalEasing(e, 0); math.Abs(v) > 1e-9 {
			t.Errorf("%s at 0 = %v, want 0", e, v)
		}
		if v := evalEasing(e, 1); math.Abs(v-1) > 1e-9 {
			t.Errorf("%s at 1 = %v, want 1", e, v)
		}
	}
}

func nodeWithAnim(anim map[string]any) map[string]any {
	return map[string]any{
		"type":      "shape",
		"shape":     "rect",
		"opacity":   1.0,
		"transform": map[string]any{"x": 100.0, "y": 100.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 200.0, "height": 200.0},
		"animation": anim,
	}
}

// TestPoseEntranceFade: a fade entrance is invisible at t=0 and fully opaque
// once the clip's entrance duration has elapsed.
func TestPoseEntranceFade(t *testing.T) {
	node := nodeWithAnim(map[string]any{
		"entrance": map[string]any{"preset": "fade", "durationMs": 600.0, "delayMs": 0.0, "easing": "linear"},
	})
	at0 := PoseElementNode(node, 0, 5000)
	if op := numOr(at0, "opacity", 1); op > 1e-6 {
		t.Errorf("fade @t=0 opacity=%v, want ~0", op)
	}
	at600 := PoseElementNode(node, 600, 5000)
	if op := numOr(at600, "opacity", 0); math.Abs(op-1) > 1e-6 {
		t.Errorf("fade @t=600 opacity=%v, want 1", op)
	}
	// The original node is not mutated.
	if numOr(node, "opacity", -1) != 1 {
		t.Error("PoseElementNode mutated the input node")
	}
}

// TestPoseEntranceRise: at t=0 the element sits 48px below its resting y and is
// transparent; the offset resolves to 0 once settled.
func TestPoseEntranceRise(t *testing.T) {
	node := nodeWithAnim(map[string]any{
		"entrance": map[string]any{"preset": "rise", "durationMs": 500.0, "delayMs": 0.0, "easing": "linear"},
	})
	at0 := PoseElementNode(node, 0, 5000)
	tr, _ := at0["transform"].(map[string]any)
	if y := numOr(tr, "y", 0); math.Abs(y-148) > 1e-6 { // 100 resting + 48 offset
		t.Errorf("rise @t=0 y=%v, want 148", y)
	}
	settled := PoseElementNode(node, 500, 5000)
	tr2, _ := settled["transform"].(map[string]any)
	if y := numOr(tr2, "y", 0); math.Abs(y-100) > 1e-6 {
		t.Errorf("rise settled y=%v, want 100", y)
	}
}

// TestPoseKenBurns: image Ken Burns motion scales the node above 1 partway
// through its loop and returns to rest at the loop boundary.
func TestPoseKenBurns(t *testing.T) {
	node := map[string]any{
		"type":      "image",
		"opacity":   1.0,
		"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 200.0, "height": 200.0},
		"motion":    map[string]any{"kind": "kenburns", "intensity": 1.0},
	}
	if !NodeIsAnimated(node) {
		t.Fatal("NodeIsAnimated should be true for a node with motion")
	}
	mid := PoseElementNode(node, 6000, 12000) // half the 12s period
	tr, _ := mid["transform"].(map[string]any)
	if sx := numOr(tr, "scaleX", 1); sx <= 1.0 {
		t.Errorf("kenburns mid-loop scaleX=%v, want >1", sx)
	}
}

// TestPoseExitFadeOut: a fade-out exit is fully opaque before the tail window
// and transparent at the clip's end.
func TestPoseExitFadeOut(t *testing.T) {
	node := nodeWithAnim(map[string]any{
		"exit": map[string]any{"preset": "fade-out", "durationMs": 500.0, "delayMs": 0.0, "easing": "linear"},
	})
	clipMs := 3000.0
	early := PoseElementNode(node, 1000, clipMs)
	if op := numOr(early, "opacity", 0); math.Abs(op-1) > 1e-6 {
		t.Errorf("fade-out before tail opacity=%v, want 1", op)
	}
	end := PoseElementNode(node, clipMs, clipMs)
	if op := numOr(end, "opacity", 1); op > 1e-6 {
		t.Errorf("fade-out @clip end opacity=%v, want ~0", op)
	}
}

func TestNodeIsAnimatedFalse(t *testing.T) {
	node := map[string]any{"type": "shape", "transform": map[string]any{"x": 0.0}}
	if NodeIsAnimated(node) {
		t.Error("a plain node should not be animated")
	}
}

func TestSlideOverlayXY(t *testing.T) {
	// No slide edge -> plain x=0, y=0.
	plain := TimelineClip{ID: "a", StartFrame: 0, OutFrame: 60, Speed: 1}
	if x, y := slideOverlayXY(plain, 320, 240, 0, 2, 30); x != "0" || y != "0" {
		t.Errorf("no-slide (x,y) = (%q,%q), want (\"0\",\"0\")", x, y)
	}
	// Legacy slide-in (no direction) -> a time-gated x expression, y stays 0.
	in := TimelineClip{ID: "b", StartFrame: 0, OutFrame: 60, Speed: 1, TransitionIn: &TimelineTransition{Type: "slide", DurationFrames: 30}}
	x, y := slideOverlayXY(in, 320, 240, 0, 2, 30)
	if !strings.Contains(x, "if(lt(t") || !strings.Contains(x, "320.00") || y != "0" {
		t.Errorf("legacy slide-in (x,y) = (%q,%q), want a 320-wide x expr and y=0", x, y)
	}
	// Direction "up" moves along y, not x.
	up := TimelineClip{ID: "c", StartFrame: 0, OutFrame: 60, Speed: 1, TransitionIn: &TimelineTransition{Type: "slide", DurationFrames: 30, Direction: "up"}}
	x2, y2 := slideOverlayXY(up, 320, 240, 0, 2, 30)
	if x2 != "0" || !strings.Contains(y2, "if(lt(t") || !strings.Contains(y2, "240.00") {
		t.Errorf("slide-up (x,y) = (%q,%q), want x=0 and a 240-tall y expr", x2, y2)
	}
	// A fade edge contributes no slide.
	fade := TimelineClip{ID: "d", StartFrame: 0, OutFrame: 60, Speed: 1, TransitionIn: &TimelineTransition{Type: "fade", DurationFrames: 30}}
	if x, y := slideOverlayXY(fade, 320, 240, 0, 2, 30); x != "0" || y != "0" {
		t.Errorf("fade edge (x,y) = (%q,%q), want (\"0\",\"0\")", x, y)
	}
}

// TestRenderTimeline_AnimatedElementE2E stages a posed PNG sequence (as the
// export handler does) for a white full-stage rect with a fade entrance over a
// black base, then renders it and asserts the element is faded (dark) early and
// fully visible (white) later, proving the server MP4 animates the element.
// Skips when ffmpeg is absent.
func TestRenderTimeline_AnimatedElementE2E(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not available")
	}
	const W, H = 320.0, 240.0
	node := map[string]any{
		"type": "shape", "shape": "rect", "opacity": 1.0,
		"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": W, "height": H},
		"fills":     []any{map[string]any{"type": "solid", "color": map[string]any{"srgb": map[string]any{"r": 1.0, "g": 1.0, "b": 1.0, "a": 1.0}}}},
		"animation": map[string]any{"entrance": map[string]any{"preset": "fade", "durationMs": 500.0, "delayMs": 0.0, "easing": "linear"}},
	}
	dir := t.TempDir()
	seqDir := filepath.Join(dir, "seq")
	if err := os.MkdirAll(seqDir, 0o755); err != nil {
		t.Fatal(err)
	}
	const fps, frames = 30.0, 60 // 2s clip
	clipMs := float64(frames) / fps * 1000
	for i := 0; i < frames; i++ {
		posed := PoseElementNode(node, float64(i)/fps*1000, clipMs)
		b, err := ToElementPNG(Design{"pages": []any{map[string]any{"width": W, "height": H, "children": []any{posed}}}}, 0, 1)
		if err != nil || len(b) == 0 {
			t.Fatalf("raster frame %d: %v", i, err)
		}
		if err := os.WriteFile(filepath.Join(seqDir, fmt.Sprintf("f_%05d.png", i)), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	p := &TimelineProject{}
	p.Stage.Width = W
	p.Stage.Height = H
	p.Fps = fps
	p.Tracks = []TimelineTrack{{ID: "ov1", Kind: "overlay", Clips: []TimelineClip{{ID: "e1", StartFrame: 0, InFrame: 0, OutFrame: 60, Speed: 1, Element: node}}}}
	opts := TimelineOptions{ElementSeqs: map[string]ElementSeq{"e1": {Pattern: filepath.Join(seqDir, "f_%05d.png"), Frames: frames, Fps: fps}}}
	out, err := RenderTimeline(context.Background(), p, func(string) (StagedAsset, bool) { return StagedAsset{}, false }, opts)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	mp4 := filepath.Join(dir, "out.mp4")
	if err := os.WriteFile(mp4, out, 0o644); err != nil {
		t.Fatal(err)
	}
	centerLuma := func(ss string) uint32 {
		fp := filepath.Join(dir, "fr-"+ss+".png")
		if err := exec.Command("ffmpeg", "-y", "-ss", ss, "-i", mp4, "-frames:v", "1", fp).Run(); err != nil {
			t.Fatalf("extract %s: %v", ss, err)
		}
		f, err := os.Open(fp)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		img, err := png.Decode(f)
		if err != nil {
			t.Fatalf("decode %s: %v", ss, err)
		}
		b := img.Bounds()
		r, _, _, _ := img.At(b.Dx()/2, b.Dy()/2).RGBA()
		return r
	}
	early := centerLuma("0.0") // t~0: fade opacity ~0 -> black base
	late := centerLuma("1.0")  // t=1s: fully opaque -> white
	if early > 0x6000 {
		t.Errorf("early frame center not dark (fade entrance not applied): r=%x", early)
	}
	if late < 0xe000 {
		t.Errorf("late frame center not white (element missing): r=%x", late)
	}
	if late <= early {
		t.Errorf("expected fade-in (late brighter than early): early=%x late=%x", early, late)
	}
}

// TestRenderTimeline_SlideTransitionE2E confirms a SLIDE clip transition MOVES
// the element (rather than fading it): a full-stage white element sliding in from
// the left, sampled mid-transition, is white on the left and black (uncovered
// base) on the right; once settled the whole stage is white. Skips without ffmpeg.
func TestRenderTimeline_SlideTransitionE2E(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not available")
	}
	const W, H = 320.0, 240.0
	node := map[string]any{
		"type": "shape", "shape": "rect", "opacity": 1.0,
		"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": W, "height": H},
		"fills":     []any{map[string]any{"type": "solid", "color": map[string]any{"srgb": map[string]any{"r": 1.0, "g": 1.0, "b": 1.0, "a": 1.0}}}},
	}
	dir := t.TempDir()
	imgBytes, err := ToElementPNG(Design{"pages": []any{map[string]any{"width": W, "height": H, "children": []any{node}}}}, 0, 1)
	if err != nil || len(imgBytes) == 0 {
		t.Fatalf("raster element: %v", err)
	}
	pngPath := filepath.Join(dir, "slide.png")
	if err := os.WriteFile(pngPath, imgBytes, 0o644); err != nil {
		t.Fatal(err)
	}
	p := &TimelineProject{}
	p.Stage.Width = W
	p.Stage.Height = H
	p.Fps = 30
	p.Tracks = []TimelineTrack{{ID: "ov1", Kind: "overlay", Clips: []TimelineClip{{
		ID: "e1", StartFrame: 0, InFrame: 0, OutFrame: 60, Speed: 1, Element: node,
		TransitionIn: &TimelineTransition{Type: "slide", DurationFrames: 30}, // 1s slide-in
	}}}}
	opts := TimelineOptions{ElementFiles: map[string]string{"e1": pngPath}}
	out, err := RenderTimeline(context.Background(), p, func(string) (StagedAsset, bool) { return StagedAsset{}, false }, opts)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	mp4 := filepath.Join(dir, "out.mp4")
	if err := os.WriteFile(mp4, out, 0o644); err != nil {
		t.Fatal(err)
	}
	sample := func(ss string, fx int) uint32 {
		fp := filepath.Join(dir, "s-"+ss+".png")
		if err := exec.Command("ffmpeg", "-y", "-ss", ss, "-i", mp4, "-frames:v", "1", fp).Run(); err != nil {
			t.Fatalf("extract %s: %v", ss, err)
		}
		f, err := os.Open(fp)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		img, err := png.Decode(f)
		if err != nil {
			t.Fatalf("decode %s: %v", ss, err)
		}
		r, _, _, _ := img.At(fx, img.Bounds().Dy()/2).RGBA()
		return r
	}
	// Mid slide-in (t=0.5s, p~0.5): clip shifted left by ~0.5*W, so the left
	// quarter is white and the right quarter is uncovered black base.
	leftMid := sample("0.5", int(W)/4)
	rightMid := sample("0.5", int(W)*3/4)
	if leftMid < 0xc000 {
		t.Errorf("mid slide left quarter not white: r=%x", leftMid)
	}
	if rightMid > 0x6000 {
		t.Errorf("mid slide right quarter not dark (slide behaved like a fade): r=%x", rightMid)
	}
	// Settled (t=1.5s): the whole stage is white.
	if v := sample("1.5", int(W)*3/4); v < 0xe000 {
		t.Errorf("settled slide right quarter not white: r=%x", v)
	}
}

// TestRenderTimeline_SlideDirectionE2E confirms a directional (top) slide moves
// the element along Y: a full-stage white element sliding in from the top is,
// mid-transition, white in the top band and black (base) in the bottom band.
func TestRenderTimeline_SlideDirectionE2E(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not available")
	}
	const W, H = 320.0, 240.0
	node := map[string]any{
		"type": "shape", "shape": "rect", "opacity": 1.0,
		"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": W, "height": H},
		"fills":     []any{map[string]any{"type": "solid", "color": map[string]any{"srgb": map[string]any{"r": 1.0, "g": 1.0, "b": 1.0, "a": 1.0}}}},
	}
	dir := t.TempDir()
	imgBytes, err := ToElementPNG(Design{"pages": []any{map[string]any{"width": W, "height": H, "children": []any{node}}}}, 0, 1)
	if err != nil || len(imgBytes) == 0 {
		t.Fatalf("raster: %v", err)
	}
	pngPath := filepath.Join(dir, "slide.png")
	if err := os.WriteFile(pngPath, imgBytes, 0o644); err != nil {
		t.Fatal(err)
	}
	p := &TimelineProject{}
	p.Stage.Width = W
	p.Stage.Height = H
	p.Fps = 30
	p.Tracks = []TimelineTrack{{ID: "ov1", Kind: "overlay", Clips: []TimelineClip{{
		ID: "e1", StartFrame: 0, InFrame: 0, OutFrame: 60, Speed: 1, Element: node,
		TransitionIn: &TimelineTransition{Type: "slide", DurationFrames: 30, Direction: "up"},
	}}}}
	out, err := RenderTimeline(context.Background(), p, func(string) (StagedAsset, bool) { return StagedAsset{}, false }, TimelineOptions{ElementFiles: map[string]string{"e1": pngPath}})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	mp4 := filepath.Join(dir, "out.mp4")
	if err := os.WriteFile(mp4, out, 0o644); err != nil {
		t.Fatal(err)
	}
	at := func(ss string, fy int) uint32 {
		fp := filepath.Join(dir, "d-"+ss+".png")
		if err := exec.Command("ffmpeg", "-y", "-ss", ss, "-i", mp4, "-frames:v", "1", fp).Run(); err != nil {
			t.Fatalf("extract: %v", err)
		}
		f, err := os.Open(fp)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		img, err := png.Decode(f)
		if err != nil {
			t.Fatalf("decode: %v", err)
		}
		r, _, _, _ := img.At(img.Bounds().Dx()/2, fy).RGBA()
		return r
	}
	topMid := at("0.5", int(H)/4)
	botMid := at("0.5", int(H)*3/4)
	if topMid < 0xc000 {
		t.Errorf("mid slide-up top band not white: r=%x", topMid)
	}
	if botMid > 0x6000 {
		t.Errorf("mid slide-up bottom band not dark (Y slide not applied): r=%x", botMid)
	}
}
