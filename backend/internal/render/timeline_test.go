package render

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func timelineFixture() *TimelineProject {
	p := &TimelineProject{}
	p.Stage.Width = 640
	p.Stage.Height = 360
	p.Fps = 30
	p.DurationFrames = 120
	p.Master.GainDb = 0
	p.Tracks = []TimelineTrack{
		{
			ID: "v1", Kind: "video",
			Clips: []TimelineClip{{
				ID: "c1", AssetID: "vid", StartFrame: 0, InFrame: 0, OutFrame: 90, Speed: 1,
				TransitionOut: &TimelineTransition{Type: "fade", DurationFrames: 15},
			}},
		},
		{
			ID: "a1", Kind: "audio",
			Clips: []TimelineClip{{
				ID: "c2", AssetID: "aud", StartFrame: 0, InFrame: 0, OutFrame: 120, Speed: 1,
				FadeOutFrames: 30, AudioGainDb: -6,
			}},
		},
		{
			ID: "t1", Kind: "text",
			Clips: []TimelineClip{{
				ID: "c3", StartFrame: 0, InFrame: 0, OutFrame: 60, Speed: 1,
				Title: &TimelineTitle{Text: "Hello: it's 100%", Position: "lower-third"},
			}},
		},
	}
	p.Captions = []TimelineCaptions{{
		Style: map[string]any{"burnIn": true},
		Cues:  []TimelineCue{{StartFrame: 0, EndFrame: 60, Text: "A caption"}},
	}}
	return p
}

func fixtureAssets(t *testing.T) func(string) (StagedAsset, bool) {
	t.Helper()
	return func(assetID string) (StagedAsset, bool) {
		switch assetID {
		case "vid":
			return StagedAsset{Path: "/tmp/vid.mp4", HasVideo: true, HasAudio: true}, true
		case "aud":
			return StagedAsset{Path: "/tmp/aud.mp3", HasVideo: false, HasAudio: true}, true
		}
		return StagedAsset{}, false
	}
}

// TestRenderTimeline_ElementE2E renders a footage-free white-background element
// clip all the way to MP4 and confirms a decoded frame is actually white, i.e.
// the element composited (not a black video). Skips when ffmpeg is absent.
func TestRenderTimeline_ElementE2E(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not available")
	}
	node := map[string]any{
		"type": "shape", "shape": "rect",
		"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 320.0, "height": 240.0},
		"fills":     []any{map[string]any{"type": "solid", "color": map[string]any{"srgb": map[string]any{"r": 1.0, "g": 1.0, "b": 1.0, "a": 1.0}}}},
	}
	dir := t.TempDir()
	imgBytes, err := ToPNG(Design{"pages": []any{map[string]any{"width": 320.0, "height": 240.0, "children": []any{node}}}}, 0, 1)
	if err != nil || len(imgBytes) == 0 {
		t.Fatalf("raster element: %v", err)
	}
	pngPath := filepath.Join(dir, "element-e1.png")
	if err := os.WriteFile(pngPath, imgBytes, 0o644); err != nil {
		t.Fatal(err)
	}
	p := &TimelineProject{}
	p.Stage.Width = 320
	p.Stage.Height = 240
	p.Fps = 30
	p.Tracks = []TimelineTrack{{
		ID: "ov1", Kind: "overlay",
		Clips: []TimelineClip{{ID: "e1", StartFrame: 0, InFrame: 0, OutFrame: 30, Speed: 1, Element: node}},
	}}
	opts := TimelineOptions{ElementFiles: map[string]string{"e1": pngPath}}
	out, err := RenderTimeline(context.Background(), p, func(string) (StagedAsset, bool) { return StagedAsset{}, false }, opts)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if len(out) < 1000 {
		t.Fatalf("output too small (%d bytes)", len(out))
	}
	mp4 := filepath.Join(dir, "out.mp4")
	if err := os.WriteFile(mp4, out, 0o644); err != nil {
		t.Fatal(err)
	}
	frame := filepath.Join(dir, "frame.png")
	if err := exec.Command("ffmpeg", "-y", "-ss", "0.5", "-i", mp4, "-frames:v", "1", frame).Run(); err != nil {
		t.Fatalf("extract frame: %v", err)
	}
	f, err := os.Open(frame)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		t.Fatalf("decode frame: %v", err)
	}
	b := img.Bounds()
	r, g, bl, _ := img.At(b.Dx()/2, b.Dy()/2).RGBA()
	if r < 0xe000 || g < 0xe000 || bl < 0xe000 {
		t.Fatalf("center pixel not white (element did not composite): r=%x g=%x b=%x", r, g, bl)
	}
}

// TestRasterTextElement confirms the Go rasterizer draws a text element node to
// visible (dark) pixels, so a text element clip composites in the server export
// (the element->PNG->overlay pipeline itself is covered by the E2E test above).
func TestRasterTextElement(t *testing.T) {
	node := map[string]any{
		"type":      "text",
		"transform": map[string]any{"x": 10.0, "y": 30.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 300.0, "height": 60.0},
		"box":       map[string]any{"mode": "fixed", "width": 300.0, "height": 60.0, "verticalAlign": "middle", "autoFit": map[string]any{"enabled": false, "min": 8.0, "max": 512.0}},
		"content": []any{map[string]any{
			"runs":  []any{map[string]any{"text": "HELLO", "style": map[string]any{"fontFamily": "system", "fontStyle": "Regular", "fontSize": 48.0, "fill": map[string]any{"type": "solid", "color": map[string]any{"srgb": map[string]any{"r": 0.0, "g": 0.0, "b": 0.0, "a": 1.0}}}}}},
			"style": map[string]any{"align": "center", "direction": "auto"},
		}},
	}
	imgBytes, err := ToPNG(Design{"pages": []any{map[string]any{"width": 320.0, "height": 120.0, "children": []any{node}, "background": map[string]any{"type": "solid", "color": map[string]any{"srgb": map[string]any{"r": 1.0, "g": 1.0, "b": 1.0, "a": 1.0}}}}}}, 0, 1)
	if err != nil || len(imgBytes) == 0 {
		t.Fatalf("raster text: %v", err)
	}
	img, err := png.Decode(strings.NewReader(string(imgBytes)))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	dark := 0
	b := img.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			r, g, bl, _ := img.At(x, y).RGBA()
			if r < 0x4000 && g < 0x4000 && bl < 0x4000 {
				dark++
			}
		}
	}
	if dark < 50 {
		t.Fatalf("text element rendered too few dark pixels (%d); text not drawn", dark)
	}
}

// TestRasterTextWrap confirms a long single-paragraph line wraps to multiple
// lines inside a fixed-width box (matching the browser layout), instead of
// drawing one overflowing line. Wrapping shows up as dark text pixels spanning
// several line heights vertically.
func TestRasterTextWrap(t *testing.T) {
	node := map[string]any{
		"type":      "text",
		"transform": map[string]any{"x": 10.0, "y": 10.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 140.0, "height": 260.0},
		"box":       map[string]any{"mode": "fixed", "width": 140.0, "height": 260.0, "verticalAlign": "top"},
		"content": []any{map[string]any{
			"runs":  []any{map[string]any{"text": "The quick brown fox jumps over the lazy dog again and again", "style": map[string]any{"fontFamily": "system", "fontStyle": "Regular", "fontSize": 20.0, "fill": map[string]any{"type": "solid", "color": map[string]any{"srgb": map[string]any{"r": 0.0, "g": 0.0, "b": 0.0, "a": 1.0}}}}}},
			"style": map[string]any{"align": "left", "direction": "auto"},
		}},
	}
	imgBytes, err := ToPNG(Design{"pages": []any{map[string]any{"width": 200.0, "height": 300.0, "children": []any{node}, "background": map[string]any{"type": "solid", "color": map[string]any{"srgb": map[string]any{"r": 1.0, "g": 1.0, "b": 1.0, "a": 1.0}}}}}}, 0, 1)
	if err != nil || len(imgBytes) == 0 {
		t.Fatalf("raster wrapped text: %v", err)
	}
	img, err := png.Decode(strings.NewReader(string(imgBytes)))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	minY, maxY, dark := 1<<30, -1, 0
	b := img.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			r, g, bl, _ := img.At(x, y).RGBA()
			if r < 0x4000 && g < 0x4000 && bl < 0x4000 {
				dark++
				if y < minY {
					minY = y
				}
				if y > maxY {
					maxY = y
				}
			}
		}
	}
	if dark < 50 {
		t.Fatalf("wrapped text rendered too few dark pixels (%d)", dark)
	}
	// One 20px line spans ~24px vertically; wrapping the sentence to a 140px box
	// must produce several lines, so the vertical extent far exceeds one line.
	if span := maxY - minY; span < 60 {
		t.Fatalf("text did not wrap: dark-pixel vertical span %d px is within a single line", span)
	}
}

// TestRasterImageElement confirms the Go rasterizer decodes and draws an image
// element (bytes embedded as a data URL on node["src"], as the video export
// handler does), so image element clips composite in the server export.
func TestRasterImageElement(t *testing.T) {
	// A 16x16 solid-red source image, embedded as a data URL.
	red := image.NewRGBA(image.Rect(0, 0, 16, 16))
	for y := 0; y < 16; y++ {
		for x := 0; x < 16; x++ {
			red.Set(x, y, color.RGBA{R: 220, G: 20, B: 20, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, red); err != nil {
		t.Fatal(err)
	}
	node := map[string]any{
		"type":      "image",
		"fit":       "cover",
		"transform": map[string]any{"x": 0.0, "y": 0.0, "scaleX": 1.0, "scaleY": 1.0, "rotation": 0.0},
		"size":      map[string]any{"width": 100.0, "height": 100.0},
		"source":    map[string]any{"assetId": "x", "naturalWidth": 16.0, "naturalHeight": 16.0},
		"src":       "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes()),
	}
	imgBytes, err := ToPNG(Design{"pages": []any{map[string]any{"width": 100.0, "height": 100.0, "children": []any{node}}}}, 0, 1)
	if err != nil || len(imgBytes) == 0 {
		t.Fatalf("raster image: %v", err)
	}
	out, err := png.Decode(bytes.NewReader(imgBytes))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	r, g, b, _ := out.At(50, 50).RGBA()
	if r>>8 < 150 || g>>8 > 100 || b>>8 > 100 {
		t.Fatalf("image element center not red (image not drawn): r=%d g=%d b=%d", r>>8, g>>8, b>>8)
	}
}

func TestBuildTimelineArgs_Element(t *testing.T) {
	p := &TimelineProject{}
	p.Stage.Width = 640
	p.Stage.Height = 360
	p.Fps = 30
	p.Tracks = []TimelineTrack{{
		ID: "ov1", Kind: "overlay",
		Clips: []TimelineClip{{
			ID: "e1", StartFrame: 30, InFrame: 0, OutFrame: 60, Speed: 1,
			Element:      map[string]any{"type": "shape", "shape": "rect"},
			TransitionIn: &TimelineTransition{Type: "fade", DurationFrames: 10},
		}},
	}}
	opts := TimelineOptions{ElementFiles: map[string]string{"e1": "/tmp/element-e1.png"}}
	args, err := BuildTimelineArgs(p, fixtureAssets(t), opts, "/tmp/out.mp4")
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "-loop 1 -i /tmp/element-e1.png") {
		t.Fatalf("element clip should add a looped image input; args: %s", joined)
	}
	var fc string
	for i, a := range args {
		if a == "-filter_complex" {
			fc = args[i+1]
		}
	}
	if !strings.Contains(fc, "overlay=x=0:y=0") {
		t.Fatalf("element clip should overlay onto the base; fc: %s", fc)
	}
	if !strings.Contains(fc, "fade=t=in") {
		t.Fatalf("element fade-in transition missing; fc: %s", fc)
	}
	if !strings.Contains(fc, "setpts=PTS+1.0000/TB") {
		t.Fatalf("element start offset (1.0s) missing; fc: %s", fc)
	}

	// With no staged PNG for the element, the clip is skipped (no image input).
	args2, err := BuildTimelineArgs(p, fixtureAssets(t), TimelineOptions{}, "/tmp/out.mp4")
	if err != nil {
		t.Fatalf("build2: %v", err)
	}
	if strings.Contains(strings.Join(args2, " "), "-loop") {
		t.Fatalf("element with no staged file must be skipped")
	}
}

func TestBuildTimelineArgs(t *testing.T) {
	p := timelineFixture()
	args, err := BuildTimelineArgs(p, fixtureAssets(t), TimelineOptions{DrawText: true}, "/tmp/out.mp4")
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	joined := strings.Join(args, " ")
	var fc string
	for i, a := range args {
		if a == "-filter_complex" {
			fc = args[i+1]
		}
	}
	if fc == "" {
		t.Fatal("no filter_complex")
	}
	// Video chain: trim + cover scale + fade-out with alpha + overlay.
	for _, want := range []string{
		"trim=start=0.0000:end=3.0000",
		"scale=640:360:force_original_aspect_ratio=increase",
		"fade=t=out:st=2.5000:d=0.5000:alpha=1",
		"overlay=x=0:y=0:eof_action=pass",
	} {
		if !strings.Contains(fc, want) {
			t.Fatalf("filter graph missing %q in:\n%s", want, fc)
		}
	}
	// Audio chain: gain -6 dB ~ 0.5012, fade out, delay at 0ms, mix of tracks.
	for _, want := range []string{"volume=0.5012", "afade=t=out:st=3.0000:d=1.0000", "adelay=0:all=1"} {
		if !strings.Contains(fc, want) {
			t.Fatalf("audio graph missing %q in:\n%s", want, fc)
		}
	}
	// Title drawtext with escaping (colon and percent escaped, quote survives),
	// plus the caption cue.
	if !strings.Contains(fc, `drawtext=font=Sans:text='Hello\: it'\''s 100\%'`) {
		t.Fatalf("title drawtext missing/mis-escaped in:\n%s", fc)
	}
	if !strings.Contains(fc, "text='A caption'") {
		t.Fatalf("caption drawtext missing in:\n%s", fc)
	}
	// Output settings.
	for _, want := range []string{"-c:v libx264", "-pix_fmt yuv420p", "-c:a aac", "-movflags +faststart"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("args missing %q", want)
		}
	}
	// Burn-in off drops caption drawtext.
	p2 := timelineFixture()
	p2.Captions[0].Style = map[string]any{"burnIn": false}
	args2, err := BuildTimelineArgs(p2, fixtureAssets(t), TimelineOptions{DrawText: true}, "/tmp/out.mp4")
	if err != nil {
		t.Fatalf("build2: %v", err)
	}
	var fc2 string
	for i, a := range args2 {
		if a == "-filter_complex" {
			fc2 = args2[i+1]
		}
	}
	if strings.Contains(fc2, "A caption") {
		t.Fatal("caption should not burn in when style.burnIn=false")
	}
}

func TestBuildTimelineArgs_Range(t *testing.T) {
	p := timelineFixture() // 120 frames at 30fps = 4s total
	args, err := BuildTimelineArgs(p, fixtureAssets(t), TimelineOptions{RangeStartFrame: 30, RangeEndFrame: 90}, "/tmp/out.mp4")
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	joined := strings.Join(args, " ")
	// Output seeking: -ss 1s, -t 2s.
	if !strings.Contains(joined, "-ss 1.0000") || !strings.Contains(joined, "-t 2.0000") {
		t.Fatalf("range seek args wrong: %s", joined)
	}
	// No range: -ss 0, full duration.
	args2, err := BuildTimelineArgs(p, fixtureAssets(t), TimelineOptions{}, "/tmp/out.mp4")
	if err != nil {
		t.Fatalf("build2: %v", err)
	}
	joined2 := strings.Join(args2, " ")
	if !strings.Contains(joined2, "-ss 0.0000") || !strings.Contains(joined2, "-t 4.0000") {
		t.Fatalf("default range args wrong: %s", joined2)
	}
	// An end past the timeline clamps to the timeline.
	args3, err := BuildTimelineArgs(p, fixtureAssets(t), TimelineOptions{RangeStartFrame: 60, RangeEndFrame: 999999}, "/tmp/out.mp4")
	if err != nil {
		t.Fatalf("build3: %v", err)
	}
	if !strings.Contains(strings.Join(args3, " "), "-t 2.0000") {
		t.Fatalf("clamped range wrong: %s", strings.Join(args3, " "))
	}
}

func TestBuildTimelineArgs_Ducking(t *testing.T) {
	p := timelineFixture()
	// Two audio tracks with a ducking config.
	p.Tracks = append(p.Tracks, TimelineTrack{
		ID: "a2", Kind: "audio",
		Clips: []TimelineClip{{ID: "c4", AssetID: "aud", StartFrame: 0, InFrame: 0, OutFrame: 60, Speed: 1}},
	})
	p.Master.Ducking = &TimelineDucking{MusicTrackID: "a1", VoiceTrackID: "a2", AmountDb: -12, AttackMs: 80, ReleaseMs: 400}
	args, err := BuildTimelineArgs(p, fixtureAssets(t), TimelineOptions{DrawText: true}, "/tmp/out.mp4")
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	var fc string
	for i, a := range args {
		if a == "-filter_complex" {
			fc = args[i+1]
		}
	}
	if !strings.Contains(fc, "sidechaincompress=threshold=0.02:ratio=12.0:attack=80:release=400") {
		t.Fatalf("ducking sidechain missing in:\n%s", fc)
	}
}

func TestFlattenSequences(t *testing.T) {
	child := &TimelineProject{}
	child.Stage.Width = 640
	child.Stage.Height = 360
	child.Fps = 30
	child.DurationFrames = 120
	child.Master.GainDb = -3
	child.Tracks = []TimelineTrack{
		{
			ID: "cv", Kind: "video", GainDb: 0,
			Clips: []TimelineClip{
				{ID: "k1", AssetID: "vid", StartFrame: 0, InFrame: 0, OutFrame: 60, Speed: 1},
				{ID: "k2", AssetID: "vid", StartFrame: 60, InFrame: 60, OutFrame: 120, Speed: 1},
			},
		},
		{
			ID: "ca", Kind: "audio", GainDb: -2,
			Clips: []TimelineClip{{ID: "k3", AssetID: "aud", StartFrame: 0, InFrame: 0, OutFrame: 120, Speed: 1, AudioGainDb: -1}},
		},
	}
	parent := &TimelineProject{}
	parent.Stage = child.Stage
	parent.Fps = 30
	parent.DurationFrames = 300
	parent.Tracks = []TimelineTrack{{
		ID: "pv", Kind: "video",
		Clips: []TimelineClip{{
			// Windowed into the child: frames 30..90 of the child, placed at 100,
			// played at 2x, with the sequence clip itself at -6 dB.
			ID: "s1", SequenceID: "seq1", StartFrame: 100, InFrame: 30, OutFrame: 90, Speed: 2, AudioGainDb: -6,
		}},
	}}

	flat := FlattenSequences(parent, map[string]*TimelineProject{"seq1": child}, 0)
	// Parent video track (now empty of the sequence clip) + 2 synthesized.
	if len(flat.Tracks) != 3 {
		t.Fatalf("want 3 tracks, got %d", len(flat.Tracks))
	}
	if len(flat.Tracks[0].Clips) != 0 {
		t.Fatalf("sequence clip should be removed from the parent track")
	}
	v := flat.Tracks[1]
	if v.Kind != "video" || len(v.Clips) != 2 {
		t.Fatalf("synth video track wrong: %+v", v)
	}
	// k1 visible span in child frames: [30,60) -> parent start 100, 15 frames at 2x.
	k1 := v.Clips[0]
	if k1.StartFrame != 100 || k1.InFrame != 30 || k1.OutFrame != 60 || k1.Speed != 2 {
		t.Fatalf("k1 projection wrong: %+v", k1)
	}
	// k2 visible span [60,90): starts at parent 100 + 30/2 = 115, source [60,90).
	k2 := v.Clips[1]
	if k2.StartFrame != 115 || k2.InFrame != 60 || k2.OutFrame != 90 || k2.Speed != 2 {
		t.Fatalf("k2 projection wrong: %+v", k2)
	}
	// Audio gain folds: clip -1 + track -2 + master -3 + parent clip -6 = -12.
	a := flat.Tracks[2]
	if a.Kind != "audio" || len(a.Clips) != 1 || a.Clips[0].AudioGainDb != -12 {
		t.Fatalf("audio fold wrong: %+v", a)
	}
	// Duration checks out: 60 child frames at 2x = 30 parent frames.
	if got := a.Clips[0].durFrames(); math.Abs(got-30) > 0.01 {
		t.Fatalf("audio clip duration %f, want 30", got)
	}
}

// TestRenderTimeline_Integration renders a real 2-clip timeline through ffmpeg.
// Skipped when ffmpeg is not installed.
func TestRenderTimeline_Integration(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	vid := filepath.Join(dir, "vid.mp4")
	aud := filepath.Join(dir, "aud.mp3")
	gen := func(args ...string) {
		t.Helper()
		cmd := exec.Command("ffmpeg", args...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("ffmpeg gen: %v\n%s", err, tail(string(out), 400))
		}
	}
	gen("-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x180:rate=30",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", vid)
	gen("-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=4", "-c:a", "libmp3lame", aud)

	p := timelineFixture()
	assets := func(assetID string) (StagedAsset, bool) {
		switch assetID {
		case "vid":
			return StagedAsset{Path: vid, HasVideo: true, HasAudio: true}, true
		case "aud":
			return StagedAsset{Path: aud, HasVideo: false, HasAudio: true}, true
		}
		return StagedAsset{}, false
	}
	mp4, err := RenderTimeline(context.Background(), p, assets, TimelineOptions{})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if len(mp4) < 10_000 {
		t.Fatalf("suspiciously small output: %d bytes", len(mp4))
	}
	out := filepath.Join(dir, "out.mp4")
	if err := os.WriteFile(out, mp4, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := exec.LookPath("ffprobe"); err == nil {
		probe, err := exec.Command("ffprobe", "-v", "error", "-show_entries", "stream=codec_type",
			"-show_entries", "format=duration", "-of", "csv=p=0", out).Output()
		if err != nil {
			t.Fatalf("ffprobe: %v", err)
		}
		s := string(probe)
		if !strings.Contains(s, "video") || !strings.Contains(s, "audio") {
			t.Fatalf("output missing streams: %s", s)
		}
		// 120 frames at 30fps = 4s (the audio clip is the longest).
		if !strings.Contains(s, "4.0") {
			t.Logf("duration line: %s", s) // informative; container rounding varies
		}
	}
}

func TestBuildTimelineArgs_ColorAndTransform(t *testing.T) {
	one := 1.0
	half := 0.5
	sat := 1.35
	bright := 1.2
	p := timelineFixture()
	c := &p.Tracks[0].Clips[0]
	c.Color = &TimelineColor{Brightness: &bright, Saturation: &sat, Temperature: 0.5}
	c.Fit = "contain"
	c.Opacity = &half
	c.RotationDeg = 90
	p.Background = "#112233"
	args, err := BuildTimelineArgs(p, fixtureAssets(t), TimelineOptions{ColorTemp: true}, "/tmp/out.mp4")
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	joined := strings.Join(args, " ")
	// eq mirrors the browser values: additive brightness (1.2-1)*0.5, direct saturation.
	if !strings.Contains(joined, "eq=brightness=0.1000:contrast=1.0000:saturation=1.3500") {
		t.Fatalf("eq missing/wrong: %s", joined)
	}
	// Warm temperature 0.5 -> 6500 - 1250 = 5250K.
	if !strings.Contains(joined, "colortemperature=temperature=5250") {
		t.Fatalf("colortemperature missing: %s", joined)
	}
	// Contain letterboxes with a transparent pad instead of scale-crop.
	if !strings.Contains(joined, "force_original_aspect_ratio=decrease") ||
		!strings.Contains(joined, "pad=640:360:(ow-iw)/2:(oh-ih)/2:color=black@0") {
		t.Fatalf("contain chain wrong: %s", joined)
	}
	if strings.Contains(joined, "crop=640:360,") {
		t.Fatalf("contain clip must not scale-crop: %s", joined)
	}
	// Static opacity and rotation.
	if !strings.Contains(joined, "colorchannelmixer=aa=0.5000") {
		t.Fatalf("opacity chain missing: %s", joined)
	}
	if !strings.Contains(joined, "rotate=1.570796:c=black@0") {
		t.Fatalf("rotate missing: %s", joined)
	}
	// Stage background comes from the project.
	if !strings.Contains(joined, "color=c=0x112233:s=640x360") {
		t.Fatalf("background missing: %s", joined)
	}

	// Without ColorTemp support the temperature filter is simply omitted.
	args2, err := BuildTimelineArgs(p, fixtureAssets(t), TimelineOptions{}, "/tmp/out.mp4")
	if err != nil {
		t.Fatalf("build2: %v", err)
	}
	if strings.Contains(strings.Join(args2, " "), "colortemperature") {
		t.Fatalf("colortemperature must be probe-gated")
	}

	// A neutral color object emits no eq at all.
	c.Color = &TimelineColor{Brightness: &one}
	c.Fit = ""
	c.Opacity = nil
	c.RotationDeg = 0
	args3, err := BuildTimelineArgs(p, fixtureAssets(t), TimelineOptions{}, "/tmp/out.mp4")
	if err != nil {
		t.Fatalf("build3: %v", err)
	}
	j3 := strings.Join(args3, " ")
	if strings.Contains(j3, "eq=") || strings.Contains(j3, "rotate=") || strings.Contains(j3, "colorchannelmixer") {
		t.Fatalf("neutral clip must not add color/transform filters: %s", j3)
	}
}

func TestBuildTimelineArgs_Formats(t *testing.T) {
	p := timelineFixture()
	// GIF: palette graph, no audio graph, no -map for audio, gif muxer.
	gif, err := BuildTimelineArgs(p, fixtureAssets(t), TimelineOptions{Format: "gif"}, "/tmp/out.gif")
	if err != nil {
		t.Fatalf("gif build: %v", err)
	}
	jg := strings.Join(gif, " ")
	if !strings.Contains(jg, "palettegen") || !strings.Contains(jg, "paletteuse") {
		t.Fatalf("gif palette missing: %s", jg)
	}
	if strings.Contains(jg, "amix") || strings.Contains(jg, "anullsrc") || strings.Contains(jg, "atrim") {
		t.Fatalf("gif must not build audio: %s", jg)
	}
	if !strings.Contains(jg, "-f gif") || !strings.Contains(jg, "fps=15") {
		t.Fatalf("gif output args wrong: %s", jg)
	}

	// MP3: audio-only, no video graph at all, lame codec.
	mp3, err := BuildTimelineArgs(p, fixtureAssets(t), TimelineOptions{Format: "mp3"}, "/tmp/out.mp3")
	if err != nil {
		t.Fatalf("mp3 build: %v", err)
	}
	jm := strings.Join(mp3, " ")
	if strings.Contains(jm, "color=c=") || strings.Contains(jm, "overlay=") || strings.Contains(jm, "drawtext") {
		t.Fatalf("mp3 must not build video: %s", jm)
	}
	if !strings.Contains(jm, "libmp3lame") || !strings.Contains(jm, "-vn") {
		t.Fatalf("mp3 output args wrong: %s", jm)
	}

	// MP3 with nothing audible errors instead of producing silence.
	silent := timelineFixture()
	silent.Tracks = silent.Tracks[:1]
	silent.Tracks[0].Clips[0].AssetID = "vid-noaudio"
	if _, err := BuildTimelineArgs(silent, func(string) (StagedAsset, bool) {
		return StagedAsset{Path: "/tmp/v.mp4", HasVideo: true, HasAudio: false}, true
	}, TimelineOptions{Format: "mp3"}, "/tmp/out.mp3"); err == nil {
		t.Fatalf("silent mp3 export must fail loudly")
	}

	// Default stays the mp4 pipeline.
	mp4, err := BuildTimelineArgs(p, fixtureAssets(t), TimelineOptions{}, "/tmp/out.mp4")
	if err != nil {
		t.Fatalf("mp4 build: %v", err)
	}
	if !strings.Contains(strings.Join(mp4, " "), "libx264") {
		t.Fatalf("mp4 output args wrong")
	}
}

func TestBuildTimelineArgs_TrackPan(t *testing.T) {
	p := timelineFixture()
	p.Tracks[1].Pan = -1 // full left
	args, err := BuildTimelineArgs(p, fixtureAssets(t), TimelineOptions{}, "/tmp/out.mp4")
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	joined := strings.Join(args, " ")
	// Equal-power at p=-1: a=0 -> L gain sqrt2*cos(0)=1.4142, R gain 0.
	if !strings.Contains(joined, "pan=stereo|c0=1.4142*c0|c1=0.0000*c1") {
		t.Fatalf("pan chain missing/wrong: %s", joined)
	}
	// Center pan emits no pan filter at all.
	p.Tracks[1].Pan = 0
	args2, _ := BuildTimelineArgs(p, fixtureAssets(t), TimelineOptions{}, "/tmp/out.mp4")
	if strings.Contains(strings.Join(args2, " "), "pan=stereo") {
		t.Fatalf("center pan must not add a filter")
	}
}

func TestBuildTimelineArgs_XfadeTailAndNewOpts(t *testing.T) {
	p := timelineFixture()
	// Two abutting clips with crossDissolve on both edges of the cut.
	p.Tracks[0].Clips = []TimelineClip{
		{ID: "l", AssetID: "vid", StartFrame: 0, InFrame: 0, OutFrame: 60, Speed: 1,
			TransitionOut: &TimelineTransition{Type: "crossDissolve", DurationFrames: 12}},
		{ID: "r", AssetID: "vid", StartFrame: 60, InFrame: 60, OutFrame: 120, Speed: 1,
			TransitionIn: &TimelineTransition{Type: "crossDissolve", DurationFrames: 12}},
	}
	args, err := BuildTimelineArgs(p, fixtureAssets(t), TimelineOptions{}, "/tmp/out.mp4")
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	joined := strings.Join(args, " ")
	// Left clip's trim extends past the cut by the 12-frame window (72/30=2.4s)
	// and its own out-fade is GONE; the right keeps its fade-in.
	if !strings.Contains(joined, "trim=start=0.0000:end=2.4000") {
		t.Fatalf("left tail missing: %s", joined)
	}
	if strings.Count(joined, ",fade=t=out") != 0 { // video fades only; afade is audio
		t.Fatalf("left out-fade should be dropped: %s", joined)
	}
	if strings.Count(joined, ",fade=t=in") != 1 {
		t.Fatalf("right fade-in must remain: %s", joined)
	}

	// webm + fps override + captions skipped + stem.
	p2 := timelineFixture()
	args2, err := BuildTimelineArgs(p2, fixtureAssets(t), TimelineOptions{Format: "webm", OutFps: 60, DrawText: true, SkipCaptions: true}, "/tmp/out.webm")
	if err != nil {
		t.Fatalf("webm build: %v", err)
	}
	j2 := strings.Join(args2, " ")
	if !strings.Contains(j2, "libvpx-vp9") || !strings.Contains(j2, "-r 60") || !strings.Contains(j2, "libopus") {
		t.Fatalf("webm args wrong: %s", j2)
	}
	if strings.Contains(j2, "A caption") {
		t.Fatalf("captions must be skippable: %s", j2)
	}
	stem, err := BuildTimelineArgs(p2, fixtureAssets(t), TimelineOptions{Format: "mp3", StemTrackID: "a1"}, "/tmp/out.mp3")
	if err != nil {
		t.Fatalf("stem build: %v", err)
	}
	js := strings.Join(stem, " ")
	if !strings.Contains(js, "libmp3lame") || strings.Contains(js, "sidechain") {
		t.Fatalf("stem args wrong: %s", js)
	}
}

func TestBuildTimelineArgs_Crop(t *testing.T) {
	p := timelineFixture()
	p.Tracks[0].Clips[0].Crop = &TimelineRect{X: 100, Y: 50, Width: 640, Height: 360}
	args, err := BuildTimelineArgs(p, fixtureAssets(t), TimelineOptions{}, "/tmp/out.mp4")
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if !strings.Contains(strings.Join(args, " "), "crop=640:360:100:50") {
		t.Fatalf("source crop missing: %s", strings.Join(args, " "))
	}
}
