//go:build !embed

// Stub used by every build that omits the `embed` tag: development (`go run`),
// `go test`, `go vet`, and the plain `npm run build:backend` binary. No frontend
// is baked in, so HasContent() is false and the server falls back to PUBLIC_DIR
// (or serves API-only). Because this file - not webui_embed.go - is compiled
// without the tag, a `public/` directory need not exist in a source checkout.
package webui

import "io/fs"

// FS returns nil: nothing is embedded in a non-embed build.
func FS() fs.FS { return nil }

// HasContent is always false without the embed tag.
func HasContent() bool { return false }
