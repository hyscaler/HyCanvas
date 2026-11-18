package render

import (
	"context"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestDrawtextFontPicksNearestStagedWeight(t *testing.T) {
	if got := drawtextFont(nil, 700); got != "font=Sans" {
		t.Fatalf("no staged fonts: got %q, want font=Sans", got)
	}
	files := map[int]string{400: "/f/Inter-400.ttf", 600: "/f/Inter-600.ttf", 700: "/f/Inter-700.ttf"}
	for weight, want := range map[int]string{700: "Inter-700", 400: "Inter-400", 600: "Inter-600", 800: "Inter-700"} {
		if got := drawtextFont(files, weight); !strings.Contains(got, want) || !strings.HasPrefix(got, "fontfile='") {
			t.Fatalf("weight %d: got %q, want the %s file", weight, got, want)
		}
	}
	// A Windows path keeps working inside the filter graph: forward slashes,
	// drive colon escaped.
	if got := drawtextFont(map[int]string{700: `C:\Temp\Inter-700.ttf`}, 700); filepath.Separator == '\\' && got != `fontfile='C\:/Temp/Inter-700.ttf'` {
		t.Fatalf("windows path: got %q", got)
	}
}

func TestStageTextFontsWritesInterFaces(t *testing.T) {
	files := StageTextFonts(t.TempDir())
	for _, w := range []int{400, 600, 700} {
		p, ok := files[w]
		if !ok {
			t.Fatalf("weight %d not staged: %v", w, files)
		}
		if st, err := os.Stat(p); err != nil || st.Size() < 10000 {
			t.Fatalf("weight %d file %s: %v", w, p, err)
		}
	}
}

// TestBuildTimelineArgsTitleUsesStagedFonts covers #94: a title card is burned
// in with the bold Inter face (the preview's default weight) and a "normal"
// card with the regular face; captions use semibold, as the preview does.
func TestBuildTimelineArgsTitleUsesStagedFonts(t *testing.T) {
	p := timelineFixture()
	files := map[int]string{400: "/f/Inter-400.ttf", 600: "/f/Inter-600.ttf", 700: "/f/Inter-700.ttf"}
	fc := filterGraph(t, p, TimelineOptions{DrawText: true, TextFonts: files})
	if !strings.Contains(fc, `drawtext=fontfile='/f/Inter-700.ttf':text='Hello\: it'\''s 100\%'`) {
		t.Fatalf("bold title font missing in:\n%s", fc)
	}
	if !strings.Contains(fc, `drawtext=fontfile='/f/Inter-600.ttf':text='A caption'`) {
		t.Fatalf("caption font missing in:\n%s", fc)
	}
	p.Tracks[2].Clips[0].Title.Weight = "normal"
	fc = filterGraph(t, p, TimelineOptions{DrawText: true, TextFonts: files})
	if !strings.Contains(fc, `drawtext=fontfile='/f/Inter-400.ttf':text='Hello`) {
		t.Fatalf("normal-weight title font missing in:\n%s", fc)
	}
}

func filterGraph(t *testing.T, p *TimelineProject, opts TimelineOptions) string {
	t.Helper()
	args, err := BuildTimelineArgs(p, fixtureAssets(t), opts, "/tmp/out.mp4")
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	for i, a := range args {
		if a == "-filter_complex" {
			return args[i+1]
		}
	}
	t.Fatal("no filter_complex")
	return ""
}

// TestRenderTimelineTitleBoldE2E renders a title card through ffmpeg in both
// weights and checks the bold one carries clearly more ink, i.e. the staged
// bold face was used (#94). Skips when ffmpeg or drawtext is absent.
func TestRenderTimelineTitleBoldE2E(t *testing.T) {
	bin, err := exec.LookPath("ffmpeg")
	if err != nil || !ffmpegHasFilter(bin, "drawtext") {
		t.Skip("ffmpeg with drawtext not available")
	}
	ink := func(weight string) int {
		p := &TimelineProject{}
		p.Stage.Width = 640
		p.Stage.Height = 360
		p.Fps = 30
		p.Tracks = []TimelineTrack{{
			ID: "t1", Kind: "text",
			Clips: []TimelineClip{{ID: "c1", StartFrame: 0, InFrame: 0, OutFrame: 30, Speed: 1,
				Title: &TimelineTitle{Text: "Main Street Coffee", Position: "center", Color: "#ffffff", Weight: weight}}},
		}}
		out, err := RenderTimeline(context.Background(), p, func(string) (StagedAsset, bool) { return StagedAsset{}, false }, TimelineOptions{})
		if err != nil {
			t.Fatalf("render %s: %v", weight, err)
		}
		dir := t.TempDir()
		mp4 := filepath.Join(dir, "out.mp4")
		if err := os.WriteFile(mp4, out, 0o644); err != nil {
			t.Fatal(err)
		}
		frame := filepath.Join(dir, "frame.png")
		if err := exec.Command(bin, "-y", "-ss", "0.5", "-i", mp4, "-frames:v", "1", frame).Run(); err != nil {
			t.Fatalf("extract frame: %v", err)
		}
		f, err := os.Open(frame)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		img, err := png.Decode(f)
		if err != nil {
			t.Fatal(err)
		}
		n := 0
		b := img.Bounds()
		for y := b.Min.Y; y < b.Max.Y; y++ {
			for x := b.Min.X; x < b.Max.X; x++ {
				if r, _, _, _ := img.At(x, y).RGBA(); r > 0x8000 {
					n++
				}
			}
		}
		return n
	}
	bold, regular := ink("bold"), ink("normal")
	if regular == 0 || float64(bold) < float64(regular)*1.25 {
		t.Fatalf("bold title not heavier than regular: bold=%d regular=%d", bold, regular)
	}
}
