// Preview proxies for heavy video uploads: a 540p/CRF-28 MP4 rendered by
// ffmpeg in the background right after upload and stored under
// proxies/<assetId>.mp4. The video editor prefers the proxy for preview
// playback (scrubbing a 4K source stays smooth on modest machines) while
// server exports always read the original. Best-effort: no ffmpeg, a failed
// encode, or a small original simply means no proxy, and playback falls back
// to the original transparently.

package uploads

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// proxyMinBytes: originals below this size play fine directly; overridable
// (ASSET_PROXY_MIN_BYTES) mainly for tests and small self-host boxes.
func proxyMinBytes() int64 {
	if raw := os.Getenv("ASSET_PROXY_MIN_BYTES"); raw != "" {
		if n, err := strconv.ParseInt(raw, 10, 64); err == nil {
			return n
		}
	}
	return 8 * 1024 * 1024 // 8 MiB
}

func proxyKey(assetID string) string { return "proxies/" + assetID + ".mp4" }

// proxyWorthwhile reports whether an asset earns a 540p proxy: a video whose
// original is big enough that scrubbing it directly is painful.
func proxyWorthwhile(mime string, size int64) bool {
	return strings.HasPrefix(mime, "video/") && size >= proxyMinBytes()
}

// maybeGenerateProxy kicks a background proxy encode for a just-uploaded
// video when it is large enough and ffmpeg is available. The bytes are already
// in memory on this path (the base64 upload), so they are written straight out.
func (s *Service) maybeGenerateProxy(assetID string, data []byte, mime string) {
	if !proxyWorthwhile(mime, int64(len(data))) {
		return
	}
	bin, err := exec.LookPath("ffmpeg")
	if err != nil {
		return
	}
	go s.encodeProxy(assetID, bin, func(dst string) error {
		return os.WriteFile(dst, data, 0o600)
	})
}

// maybeGenerateProxyFromKey is the same job for uploads whose bytes never pass
// through memory: the direct/chunked pipeline streams the stored object out to
// a temp file rather than holding a multi-hundred-MB video in RAM.
//
// Without this the streaming upload path produced NO proxy at all, so exactly
// the large videos that most need a lightweight preview were the ones that
// never got one, and the editor fell back to scrubbing the full original.
func (s *Service) maybeGenerateProxyFromKey(assetID, storageKey, mime string, size int64) {
	if !proxyWorthwhile(mime, size) {
		return
	}
	bin, err := exec.LookPath("ffmpeg")
	if err != nil {
		return
	}
	go s.encodeProxy(assetID, bin, func(dst string) error {
		rc, _, err := s.storage.Open(storageKey)
		if err != nil {
			return err
		}
		if rc == nil {
			return errors.New("source object is missing")
		}
		defer func() { _ = rc.Close() }()
		f, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
		if err != nil {
			return err
		}
		defer func() { _ = f.Close() }()
		_, err = io.Copy(f, rc)
		return err
	})
}

// encodeProxy renders the 540p proxy and stores it. stage puts the source into
// the temp dir; everything after it is identical for both entry points.
func (s *Service) encodeProxy(assetID, bin string, stage func(dst string) error) {
	dir, err := os.MkdirTemp("", "oc-proxy-*")
	if err != nil {
		return
	}
	defer func() { _ = os.RemoveAll(dir) }()
	in := filepath.Join(dir, "in")
	out := filepath.Join(dir, "out.mp4")
	if err := stage(in); err != nil {
		slog.Warn("proxy source staging failed", "asset", assetID, "err", err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	// 540p (even width), fast+small; audio kept so scrubbing has sound.
	cmd := exec.CommandContext(ctx, bin,
		"-y", "-loglevel", "error", "-i", in,
		"-vf", "scale=-2:540",
		"-c:v", "libx264", "-crf", "28", "-preset", "veryfast",
		"-c:a", "aac", "-b:a", "96k",
		"-movflags", "+faststart", out,
	)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		slog.Warn("proxy encode failed", "asset", assetID, "err", err, "detail", tailStr(stderr.String(), 300))
		return
	}
	proxy, err := os.ReadFile(out)
	if err != nil || len(proxy) == 0 {
		return
	}
	if _, err := s.storage.Put(proxyKey(assetID), proxy); err != nil {
		slog.Warn("proxy store failed", "asset", assetID, "err", err)
		return
	}
	slog.Info("proxy ready", "asset", assetID, "bytes", len(proxy))
}

// ProxyContent returns the proxy bytes for an asset, or ok=false when none
// exists (small original, encode pending/failed, or no ffmpeg).
func (s *Service) ProxyContent(_ context.Context, assetID string) ([]byte, bool) {
	data, err := s.storage.Get(proxyKey(assetID))
	if err != nil || len(data) == 0 {
		return nil, false
	}
	return data, true
}

func tailStr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}
