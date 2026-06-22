// Video (MP4) export: renders the design's frames via the raster engine and
// pipes them to ffmpeg (image2pipe -> libx264 -> yuv420p), matching the Node
// worker's encode args so output is interchangeable. ffmpeg is invoked as an
// external process (the container bundles it).
//
// Fidelity note (v1, documented): true timeline compositing - multi-track clips,
// in/out transitions, source-media frame extraction, and element animations over
// time (the @hc/engine compositor) - is deferred. This renders the static page
// for the requested duration, which is correct for a still design and the
// foundation the per-frame compositor will plug into (each frame is already an
// independent PNG piped to the same encoder).
package render

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"strconv"
)

// ErrNoFFmpeg is returned when the ffmpeg binary is not on PATH.
var ErrNoFFmpeg = errors.New("ffmpeg not found on PATH")

// buildEncodeArgs mirrors the Node buildVideoEncodeArgs (image2pipe PNG stdin
// -> H.264 MP4), with crf/preset and a faststart moov.
func buildEncodeArgs(fps, crf int, preset, outPath string) []string {
	return []string{
		"-y",
		"-f", "image2pipe",
		"-framerate", strconv.Itoa(fps),
		"-i", "-",
		"-c:v", "libx264",
		// yuv420p requires even dimensions; round the frame down to even px.
		"-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
		"-pix_fmt", "yuv420p",
		"-crf", strconv.Itoa(crf),
		"-preset", preset,
		"-movflags", "+faststart",
		outPath,
	}
}

// FrameSource yields PNG frames in order; it returns (frame, true) for each
// frame and (_, false) when the stream is exhausted.
type FrameSource func() ([]byte, bool)

// EncodeFrames pipes a PNG frame stream to ffmpeg and returns the encoded MP4
// bytes. fps/crf/preset control the encode; the output goes through a temp file
// (MP4 faststart needs a seekable output).
func EncodeFrames(ctx context.Context, frames FrameSource, fps, crf int, preset string) ([]byte, error) {
	bin, err := exec.LookPath("ffmpeg")
	if err != nil {
		return nil, ErrNoFFmpeg
	}
	tmp, err := os.CreateTemp("", "oc-video-*.mp4")
	if err != nil {
		return nil, err
	}
	tmpPath := tmp.Name()
	_ = tmp.Close()
	defer os.Remove(tmpPath)

	cmd := exec.CommandContext(ctx, bin, buildEncodeArgs(fps, crf, preset, tmpPath)...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	writeErr := func() error {
		defer stdin.Close()
		for {
			frame, ok := frames()
			if !ok {
				return nil
			}
			if _, err := stdin.Write(frame); err != nil {
				return err
			}
		}
	}()
	waitErr := cmd.Wait()
	if waitErr != nil {
		return nil, errors.New("ffmpeg failed: " + tail(stderr.String(), 500))
	}
	if writeErr != nil {
		return nil, writeErr
	}
	return os.ReadFile(tmpPath)
}

// VideoOptions controls an MP4 export.
type VideoOptions struct {
	FPS        int
	DurationMs int
	Scale      float64
	CRF        int
	Preset     string
}

// ToVideo renders one page to an MP4 of the given duration (static render of the
// page repeated at fps; see the fidelity note). Returns the encoded bytes.
func ToVideo(ctx context.Context, file Design, pageIndex int, opts VideoOptions) ([]byte, error) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		return nil, ErrNoFFmpeg
	}
	if opts.FPS <= 0 || opts.FPS > 120 {
		opts.FPS = 30
	}
	if opts.DurationMs <= 0 {
		opts.DurationMs = 3000
	}
	if opts.DurationMs > 10*60*1000 {
		opts.DurationMs = 10 * 60 * 1000
	}
	if opts.Scale <= 0 {
		opts.Scale = 1
	}
	if opts.CRF <= 0 || opts.CRF > 51 {
		opts.CRF = 20
	}
	if opts.Preset == "" {
		opts.Preset = "medium"
	}

	// Render the page once (static). ffmpeg requires an even pixel size for
	// yuv420p, so the raster engine's output must have even dimensions; pad later
	// if needed via the encoder. Here we rely on x264 accepting the size or the
	// caller picking an even scale; odd sizes are rare for export presets.
	frame, err := ToPNG(file, pageIndex, opts.Scale)
	if err != nil {
		return nil, err
	}

	totalFrames := opts.FPS * opts.DurationMs / 1000
	if totalFrames < 1 {
		totalFrames = 1
	}
	i := 0
	src := func() ([]byte, bool) {
		if i >= totalFrames {
			return nil, false
		}
		i++
		return frame, true
	}
	return EncodeFrames(ctx, src, opts.FPS, opts.CRF, opts.Preset)
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}
