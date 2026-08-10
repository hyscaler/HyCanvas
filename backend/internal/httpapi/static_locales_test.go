package httpapi

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
)

// A translator's contribution is a single JSON file. The production packaging
// bakes the frontend into the binary, so unless a directory on disk WINS over
// the embedded copy, adding a language means recompiling the product. These
// pin that behaviour.
func TestLocalesDirOverridesEmbedded(t *testing.T) {
	embedded := http.FS(fstest.MapFS{
		"locales/fr.json": {Data: []byte(`{"a":"embedded"}`)},
		"index.html":      {Data: []byte("<html></html>")},
	})

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "fr.json"), []byte(`{"a":"from disk"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "ar.json"), []byte(`{"a":"new language"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	fs := withLocalesDir(embedded, dir)
	read := func(name string) string {
		f, err := fs.Open(name)
		if err != nil {
			t.Fatalf("open %s: %v", name, err)
		}
		defer f.Close()
		b, err := io.ReadAll(f)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}

	if got := read("/locales/fr.json"); got != `{"a":"from disk"}` {
		t.Errorf("the on-disk translation did not win: %s", got)
	}
	// A language the build never shipped must be reachable.
	if got := read("/locales/ar.json"); got != `{"a":"new language"}` {
		t.Errorf("a newly added language was not served: %s", got)
	}
	// Everything else still comes from the binary.
	if got := read("/index.html"); got != "<html></html>" {
		t.Errorf("the overlay leaked outside /locales: %s", got)
	}
}

func TestLocalesOverlayFallsBackAndStaysScoped(t *testing.T) {
	embedded := http.FS(fstest.MapFS{
		"locales/fr.json": {Data: []byte(`{"a":"embedded"}`)},
		"secret.txt":      {Data: []byte("embedded secret")},
	})
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "secret.txt"), []byte("disk secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	fs := withLocalesDir(embedded, dir)

	// No fr.json on disk here, so the embedded one is still served.
	f, err := fs.Open("/locales/fr.json")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(f)
	f.Close()
	if string(b) != `{"a":"embedded"}` {
		t.Errorf("fallback to the embedded catalog failed: %s", b)
	}

	// The overlay is scoped to /locales and to .json, so it cannot shadow the app.
	f2, err := fs.Open("/secret.txt")
	if err != nil {
		t.Fatal(err)
	}
	b2, _ := io.ReadAll(f2)
	f2.Close()
	if string(b2) != "embedded secret" {
		t.Errorf("the overlay served a file outside /locales: %s", b2)
	}

	// A traversal attempt must never reach the on-disk directory. Clean()
	// collapses it to /secret.txt, which is outside the prefix, so it falls
	// through to the embedded copy.
	f3, err := fs.Open("/locales/../secret.txt")
	if err != nil {
		return // refusing outright is also correct
	}
	b3, _ := io.ReadAll(f3)
	f3.Close()
	if string(b3) != "embedded secret" {
		t.Errorf("traversal escaped into the locales directory: %s", b3)
	}
}

func TestWithLocalesDirIgnoresAMissingDirectory(t *testing.T) {
	embedded := http.FS(fstest.MapFS{"locales/fr.json": {Data: []byte(`{"a":"embedded"}`)}})
	// Asserted by behaviour rather than identity: an unconfigured or missing
	// directory must leave the embedded catalog serving exactly as before.
	for name, dir := range map[string]string{
		"unset":   "",
		"missing": filepath.Join(t.TempDir(), "nope"),
	} {
		f, err := withLocalesDir(embedded, dir).Open("/locales/fr.json")
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		b, _ := io.ReadAll(f)
		f.Close()
		if string(b) != `{"a":"embedded"}` {
			t.Errorf("%s: embedded catalog not served: %s", name, b)
		}
	}
}
