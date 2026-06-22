//go:build embed

// Package webui embeds the statically-exported Next.js frontend into the Go
// binary so production ships as a single self-contained file: one binary serves
// the UI, the REST API, and the realtime WebSocket on one port, with no Node
// runtime and no sidecar `public/` folder.
//
// The embed is gated behind the `embed` build tag (compile-time), matching the
// pattern used across our Go services. Production builds stage the frontend
// export into `public/` and compile with `-tags embed` (scripts/build-dist and
// the Dockerfile). Dev builds, `go test`, and `go vet` omit the tag, compile the
// stub in webui_stub.go instead, and never need a `public/` directory to exist,
// so there is no committed placeholder. When the UI is not embedded the server
// falls back to PUBLIC_DIR (or serves API-only).
package webui

import (
	"embed"
	"io/fs"
)

// `all:` is required so Next's `/_next/*` assets (an underscore-prefixed dir,
// which a bare //go:embed would skip) and any dotfiles are included.
//
//go:embed all:public
var embedded embed.FS

// FS returns the embedded frontend rooted at the export's top level (so "/index.html",
// "/_next/...", etc. resolve), or nil if it can't be sub-rooted.
func FS() fs.FS {
	sub, err := fs.Sub(embedded, "public")
	if err != nil {
		return nil
	}
	return sub
}

// HasContent reports whether a frontend export was embedded. With the build tag,
// production always stages a real export into `public/`, so this is true; the
// directory-scan keeps it honest if an empty `public/` is ever embedded.
func HasContent() bool {
	entries, err := fs.ReadDir(embedded, "public")
	return err == nil && len(entries) > 0
}
