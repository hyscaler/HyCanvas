package httpapi

import (
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
)

// Precompressed static assets.
//
// The production build (scripts/precompress-static.js, run after the frontend
// export) writes `<file>.br` and `<file>.gz` siblings next to every text asset
// worth compressing. The static server picks the best sibling the client
// accepts and serves it with Content-Encoding, keeping the original
// Content-Type and cache headers. Compressing once at build time (brotli at its
// maximum quality, which is far too slow to run per request) costs nothing at
// serve time and needs no cache; the trade is a larger binary.
//
// Any request that cannot use a sibling (no Accept-Encoding, an identity-only
// client, a file below the size threshold, a missing sibling) gets the original
// file exactly as before.

// precompressedEncodings lists the sibling encodings in server preference
// order: brotli is smaller, gzip is the universal fallback.
var precompressedEncodings = []struct{ token, ext string }{
	{"br", ".br"},
	{"gzip", ".gz"},
}

// compressibleTypes are the extensions the build precompresses. Keep in sync
// with COMPRESSIBLE in scripts/precompress-static.js.
var compressibleTypes = map[string]bool{
	".js": true, ".mjs": true, ".css": true, ".html": true, ".json": true,
	".svg": true, ".webmanifest": true, ".txt": true, ".xml": true,
}

// acceptsEncoding parses an Accept-Encoding header and reports whether token is
// acceptable (q > 0). An explicit entry wins over the `*` wildcard; `q=0`
// refuses. Malformed q values count as refusals, the cautious reading.
func acceptsEncoding(header, token string) bool {
	explicit, wildcard := -1.0, -1.0
	for _, part := range strings.Split(header, ",") {
		name, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		name = strings.ToLower(strings.TrimSpace(name))
		if name == "" {
			continue
		}
		q := 1.0
		for _, p := range strings.Split(params, ";") {
			k, v, ok := strings.Cut(strings.TrimSpace(p), "=")
			if !ok || strings.ToLower(strings.TrimSpace(k)) != "q" {
				continue
			}
			f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
			if err != nil || f < 0 || f > 1 {
				f = 0
			}
			q = f
		}
		switch name {
		case token:
			explicit = q
		case "*":
			wildcard = q
		}
	}
	if explicit >= 0 {
		return explicit > 0
	}
	return wildcard > 0
}

// serveContentType is the Content-Type the original file would be served with.
// An unknown extension returns "", and such files are never served compressed
// (ServeContent would otherwise sniff the compressed bytes).
func serveContentType(name string) string {
	ext := strings.ToLower(path.Ext(name))
	if !compressibleTypes[ext] {
		return ""
	}
	return mime.TypeByExtension(ext)
}

// servePrecompressed serves the best precompressed sibling of name for the
// request, returning false (having written nothing) when none applies so the
// caller serves the original. Vary is set for every compressible asset, sibling
// or not, so a shared cache never hands a compressed body to a client that did
// not ask for it.
func servePrecompressed(w http.ResponseWriter, req *http.Request, root http.FileSystem, name string) bool {
	ctype := serveContentType(name)
	if ctype == "" {
		return false
	}
	w.Header().Add("Vary", "Accept-Encoding")
	accept := req.Header.Get("Accept-Encoding")
	// Range requests get the original bytes: byte ranges of a compressed body
	// are useless to the resumable downloaders and media players that send
	// them, and identity ranges keep working exactly as before.
	if accept == "" || req.Header.Get("Range") != "" {
		return false
	}
	for _, enc := range precompressedEncodings {
		if !acceptsEncoding(accept, enc.token) {
			continue
		}
		f, err := root.Open(name + enc.ext)
		if err != nil {
			continue
		}
		info, err := f.Stat()
		if err != nil || info.IsDir() {
			f.Close()
			continue
		}
		defer f.Close()
		w.Header().Set("Content-Type", ctype)
		w.Header().Set("Content-Encoding", enc.token)
		// ServeContent omits Content-Length once Content-Encoding is set (it
		// assumes a body compressed on the fly), so state the sibling's size
		// here: HEAD and GET then report the exact encoded length. No Range
		// reaches this point, so the response is always the whole body (or a
		// bodiless 304, which drops the header).
		w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
		http.ServeContent(w, req, name, info.ModTime(), f)
		return true
	}
	return false
}
