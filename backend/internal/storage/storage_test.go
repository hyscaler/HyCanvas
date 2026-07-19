package storage

import (
	"path/filepath"
	"testing"
)

// The Local driver must confine every key under its base directory: absolute,
// empty, and '..'-traversal keys are rejected before any filesystem access,
// while ordinary relative keys resolve to a path inside the base.
func TestLocalPathFor(t *testing.T) {
	base := t.TempDir()
	l, err := NewLocal(base)
	if err != nil {
		t.Fatalf("NewLocal: %v", err)
	}

	bad := []string{"", "/absolute", "a/../../etc/passwd", "..", "../x", "x/../../../y", "/etc/passwd"}
	for _, k := range bad {
		if _, err := l.pathFor(k); err == nil {
			t.Errorf("pathFor(%q) should error", k)
		}
	}

	good := []string{"designs/a/snap.ocd", "assets/ws-1/uuid.png", "single", "a/b/c/d"}
	for _, k := range good {
		full, err := l.pathFor(k)
		if err != nil {
			t.Errorf("pathFor(%q) unexpected error: %v", k, err)
			continue
		}
		if full != filepath.Join(l.base, k) {
			t.Errorf("pathFor(%q) = %q; want %q", k, full, filepath.Join(l.base, k))
		}
	}
}
