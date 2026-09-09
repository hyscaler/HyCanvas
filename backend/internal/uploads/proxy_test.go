package uploads

import (
	"os"
	"strings"
	"testing"
)

// Only videos, and only ones big enough that scrubbing the original hurts.
func TestProxyWorthwhile(t *testing.T) {
	big := proxyMinBytes()
	cases := []struct {
		name string
		mime string
		size int64
		want bool
	}{
		{"large video earns a proxy", "video/mp4", big, true},
		{"video under the threshold plays fine directly", "video/mp4", big - 1, false},
		{"images never get a proxy", "image/png", big * 4, false},
		{"audio never gets a proxy", "audio/mpeg", big * 4, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := proxyWorthwhile(c.mime, c.size); got != c.want {
				t.Fatalf("proxyWorthwhile(%q, %d) = %v, want %v", c.mime, c.size, got, c.want)
			}
		})
	}
}

// Every path that finishes an upload must ask for a preview proxy.
//
// This is a wiring guard, not a behavior test, and it exists because the wiring
// is exactly what broke: the 540p proxy was requested only from the in-band
// base64 path, so videos finished through the direct/chunked pipeline silently
// got none. The large videos that most need a lightweight preview were the only
// ones that never received one, and the editor fell back to scrubbing the full
// original. A whole upload path was added without carrying this call across,
// which no unit test of either function alone would have caught.
func TestEveryUploadCompletionRequestsAProxy(t *testing.T) {
	paths := map[string]string{
		// in-band base64 upload -> store()
		"uploads.go": "maybeGenerateProxy(",
		// direct/chunked upload -> CompleteDirectUpload()
		"direct.go": "maybeGenerateProxyFromKey(",
	}
	for file, call := range paths {
		src, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}
		if !callsLive(string(src), call) {
			t.Errorf("%s no longer calls %s: an upload path that stores a video "+
				"without requesting a proxy leaves large videos with no preview", file, call)
		}
	}
}

// callsLive reports whether src contains the call on a line that is not
// commented out. A plain substring search would happily match the call inside a
// `// ...` line, which is the most likely way for this wiring to be disabled.
func callsLive(src, call string) bool {
	for _, line := range strings.Split(src, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "//") {
			continue
		}
		if strings.Contains(trimmed, call) {
			return true
		}
	}
	return false
}
