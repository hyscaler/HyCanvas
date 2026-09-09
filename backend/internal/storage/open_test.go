// Serving an asset used to buffer the WHOLE object per request. A <video>
// element issues many Range requests while loading and seeking, so a 300 MB
// upload re-downloaded 300 MB every time; on S3 that ran past the 30s
// per-operation timeout and the read failed, which surfaced to the user as a
// video that would not play at all. Small videos stayed fine, which made the
// failure look size-dependent rather than like the buffering bug it was.
//
// Open is the fix: a seekable reader that fetches only what is read.
package storage

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLocalOpenReportsSizeAndSeeks(t *testing.T) {
	l, err := NewLocal(t.TempDir())
	if err != nil {
		t.Fatalf("NewLocal: %v", err)
	}
	body := []byte("0123456789abcdefghij")
	if _, err := l.Put("media/clip.bin", body); err != nil {
		t.Fatalf("Put: %v", err)
	}

	rc, size, err := l.Open("media/clip.bin")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = rc.Close() }()
	if size != int64(len(body)) {
		t.Fatalf("size = %d, want %d", size, len(body))
	}

	// Seeking then reading must return only that slice: this is what lets the
	// server answer a Range without touching the rest of the object.
	if _, err := rc.Seek(10, io.SeekStart); err != nil {
		t.Fatalf("Seek: %v", err)
	}
	got := make([]byte, 5)
	if _, err := io.ReadFull(rc, got); err != nil {
		t.Fatalf("ReadFull: %v", err)
	}
	if string(got) != "abcde" {
		t.Fatalf("range read = %q, want %q", got, "abcde")
	}
}

// A missing key is (nil, 0, nil), not an error, so callers can tell "no such
// object" apart from "storage is broken". Conflating those is what made a
// timed-out S3 read report itself as a 404.
func TestLocalOpenMissingKeyIsNotAnError(t *testing.T) {
	l, err := NewLocal(t.TempDir())
	if err != nil {
		t.Fatalf("NewLocal: %v", err)
	}
	rc, size, err := l.Open("media/absent.bin")
	if err != nil {
		t.Fatalf("Open of a missing key returned an error: %v", err)
	}
	if rc != nil || size != 0 {
		t.Fatalf("Open of a missing key = (%v, %d), want (nil, 0)", rc, size)
	}
}

// The end behavior the video editor depends on: an HTTP Range served straight
// off the driver yields 206 and exactly the requested bytes.
func TestOpenServesHTTPByteRange(t *testing.T) {
	l, err := NewLocal(t.TempDir())
	if err != nil {
		t.Fatalf("NewLocal: %v", err)
	}
	body := []byte("0123456789abcdefghij")
	if _, err := l.Put("media/clip.bin", body); err != nil {
		t.Fatalf("Put: %v", err)
	}

	srv := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rc, _, err := l.Open("media/clip.bin")
		if err != nil || rc == nil {
			t.Errorf("Open in handler: rc=%v err=%v", rc, err)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		defer func() { _ = rc.Close() }()
		http.ServeContent(w, r, "", time.Time{}, rc)
	})

	req := httptest.NewRequest(http.MethodGet, "/media/clip.bin", nil)
	req.Header.Set("Range", "bytes=10-14")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusPartialContent {
		t.Fatalf("status = %d, want %d (a non-206 means the browser treats the media as unseekable)", rec.Code, http.StatusPartialContent)
	}
	if rec.Body.String() != "abcde" {
		t.Fatalf("body = %q, want %q", rec.Body.String(), "abcde")
	}
	if cr := rec.Header().Get("Content-Range"); cr != "bytes 10-14/20" {
		t.Fatalf("Content-Range = %q, want %q", cr, "bytes 10-14/20")
	}
}

// CodeQL flags os.ReadFile/os.Open in this driver as path injection because it
// cannot see pathFor as a sanitizer: the decisive check is a string comparison
// on the RESOLVED path, which its dataflow does not model. pathFor is covered
// directly by TestLocalPathFor; this exercises the same hostile keys through
// the public methods, so the guarantee is pinned at the boundary an attacker
// would actually reach rather than at an unexported helper.
func TestLocalReadMethodsRefuseTraversal(t *testing.T) {
	base := t.TempDir()
	l, err := NewLocal(base)
	if err != nil {
		t.Fatalf("NewLocal: %v", err)
	}
	// A file that exists OUTSIDE the base, i.e. what a traversal would target.
	outside := filepath.Join(filepath.Dir(base), "outside-the-base.txt")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	defer func() { _ = os.Remove(outside) }()

	hostile := []string{
		"",
		"..",
		"../x",
		"../" + filepath.Base(outside),
		"a/../../etc/passwd",
		"x/../../../y",
		"/etc/passwd",
		"/absolute",
	}
	for _, key := range hostile {
		t.Run("Get "+key, func(t *testing.T) {
			b, err := l.Get(key)
			if err == nil {
				t.Fatalf("Get(%q) returned no error (read %d bytes); a traversal key must be refused", key, len(b))
			}
		})
		t.Run("Open "+key, func(t *testing.T) {
			rc, _, err := l.Open(key)
			if err == nil {
				if rc != nil {
					_ = rc.Close()
				}
				t.Fatalf("Open(%q) returned no error; a traversal key must be refused", key)
			}
		})
	}
}
