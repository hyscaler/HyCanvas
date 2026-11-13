package storage

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A local storage directory the server cannot write must stop it at boot with
// the fix in the message, not surface later as every upload failing. The usual
// cause is a volume created by an image that ran as root, mounted into one
// that does not.
func TestNewFromEnvRefusesUnwritableLocalStorage(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes through directory permissions")
	}
	dir := filepath.Join(t.TempDir(), "storage")
	if err := os.Mkdir(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
	t.Setenv("STORAGE_DRIVER", "local")
	t.Setenv("LOCAL_STORAGE_PATH", dir)

	_, err := NewFromEnv()
	if err == nil {
		t.Fatal("expected an error for a read-only storage directory")
	}
	for _, want := range []string{"not writable", dir, "chown"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q lacks %q", err, want)
		}
	}
}

// The control: a writable directory (including one that does not exist yet)
// boots, and the probe leaves nothing behind.
func TestNewFromEnvAcceptsWritableLocalStorage(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "fresh", "storage")
	t.Setenv("STORAGE_DRIVER", "local")
	t.Setenv("LOCAL_STORAGE_PATH", dir)

	d, err := NewFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if d.Kind() != "local" {
		t.Fatalf("driver = %q, want local", d.Kind())
	}
	left, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(left) != 0 {
		t.Fatalf("probe left files behind: %v", left)
	}
}
