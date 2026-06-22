package render

import (
	"bytes"
	"context"
	"os/exec"
	"testing"
)

func TestBuildEncodeArgs(t *testing.T) {
	args := buildEncodeArgs(30, 20, "medium", "/tmp/out.mp4")
	joined := bytes.NewBufferString("")
	for _, a := range args {
		joined.WriteString(a + " ")
	}
	s := joined.String()
	for _, want := range []string{"image2pipe", "-framerate 30", "libx264", "yuv420p", "-crf 20", "-preset medium", "+faststart", "/tmp/out.mp4"} {
		if !bytes.Contains([]byte(s), []byte(want)) {
			t.Fatalf("encode args missing %q: %s", want, s)
		}
	}
}

func TestToVideo(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed; skipping encode test")
	}
	out, err := ToVideo(context.Background(), sampleDesign(), 0, VideoOptions{FPS: 2, DurationMs: 1000, Scale: 1})
	if err != nil {
		t.Fatalf("ToVideo: %v", err)
	}
	if len(out) < 100 {
		t.Fatalf("mp4 too small: %d bytes", len(out))
	}
	// MP4/ISO-BMFF: bytes 4..8 are the "ftyp" box type.
	if !bytes.Contains(out[:64], []byte("ftyp")) {
		t.Fatalf("output is not an MP4 (no ftyp box)")
	}
	if _, err := ToVideo(context.Background(), sampleDesign(), 9, VideoOptions{}); err != ErrPageRange {
		t.Fatalf("out-of-range page should error, got %v", err)
	}
}
