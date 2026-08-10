// Package media ports the bounded pure helpers of @hc/media used by the uploads
// service (doc 12): magic-byte type sniffing (never trust the extension),
// storage-quota math, the SSRF guard for server-side URL import, and the folder
// delete-cascade. No I/O.
package media

import (
	"net"
	"regexp"
	"strconv"
	"strings"
)

// Kind is the sniffed media kind.
type Kind string

const (
	KindImage    Kind = "image"
	KindGIF      Kind = "gif"
	KindVector   Kind = "vector"
	KindVideo    Kind = "video"
	KindAudio    Kind = "audio"
	KindFont     Kind = "font"
	KindModel3D  Kind = "model3d"
	KindDocument Kind = "document"
	KindSource   Kind = "source"
)

// SniffResult is the identified type.
type SniffResult struct {
	Mime string
	Kind Kind
}

func matches(b []byte, sig ...byte) bool {
	if len(b) < len(sig) {
		return false
	}
	for i, s := range sig {
		if b[i] != s {
			return false
		}
	}
	return true
}

func asciiAt(b []byte, offset int, text string) bool {
	if len(b) < offset+len(text) {
		return false
	}
	return string(b[offset:offset+len(text)]) == text
}

func leadingText(b []byte, max int) string {
	if len(b) < max {
		max = len(b)
	}
	return string(b[:max])
}

// SniffType identifies a file from its leading bytes (doc 12 FR-3). Returns nil
// for an unrecognized/unsupported type.
func SniffType(b []byte) *SniffResult {
	switch {
	case matches(b, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a):
		return &SniffResult{"image/png", KindImage}
	case matches(b, 0xff, 0xd8, 0xff):
		return &SniffResult{"image/jpeg", KindImage}
	case matches(b, 0x47, 0x49, 0x46, 0x38):
		return &SniffResult{"image/gif", KindGIF}
	case matches(b, 0x42, 0x4d):
		return &SniffResult{"image/bmp", KindImage}
	case matches(b, 0x49, 0x49, 0x2a, 0x00) || matches(b, 0x4d, 0x4d, 0x00, 0x2a):
		return &SniffResult{"image/tiff", KindImage}
	}
	if asciiAt(b, 0, "RIFF") && asciiAt(b, 8, "WEBP") {
		return &SniffResult{"image/webp", KindImage}
	}
	if asciiAt(b, 4, "ftyp") {
		brand := ""
		if len(b) >= 12 {
			brand = string(b[8:12])
		}
		switch brand {
		case "heic", "heif", "mif1", "hevc":
			return &SniffResult{"image/heic", KindImage}
		case "avif":
			return &SniffResult{"image/avif", KindImage}
		}
		return &SniffResult{"video/mp4", KindVideo}
	}
	head := strings.TrimLeft(leadingText(b, 512), " \t\r\n")
	if (strings.HasPrefix(head, "<?xml") && strings.Contains(head, "<svg")) || strings.HasPrefix(head, "<svg") {
		return &SniffResult{"image/svg+xml", KindVector}
	}
	switch {
	case asciiAt(b, 0, "%PDF"):
		return &SniffResult{"application/pdf", KindDocument}
	case matches(b, 0x1a, 0x45, 0xdf, 0xa3):
		return &SniffResult{"video/webm", KindVideo}
	case asciiAt(b, 0, "OggS"):
		return &SniffResult{"audio/ogg", KindAudio}
	}
	if asciiAt(b, 0, "RIFF") && asciiAt(b, 8, "WAVE") {
		return &SniffResult{"audio/wav", KindAudio}
	}
	switch {
	case matches(b, 0x49, 0x44, 0x33) || matches(b, 0xff, 0xfb) || matches(b, 0xff, 0xf3):
		return &SniffResult{"audio/mpeg", KindAudio}
	case matches(b, 0x4f, 0x54, 0x54, 0x4f):
		return &SniffResult{"font/otf", KindFont}
	case matches(b, 0x00, 0x01, 0x00, 0x00) || asciiAt(b, 0, "true"):
		return &SniffResult{"font/ttf", KindFont}
	case asciiAt(b, 0, "wOFF"):
		return &SniffResult{"font/woff", KindFont}
	case asciiAt(b, 0, "wOF2"):
		return &SniffResult{"font/woff2", KindFont}
	case asciiAt(b, 0, "glTF"):
		return &SniffResult{"model/gltf-binary", KindModel3D}
	case asciiAt(b, 0, "8BPS"):
		return &SniffResult{"image/vnd.adobe.photoshop", KindSource}
	case matches(b, 0x50, 0x4b, 0x03, 0x04) || matches(b, 0x50, 0x4b, 0x05, 0x06):
		return &SniffResult{"application/zip", KindDocument}
	}
	return nil
}

// AcceptResult is the validated upload type (FR-3).
type AcceptResult struct {
	OK     bool
	Mime   string
	Kind   Kind
	Reason string
}

// AcceptUpload validates an upload by sniffing its content (FR-3).
func AcceptUpload(b []byte) AcceptResult {
	s := SniffType(b)
	if s == nil {
		return AcceptResult{OK: false, Reason: "unsupported or unrecognized file type"}
	}
	return AcceptResult{OK: true, Mime: s.Mime, Kind: s.Kind}
}

// CanUpload reports whether byteSize more bytes fit within quota (FR-11). A
// quota <= 0 means unlimited.
func CanUpload(usedBytes, quotaBytes, byteSize int64) bool {
	if quotaBytes <= 0 {
		return true
	}
	return usedBytes+byteSize <= quotaBytes
}

// --- SSRF guard ----------------------------------------------------------

// ParsedURL is the scheme + host of an import URL.
type ParsedURL struct {
	Scheme string
	Host   string
	Port   int
}

var urlRe = regexp.MustCompile(`^([a-zA-Z][a-zA-Z0-9+.-]*)://([^/?#]+)`)

// ParseURL extracts scheme + host from a URL, or nil if not absolute.
func ParseURL(raw string) *ParsedURL {
	m := urlRe.FindStringSubmatch(strings.TrimSpace(raw))
	if m == nil {
		return nil
	}
	scheme := strings.ToLower(m[1])
	authority := m[2]
	if at := strings.LastIndex(authority, "@"); at >= 0 {
		authority = authority[at+1:]
	}
	var host string
	var port int
	if strings.HasPrefix(authority, "[") {
		close := strings.Index(authority, "]")
		if close < 0 {
			return nil
		}
		host = authority[1:close]
		rest := authority[close+1:]
		if strings.HasPrefix(rest, ":") {
			port, _ = strconv.Atoi(rest[1:])
		}
	} else if colon := strings.Index(authority, ":"); colon >= 0 {
		host = authority[:colon]
		port, _ = strconv.Atoi(authority[colon+1:])
	} else {
		host = authority
	}
	return &ParsedURL{Scheme: scheme, Host: strings.ToLower(host), Port: port}
}

var ipv4Re = regexp.MustCompile(`^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$`)

func ipv4Parts(host string) []int {
	m := ipv4Re.FindStringSubmatch(host)
	if m == nil {
		return nil
	}
	parts := make([]int, 4)
	for i := 0; i < 4; i++ {
		n, _ := strconv.Atoi(m[i+1])
		if n < 0 || n > 255 {
			return nil
		}
		parts[i] = n
	}
	return parts
}

// IsPrivateIP reports whether an IP literal (v4/v6) is private, loopback,
// link-local, or reserved. IPv6 forms that carry an IPv4 address inside them
// are judged by the address they actually reach, not by how they are written.
// A hostname is not an address and always reports false; callers that accept
// one must resolve it and re-check every address it answers with.
func IsPrivateIP(host string) bool {
	if v4 := ipv4Parts(host); v4 != nil {
		a, b := v4[0], v4[1]
		switch {
		case a == 10, a == 127, a == 0:
			return true
		case a == 169 && b == 254:
			return true
		case a == 172 && b >= 16 && b <= 31:
			return true
		case a == 192 && b == 168:
			return true
		case a == 100 && b >= 64 && b <= 127:
			return true
		case a >= 224:
			return true
		}
		return false
	}
	if strings.Contains(host, ":") {
		h := strings.Trim(host, "[]")
		if h == "::1" || h == "::" {
			return true
		}
		lead := strings.ToLower(h)
		if strings.HasPrefix(lead, "fe8") || strings.HasPrefix(lead, "fe9") || strings.HasPrefix(lead, "fea") || strings.HasPrefix(lead, "feb") {
			return true
		}
		if strings.HasPrefix(lead, "fc") || strings.HasPrefix(lead, "fd") {
			return true
		}
		if strings.HasPrefix(lead, "::ffff:") {
			mapped := lead[7:]
			if ipv4Parts(mapped) != nil {
				return IsPrivateIP(mapped)
			}
			// A v4-mapped address written in HEX ("::ffff:7f00:1") reaches the
			// same host as the dotted form but has no dotted quad to hand back,
			// so it falls through to the decoder below rather than being waved
			// past as unrecognized.
		}
		return embeddedV4IsPrivate(h)
	}
	return false
}

// embeddedV4IsPrivate judges the IPv6 forms that CARRY an IPv4 address inside
// them. Every check above reads these as ordinary global unicast, but a host
// with NAT64/DNS64 or 6to4 configured - the norm on IPv6-only networks - has
// the stack translate them into a real IPv4 connection, so "64:ff9b::7f00:1"
// reaches 127.0.0.1 and "2002:7f00:1::" reaches it via a 6to4 relay. Judge the
// address the connection actually lands on, not the one it is written as.
//
// Refusing more can only ever cost a fetch that should not have been made:
// these are translation and transition ranges, not addresses a public asset or
// page is served from.
func embeddedV4IsPrivate(h string) bool {
	ip := net.ParseIP(h)
	if ip == nil {
		return false // a hostname, not an address; the callers resolve those
	}
	// v4-mapped ("::ffff:7f00:1"): judge the IPv4 it actually reaches.
	if v4 := ip.To4(); v4 != nil {
		return IsPrivateIP(v4.String())
	}
	b := ip.To16()
	if b == nil {
		return false
	}
	switch {
	// 64:ff9b::/32 covers the RFC 6052 well-known prefix and the RFC 8215
	// local-use range. Where the IPv4 sits depends on the prefix length, so
	// rather than decode every embedding, refuse the block outright.
	case b[0] == 0x00 && b[1] == 0x64 && b[2] == 0xff && b[3] == 0x9b:
		return true
	// 2002::/16 (6to4): the IPv4 is bytes 2-5, by definition.
	case b[0] == 0x20 && b[1] == 0x02:
		return IsPrivateIP(net.IP(b[2:6]).String())
	// ::/96 (deprecated IPv4-compatible): the IPv4 is the low 32 bits. "::" and
	// "::1" are already refused above; this catches the rest, e.g. "::7f00:1".
	case allZero(b[:12]):
		return IsPrivateIP(net.IP(b[12:16]).String())
	}
	return false
}

func allZero(b []byte) bool {
	for _, c := range b {
		if c != 0 {
			return false
		}
	}
	return true
}

// URLValidation is the result of validating an import URL.
type URLValidation struct {
	OK     bool
	Reason string
	Parsed *ParsedURL
}

var blockedHostnames = map[string]bool{"localhost": true, "ip6-localhost": true, "ip6-loopback": true}

// ValidateImportURL validates an import URL against the SSRF policy (FR-12). It
// checks the literal authority only; the caller must re-check resolved IPs.
func ValidateImportURL(raw string) URLValidation {
	p := ParseURL(raw)
	if p == nil {
		return URLValidation{OK: false, Reason: "invalid or non-absolute URL"}
	}
	if p.Scheme != "http" && p.Scheme != "https" {
		return URLValidation{OK: false, Reason: "scheme not allowed: " + p.Scheme, Parsed: p}
	}
	if p.Host == "" {
		return URLValidation{OK: false, Reason: "empty host", Parsed: p}
	}
	if blockedHostnames[p.Host] || strings.HasSuffix(p.Host, ".localhost") || strings.HasSuffix(p.Host, ".local") {
		return URLValidation{OK: false, Reason: "loopback/local hostname blocked", Parsed: p}
	}
	if IsPrivateIP(p.Host) {
		return URLValidation{OK: false, Reason: "private or reserved IP blocked", Parsed: p}
	}
	return URLValidation{OK: true, Parsed: p}
}

// --- folder delete cascade -----------------------------------------------

// FolderLite is the minimal folder shape the cascade needs.
type FolderLite struct {
	ID       string
	ParentID *string
}

// DescendantIDs returns folderID and all of its descendant folder ids.
func DescendantIDs(folders []FolderLite, folderID string) []string {
	childrenOf := map[string][]string{}
	for _, f := range folders {
		if f.ParentID != nil {
			childrenOf[*f.ParentID] = append(childrenOf[*f.ParentID], f.ID)
		}
	}
	var out []string
	stack := []string{folderID}
	for len(stack) > 0 {
		id := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		out = append(out, id)
		stack = append(stack, childrenOf[id]...)
	}
	return out
}

// DeleteCascade is the set of folders to delete + assets to reparent to root.
type DeleteCascade struct {
	FolderIDs []string
	AssetIDs  []string
}

// AssetLite is the minimal asset shape the cascade needs.
type AssetLite struct {
	ID       string
	FolderID *string
}

// FolderDeleteCascade computes the folders to delete (the subtree) and the
// assets in them to reparent to root (FR-8).
func FolderDeleteCascade(folders []FolderLite, folderID string, assets []AssetLite) DeleteCascade {
	ids := DescendantIDs(folders, folderID)
	set := map[string]bool{}
	for _, id := range ids {
		set[id] = true
	}
	var assetIDs []string
	for _, a := range assets {
		if a.FolderID != nil && set[*a.FolderID] {
			assetIDs = append(assetIDs, a.ID)
		}
	}
	return DeleteCascade{FolderIDs: ids, AssetIDs: assetIDs}
}
